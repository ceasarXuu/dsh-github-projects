/**
 * Host half of the `github-projects` DSH plugin (contract §3).
 *
 * One Cordis plugin that:
 * - registers a single prefix route `/plugin/github-projects` on the
 *   composition's `webServer` (owned by `ctx.effect`, removed on unload);
 * - serves the eight JSON endpoints of contract §3.1 from `github.js` reads,
 *   with a small in-memory TTL cache + single-flight so one tab switch does
 *   not spawn duplicate `gh` calls;
 * - persists workspace → Project and session → Issue bindings via `state.js`.
 *
 * It is read-only against GitHub, has no npm dependencies, never logs tokens
 * or issue bodies, and answers every failure as
 * `{"error":{"code","message"}}` with a contract status code. The handler owns
 * the full `node:http` request/response; `webServer` matches the prefix and
 * passes the *unstripped* pathname, which this module tolerates either way.
 *
 * `config` may be absent or partial (bare `--patch` overlay): defaults live in
 * `resolveConfig`, not in a Schemastery schema.
 */

import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { createStateStore, STATE_WRITE_FAILED } from './state.js'
import {
  GhError,
  boundedInt,
  createGh,
  parseIssueRef,
  parseOwnerParam,
  parsePositiveInt,
  parseRepoParam,
  toIssueSummary,
} from './github.js'

/* ------------------------------------------------------------------ */
/* 1. Fixed wire facts.                                                */
/* ------------------------------------------------------------------ */

/** Cordis function-plugin name (contract §3). */
export const name = 'github-projects'

/**
 * Cordis waits for this carrier service before running `apply`.
 *
 * `--patch` overlay rows and bundle rows activate in file order; a row placed
 * before the `webserver` plugin would otherwise see `ctx.get('webServer')`
 * undefined and mount no route (CONTRACT.md §3 mandates this declaration).
 * The defensive check in `apply` still keeps direct fake-ctx calls inert.
 */
export const inject = ['webServer']

/** The one prefix route registered on the local HTTP server. */
export const ROUTE_PATH = '/plugin/github-projects'

/** POST bodies above this many bytes are rejected with 413. */
const MAX_BODY_BYTES = 64 * 1024

/** Error code → HTTP status (contract §3.1). */
const STATUS_BY_ERROR_CODE = new Map([
  ['bad-request', 400],
  ['not-found', 404],
  ['issue-not-found', 404],
  ['project-not-found', 404],
  ['gh-missing', 503],
  ['gh-auth', 503],
  ['gh-failed', 502],
  ['timeout', 504],
  ['state-write-failed', 500],
  ['internal', 500],
])

const GET_ROUTES = new Set(['/health', '/config', '/projects', '/items', '/issue'])
const POST_ROUTES = new Set(['/bind-workspace', '/unbind-workspace', '/bind-issue', '/unbind-issue'])

/** Any percent character not starting a two-digit escape makes the URL invalid. */
const MALFORMED_PERCENT_PATTERN = /%(?![0-9a-fA-F]{2})/u

/* ------------------------------------------------------------------ */
/* 2. Config resolution (defaults live in code).                       */
/* ------------------------------------------------------------------ */

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

/**
 * Resolve the row config into closed settings with defaults for every field
 * (contract §3: config may be absent/partial).
 */
export function resolveConfig(raw) {
  const config = isRecord(raw) ? raw : {}
  const declaredStatePath = typeof config.statePath === 'string' && config.statePath.trim() !== ''
    ? expandHome(config.statePath.trim())
    : null
  const statePath = declaredStatePath !== null
    ? resolvePath(declaredStatePath)
    : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'plugin-data', 'github-projects', 'state.json')
  return {
    ghCommand: typeof config.ghCommand === 'string' && config.ghCommand.trim() !== ''
      ? config.ghCommand.trim()
      : 'gh',
    requestTimeoutMs: boundedInt(config.requestTimeoutMs, 1_000, 600_000, 20_000),
    cacheTtlMs: boundedInt(config.cacheTtlMs, 0, 24 * 60 * 60 * 1000, 60_000),
    maxProjectItems: boundedInt(config.maxProjectItems, 1, 1_000, 200),
    maxComments: boundedInt(config.maxComments, 1, 100, 30),
    healthCacheTtlMs: boundedInt(config.healthCacheTtlMs, 0, 60_000, 5_000),
    healthFirstReadTimeoutMs: boundedInt(config.healthFirstReadTimeoutMs, 0, 60_000, 3_000),
    statePath,
    // Test seam: the same injectable runner `github.js` accepts.
    run: typeof config.run === 'function' ? config.run : undefined,
  }
}

/* ------------------------------------------------------------------ */
/* 3. Small HTTP primitives.                                           */
/* ------------------------------------------------------------------ */

class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

function badRequest(message) {
  return new HttpError(400, 'bad-request', message)
}

function errorEnvelope(code, message) {
  return { error: { code, message } }
}

/** Map any thrown value onto its contract status + envelope. */
function toErrorResponse(error) {
  if (error instanceof HttpError) {
    return { status: error.status, payload: errorEnvelope(error.code, error.message) }
  }
  if (error instanceof GhError) {
    const status = STATUS_BY_ERROR_CODE.get(error.code) ?? 500
    return { status, payload: errorEnvelope(error.code, error.message) }
  }
  if (error !== null && typeof error === 'object' && error.code === STATE_WRITE_FAILED) {
    return {
      status: 500,
      payload: errorEnvelope('state-write-failed', '绑定状态保存失败，请检查插件数据目录的写入权限'),
    }
  }
  return { status: 500, payload: errorEnvelope('internal', '服务器内部错误') }
}

/** Send one JSON response with the contract headers; safe on dead responses. */
function sendJson(res, status, payload) {
  let body
  try {
    body = JSON.stringify(payload)
  } catch {
    body = JSON.stringify(errorEnvelope('internal', '响应序列化失败'))
    status = 500
  }
  try {
    if (res.headersSent === true) {
      res.end()
      return
    }
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch {
    try { res.destroy() } catch { /* response already gone */ }
  }
}

/** Strip this plugin's route prefix when the server did not already do it. */
function routePath(pathname) {
  let path = pathname.length > 1 && pathname.endsWith('/')
    ? pathname.replace(/\/+$/u, '')
    : pathname
  if (path === '') path = '/'
  if (path === ROUTE_PATH) return '/'
  if (path.startsWith(`${ROUTE_PATH}/`)) path = path.slice(ROUTE_PATH.length)
  return path
}

/** `dsh-app://app` or a loopback http(s) origin; a missing Origin is allowed. */
function isAllowedOrigin(origin) {
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol === 'dsh-app:') return url.host === 'app' || url.hostname === 'app'
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
}

/** Browser-origin gate for POSTs (contract §3.1 request gating). */
function checkOrigin(req) {
  const origin = req.headers?.origin
  if (origin === undefined || origin === null || origin === '') return
  if (typeof origin !== 'string') throw new HttpError(403, 'forbidden', '请求来源不被允许')
  if (!isAllowedOrigin(origin)) throw new HttpError(403, 'forbidden', '请求来源不被允许')
}

/** Collect a bounded request body; `null` when it exceeded the cap. */
async function readBoundedBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > limit) {
      try { req.resume?.() } catch { /* stream already drained */ }
      return null
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, size)
}

/** Read + gate + parse one POST body as a JSON object. */
async function readJsonBody(req) {
  const contentType = String(req.headers?.['content-type'] ?? '')
  if (!/^application\/json(?:\s*;.*)?$/iu.test(contentType.trim())) {
    throw new HttpError(415, 'unsupported-media-type', 'Content-Type 必须是 application/json')
  }
  const buffer = await readBoundedBody(req, MAX_BODY_BYTES)
  if (buffer === null) throw new HttpError(413, 'payload-too-large', '请求体超过 64 KiB 上限')
  const text = buffer.toString('utf8')
  if (text.trim().length === 0) throw badRequest('请求体为空')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw badRequest('请求体不是合法 JSON')
  }
  if (!isRecord(parsed)) throw badRequest('请求体必须是 JSON 对象')
  return parsed
}

/* ------------------------------------------------------------------ */
/* 4. Cache + health reader.                                           */
/* ------------------------------------------------------------------ */

/**
 * Tiny TTL cache with single-flight. Concurrent identical loads — including
 * concurrent `refresh=1` loads — share one in-flight read.
 */
function createTtlCache(ttlMs) {
  const entries = new Map()
  const pending = new Map()
  const maxEntries = 256
  const prune = (now) => {
    if (entries.size <= maxEntries) return
    for (const [key, record] of entries) {
      if (ttlMs <= 0 || now - record.fetchedAt >= ttlMs) entries.delete(key)
    }
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value)
  }
  return {
    async get(key, refresh, load) {
      if (refresh !== true) {
        const cached = entries.get(key)
        if (cached !== undefined && ttlMs > 0 && Date.now() - cached.fetchedAt < ttlMs) return cached
      }
      const inflight = pending.get(key)
      if (inflight !== undefined) return inflight
      const promise = (async () => {
        const value = await load()
        const record = { value, fetchedAt: Date.now() }
        if (ttlMs > 0) {
          entries.set(key, record)
          prune(record.fetchedAt)
        }
        return record
      })()
      pending.set(key, promise)
      try {
        return await promise
      } finally {
        if (pending.get(key) === promise) pending.delete(key)
      }
    },
  }
}

/** Answer for the very first `/config` while the first probe is still running. */
const PENDING_GH_HEALTH = Object.freeze({
  available: false,
  version: null,
  account: null,
  error: 'pending',
})

/** Internal sentinel distinguishing "timed out" from a resolved health object. */
const HEALTH_PENDING = Symbol('health-pending')

/**
 * Health reader shared by `/health` and `/config`.
 *
 * - `/health` awaits one probe (concurrent probes share one in-flight read).
 * - `/config` never blocks on a slow or offline `gh` once a baseline exists:
 *   it answers the last known snapshot immediately and refreshes it in the
 *   background. The very first read awaits at most `firstReadTimeoutMs`, then
 *   answers the `{ ..., error: 'pending' }` placeholder while the probe runs on.
 */
function createHealthReader(gh, ttlMs, firstReadTimeoutMs) {
  let record = null
  let pending = null

  const refresh = () => {
    if (pending !== null) return pending
    const promise = Promise.resolve()
      .then(() => gh.health())
      .then((value) => {
        record = { value, fetchedAt: Date.now() }
        return value
      })
    pending = promise
    const settle = () => { if (pending === promise) pending = null }
    promise.then(settle, settle)
    return promise
  }

  const isStale = () => record === null || ttlMs <= 0 || Date.now() - record.fetchedAt >= ttlMs

  return {
    /** `/health`: one awaited probe, fresh unless another probe is in flight. */
    read() {
      return refresh()
    },
    /** `/config`: last snapshot now, background refresh when stale. */
    async peek() {
      if (record !== null) {
        if (isStale()) refresh().catch(() => { /* keep the stale snapshot */ })
        return record.value
      }
      let timer
      const fallback = new Promise((resolve) => {
        timer = setTimeout(() => resolve(HEALTH_PENDING), firstReadTimeoutMs)
        timer.unref?.()
      })
      try {
        const outcome = await Promise.race([refresh().catch(() => HEALTH_PENDING), fallback])
        return outcome === HEALTH_PENDING ? PENDING_GH_HEALTH : outcome
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/* ------------------------------------------------------------------ */
/* 5. Request validation helpers.                                      */
/* ------------------------------------------------------------------ */

/** Query id: missing/invalid answers "unknown id" semantics. */
function optionalId(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text.length === 0 || text.length > 200 ? null : text
}

/** Body id: a missing/invalid id is a 400. */
function requireId(value, field) {
  const text = optionalId(value)
  if (text === null) throw badRequest(`缺少或无效的 ${field}`)
  return text
}

function isRefresh(value) {
  if (typeof value !== 'string') return false
  const text = value.trim().toLowerCase()
  return text === '1' || text === 'true'
}

function isHttpUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_000) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/** Client-provided Project summary → contract `Project` (all fields present). */
function normalizeBindingProject(raw) {
  if (!isRecord(raw)) throw badRequest('缺少 project 对象')
  const owner = parseOwnerParam(raw.owner)
  if (owner === null) throw badRequest('project.owner 无效')
  const number = parsePositiveInt(raw.number)
  if (number === null) throw badRequest('project.number 无效')
  const description = typeof raw.description === 'string' ? raw.description.slice(0, 500) : null
  return {
    owner,
    ownerType: raw.ownerType === 'organization' ? 'organization' : 'user',
    number,
    title: typeof raw.title === 'string' ? raw.title.slice(0, 500) : '',
    url: isHttpUrl(raw.url) ? raw.url.trim() : null,
    itemCount: Number.isInteger(raw.itemCount) && raw.itemCount >= 0 ? raw.itemCount : null,
    closed: raw.closed === true,
    description: description === '' ? null : description,
  }
}

/** Client-provided Issue summary → contract `IssueSummary`. */
function normalizeBindingIssue(raw) {
  if (!isRecord(raw)) throw badRequest('缺少 issue 对象')
  const repo = parseRepoParam(raw.repo)
  if (repo === null) throw badRequest('issue.repo 必须是 owner/name')
  const number = parsePositiveInt(raw.number)
  if (number === null) throw badRequest('issue.number 无效')
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 500) : ''
  const url = isHttpUrl(raw.url) ? raw.url.trim() : null
  const state = typeof raw.state === 'string' && raw.state.trim() !== ''
    ? raw.state.trim().toLowerCase().slice(0, 32)
    : 'open'
  return {
    repo: repo.repo,
    number,
    title,
    url,
    state,
    complete: title !== '' && url !== null,
  }
}

/* ------------------------------------------------------------------ */
/* 6. The HTTP API.                                                    */
/* ------------------------------------------------------------------ */

function createApi({ gh, store, cache, health, logFault }) {
  const iso = (timestamp) => new Date(timestamp).toISOString()

  /* ---- GET handlers (read-only; no GitHub writes) ---- */

  async function readConfig(query) {
    const workspaceId = optionalId(query.get('workspaceId'))
    const sessionId = optionalId(query.get('sessionId'))
    const ghHealth = await health.peek()
    const workspace = workspaceId === null
      ? { workspaceId: '', project: null }
      : store.getWorkspace(workspaceId)
    const storedSession = sessionId === null ? null : store.getSession(sessionId)
    const session = storedSession === null
      ? { sessionId: sessionId ?? '', issue: null, workspaceId: workspaceId ?? null }
      : { ...storedSession, workspaceId: storedSession.workspaceId ?? workspaceId ?? null }
    return { gh: ghHealth, workspace, session }
  }

  async function readProjects(query) {
    const record = await cache.get('projects', isRefresh(query.get('refresh')), () => gh.listProjects())
    const value = record.value
    return {
      owners: Array.isArray(value.owners) ? value.owners : [],
      projects: Array.isArray(value.projects) ? value.projects : [],
      fetchedAt: iso(record.fetchedAt),
      errors: Array.isArray(value.errors) ? value.errors : [],
    }
  }

  async function readItems(query) {
    const owner = parseOwnerParam(query.get('owner'))
    if (owner === null) throw badRequest('owner 参数无效')
    const number = parsePositiveInt(query.get('number'))
    if (number === null) throw badRequest('number 参数无效')
    const record = await cache.get(
      `items:${owner}/${number}`,
      isRefresh(query.get('refresh')),
      () => gh.projectItems(owner, number),
    )
    return {
      project: record.value.project,
      items: record.value.items,
      fetchedAt: iso(record.fetchedAt),
      truncated: record.value.truncated === true,
    }
  }

  async function readIssue(query) {
    const repo = parseRepoParam(query.get('repo'))
    if (repo === null) throw badRequest('repo 参数必须是 owner/name')
    const number = parsePositiveInt(query.get('number'))
    if (number === null) throw badRequest('number 参数无效')
    const record = await cache.get(
      `issue:${repo.repo}#${number}`,
      isRefresh(query.get('refresh')),
      () => gh.getIssue(repo.repo, number),
    )
    return { issue: record.value.issue, fetchedAt: iso(record.fetchedAt) }
  }

  /* ---- POST handlers ---- */

  async function bindWorkspaceRequest(body) {
    const workspaceId = requireId(body.workspaceId, 'workspaceId')
    const project = normalizeBindingProject(body.project)
    const workspace = await store.bindWorkspace(workspaceId, project)
    return { ok: true, workspace }
  }

  async function unbindWorkspaceRequest(body) {
    const workspaceId = requireId(body.workspaceId, 'workspaceId')
    await store.unbindWorkspace(workspaceId)
    return { ok: true }
  }

  /**
   * `POST /bind-issue` accepts a summary or a pasted reference. A summary
   * with a title and URL is stored as given; a partial one may be completed
   * from one `gh` read (contract §3.1 behaviour rules).
   */
  async function resolveBindingIssue(raw) {
    const summary = normalizeBindingIssue(raw)
    if (summary.complete) {
      return { repo: summary.repo, number: summary.number, title: summary.title, url: summary.url, state: summary.state }
    }
    const fallback = {
      repo: summary.repo,
      number: summary.number,
      title: summary.title !== '' ? summary.title : `${summary.repo}#${summary.number}`,
      url: summary.url ?? `https://github.com/${summary.repo}/issues/${summary.number}`,
      state: summary.state,
    }
    try {
      const { issue } = await gh.getIssue(summary.repo, summary.number)
      return toIssueSummary(issue)
    } catch (error) {
      if (error instanceof GhError && error.code === 'issue-not-found') throw error
      // `gh` unavailable: still store the client's summary rather than failing
      // a bind that does not need GitHub.
      return fallback
    }
  }

  async function bindIssueRequest(body) {
    const sessionId = requireId(body.sessionId, 'sessionId')
    const workspaceId = optionalId(body.workspaceId)
    let summary
    if (isRecord(body.issue)) {
      summary = await resolveBindingIssue(body.issue)
    } else if (typeof body.ref === 'string') {
      const ref = parseIssueRef(body.ref)
      if (ref === null) {
        throw badRequest('无法识别 Issue 引用（支持 Issue 链接或 owner/repo#123）')
      }
      const { issue } = await gh.getIssue(ref.repo, ref.number)
      summary = toIssueSummary(issue)
    } else {
      throw badRequest('缺少 issue 或 ref')
    }
    const session = await store.bindIssue(sessionId, summary, workspaceId)
    return { ok: true, session }
  }

  async function unbindIssueRequest(body) {
    const sessionId = requireId(body.sessionId, 'sessionId')
    await store.unbindIssue(sessionId)
    return { ok: true }
  }

  /* ---- dispatch ---- */

  async function dispatch(req, res) {
    const rawUrl = typeof req.url === 'string' && req.url.length > 0 ? req.url : '/'
    if (MALFORMED_PERCENT_PATTERN.test(rawUrl)) throw badRequest('URL 编码无效')
    let requestUrl
    try {
      requestUrl = new URL(rawUrl, 'http://127.0.0.1')
    } catch {
      throw badRequest('无法解析请求 URL')
    }
    const path = routePath(requestUrl.pathname)
    const method = typeof req.method === 'string' ? req.method.toUpperCase() : 'GET'
    const query = requestUrl.searchParams

    if (method === 'GET') {
      if (!GET_ROUTES.has(path)) throw new HttpError(404, 'not-found', `未知接口: GET ${path}`)
      if (path === '/health') return sendJson(res, 200, { ok: true, gh: await health.read() })
      if (path === '/config') return sendJson(res, 200, await readConfig(query))
      if (path === '/projects') return sendJson(res, 200, await readProjects(query))
      if (path === '/items') return sendJson(res, 200, await readItems(query))
      return sendJson(res, 200, await readIssue(query))
    }

    if (method === 'POST') {
      if (!POST_ROUTES.has(path)) throw new HttpError(404, 'not-found', `未知接口: POST ${path}`)
      checkOrigin(req)
      const body = await readJsonBody(req)
      if (path === '/bind-workspace') return sendJson(res, 200, await bindWorkspaceRequest(body))
      if (path === '/unbind-workspace') return sendJson(res, 200, await unbindWorkspaceRequest(body))
      if (path === '/bind-issue') return sendJson(res, 200, await bindIssueRequest(body))
      return sendJson(res, 200, await unbindIssueRequest(body))
    }

    throw new HttpError(404, 'not-found', `未知接口: ${method} ${path}`)
  }

  async function handle(req, res) {
    try {
      await dispatch(req, res)
    } catch (error) {
      const { status, payload } = toErrorResponse(error)
      if (payload.error.code === 'internal') {
        try { logFault?.(error) } catch { /* logging must never affect the response */ }
      }
      sendJson(res, status, payload)
    }
  }

  return { handle, dispatch }
}

/* ------------------------------------------------------------------ */
/* 7. Plugin body.                                                     */
/* ------------------------------------------------------------------ */

/** Register the HTTP API and the binding store. */
export function apply(ctx, config) {
  const settings = resolveConfig(config)
  const store = createStateStore(settings.statePath)
  const gh = createGh({
    ghCommand: settings.ghCommand,
    timeoutMs: settings.requestTimeoutMs,
    maxProjectItems: settings.maxProjectItems,
    maxComments: settings.maxComments,
    run: settings.run,
  })
  const cache = createTtlCache(settings.cacheTtlMs)
  const health = createHealthReader(gh, settings.healthCacheTtlMs, settings.healthFirstReadTimeoutMs)
  const logFault = (error) => {
    const logger = ctx?.logger
    if (typeof logger?.warn !== 'function') return
    logger.warn(error instanceof Error ? error : new Error(String(error)))
  }
  const api = createApi({ gh, store, cache, health, logFault })

  const register = (hostCtx) => {
    const webServer = typeof hostCtx?.get === 'function' ? hostCtx.get('webServer') : undefined
    if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return false
    hostCtx.effect(() => webServer.register({
      kind: 'prefix',
      path: ROUTE_PATH,
      handler: (req, res) => api.handle(req, res),
    }), 'github-projects: http api')
    return true
  }

  if (register(ctx)) return
  // No web server on this composition: if the service may still arrive, wait
  // for it; otherwise the plugin is simply inert (nothing to serve).
  if (typeof ctx?.inject === 'function') {
    try {
      ctx.inject(['webServer'], (injectedCtx) => { register(injectedCtx) })
    } catch {
      // Optional service unavailable for good: stay inert, never throw at load.
    }
  }
}

export { createApi as createGitHubProjectsApi }
