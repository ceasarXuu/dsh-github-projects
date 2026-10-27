/**
 * Host half of the `github-projects` DSH plugin (contract §3, v0.4.0).
 *
 * One Cordis plugin that:
 * - registers a single prefix route `/plugin/github-projects` on the
 *   composition's `webServer` (owned by `ctx.effect`, removed on unload);
 * - serves the eight JSON endpoints of contract §3.1 from GraphQL/REST reads,
 *   with an SWR cache (fresh window + stale-serve window, single-flight,
 *   optional bounded disk snapshot) so a tab switch never blocks on GitHub
 *   once data exists (contract §3.5);
 * - registers three agent tools on `ctx.tools` so the model can bind / switch /
 *   unbind the current session's Issue (contract §3.4);
 * - persists workspace → Project and session → Issue bindings via `state.js`.
 *
 * It is read-only against GitHub, has no npm dependencies, never logs tokens
 * or issue bodies, and answers every failure as
 * `{"error":{"code","message"}}` with a contract status code. The handler owns
 * the full `node:http` request/response; `webServer` matches the prefix and
 * passes the *unstripped* pathname, which this module tolerates either way.
 * `/config` never awaits a `gh` probe.
 *
 * `config` may be absent or partial (bare `--patch` overlay): defaults live in
 * `resolveConfig`, not in a Schemastery schema.
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
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
 * Cordis waits for these services before running `apply`.
 *
 * `--patch` overlay rows and bundle rows activate in file order; a row placed
 * before the `webserver` plugin would otherwise see `ctx.get('webServer')`
 * undefined and mount no route. `tools` is required because the agent tools
 * (contract §3.4) are registered here — v0.4.0 keeps both injects required.
 * The defensive checks in `apply` still keep direct fake-ctx calls inert.
 */
export const inject = ['webServer', 'tools']

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

const GET_ROUTES = new Set(['/health', '/config', '/bindings', '/projects', '/items', '/issue'])
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
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const declaredStatePath = typeof config.statePath === 'string' && config.statePath.trim() !== ''
    ? expandHome(config.statePath.trim())
    : null
  const statePath = declaredStatePath !== null
    ? resolvePath(declaredStatePath)
    : join(dshHome, 'plugin-data', 'github-projects', 'state.json')
  const declaredCacheFile = typeof config.cacheFile === 'string' && config.cacheFile.trim() !== ''
    ? expandHome(config.cacheFile.trim())
    : null
  const cacheFile = declaredCacheFile !== null
    ? resolvePath(declaredCacheFile)
    : join(dshHome, 'plugin-data', 'github-projects', 'cache.json')
  return {
    ghCommand: typeof config.ghCommand === 'string' && config.ghCommand.trim() !== ''
      ? config.ghCommand.trim()
      : 'gh',
    requestTimeoutMs: boundedInt(config.requestTimeoutMs, 1_000, 600_000, 20_000),
    cacheTtlMs: boundedInt(config.cacheTtlMs, 0, 24 * 60 * 60 * 1000, 60_000),
    staleTtlMs: boundedInt(config.staleTtlMs, 0, 24 * 60 * 60 * 1000, 600_000),
    diskCache: config.diskCache !== false,
    cacheFile,
    maxProjectItems: boundedInt(config.maxProjectItems, 1, 1_000, 200),
    maxComments: boundedInt(config.maxComments, 1, 100, 30),
    healthCacheTtlMs: boundedInt(config.healthCacheTtlMs, 0, 60_000, 5_000),
    // Legacy v0.1 key: `/config` no longer waits at all (contract §3.1 v0.4.0),
    // but the key stays accepted so existing profile patches keep loading.
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
/* 4. SWR cache (memory + disk) and the non-blocking health snapshot.  */
/* ------------------------------------------------------------------ */

/** In-memory SWR entries kept at most (the disk snapshot uses the same bound). */
const SWR_MAX_ENTRIES = 40

/** Disk cache snapshot format version and bounds (contract §3.1/§3.5). */
const DISK_CACHE_VERSION = 1
const DISK_CACHE_MAX_ENTRIES = 40
const DISK_CACHE_MAX_BYTES = 8 * 1024 * 1024

/**
 * Best-effort atomic snapshot of successful read values, so a DSH restart can
 * render the last data before GitHub answers. The cache is disposable: every
 * failure is swallowed and never affects a response.
 */
function createDiskCache({ filePath, enabled }) {
  if (enabled !== true) return { load: () => new Map(), save: () => undefined }
  let queue = Promise.resolve()

  function load() {
    let parsed
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    } catch {
      return new Map()
    }
    if (!isRecord(parsed) || parsed.version !== DISK_CACHE_VERSION || !isRecord(parsed.entries)) return new Map()
    const entries = new Map()
    for (const [key, record] of Object.entries(parsed.entries)) {
      if (typeof key !== 'string' || key.length === 0 || !isRecord(record)) continue
      if (!Number.isFinite(record.fetchedAt) || record.value === undefined) continue
      entries.set(key, { value: record.value, fetchedAt: record.fetchedAt })
    }
    return entries
  }

  function serialize(entries) {
    const records = {}
    for (const [key, record] of entries) {
      records[key] = { value: record.value, fetchedAt: record.fetchedAt }
    }
    return JSON.stringify({ version: DISK_CACHE_VERSION, updatedAt: new Date().toISOString(), entries: records })
  }

  /** Newest `DISK_CACHE_MAX_ENTRIES`, then drop oldest until under the byte cap. */
  function bounded(entries) {
    const sorted = [...entries.entries()].sort((left, right) => right[1].fetchedAt - left[1].fetchedAt)
    const kept = new Map(sorted.slice(0, DISK_CACHE_MAX_ENTRIES))
    while (kept.size > 0) {
      let text
      try {
        text = serialize(kept)
      } catch {
        return kept
      }
      if (Buffer.byteLength(text) <= DISK_CACHE_MAX_BYTES) return kept
      const oldest = [...kept.entries()].sort((left, right) => left[1].fetchedAt - right[1].fetchedAt)[0]
      kept.delete(oldest[0])
    }
    return kept
  }

  function save(entries) {
    const kept = bounded(entries)
    let text
    try {
      text = serialize(kept)
    } catch {
      return undefined
    }
    if (Buffer.byteLength(text) > DISK_CACHE_MAX_BYTES) return undefined
    const task = async () => {
      try {
        mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
        await writeFile(`${filePath}.tmp`, text, { mode: 0o600 })
        await rename(`${filePath}.tmp`, filePath)
      } catch {
        /* best-effort cache write: the hot path never depends on it */
      }
    }
    queue = queue.then(task, task)
    return queue
  }

  return { load, save }
}

/**
 * Cache with stale-while-revalidate semantics (contract §3.1/§3.5).
 *
 * - fresh (`cacheTtlMs`) → serve from memory without I/O;
 * - stale (`cacheTtlMs` … `cacheTtlMs + staleTtlMs`) → serve immediately with
 *   `stale: true` and revalidate once in the background;
 * - colder than that, or `refresh=1` → await one load (single-flight, also
 *   shared with a background revalidation already in flight).
 * Successful loads are persisted to disk best-effort, bounded, atomic.
 */
function createSwrCache({ cacheTtlMs, staleTtlMs, disk }) {
  /** @type {Map<string, {value: any, fetchedAt: number}>} */
  const entries = disk.load()
  const pending = new Map()

  const freshness = (record) => {
    const age = Date.now() - record.fetchedAt
    if (cacheTtlMs > 0 && age < cacheTtlMs) return 'fresh'
    if (staleTtlMs > 0 && age < cacheTtlMs + staleTtlMs) return 'stale'
    return 'expired'
  }

  const prune = () => {
    if (entries.size <= SWR_MAX_ENTRIES) return
    const oldest = [...entries.entries()].sort((left, right) => left[1].fetchedAt - right[1].fetchedAt)
    while (entries.size > SWR_MAX_ENTRIES) {
      const [key] = oldest.shift()
      if (key === undefined) break
      entries.delete(key)
    }
  }

  function loadNow(key, load) {
    const inflight = pending.get(key)
    if (inflight !== undefined) return inflight
    const promise = (async () => {
      const value = await load()
      const record = { value, fetchedAt: Date.now() }
      entries.set(key, record)
      prune()
      try {
        void disk.save(entries)
      } catch {
        /* best-effort */
      }
      return record
    })()
    pending.set(key, promise)
    const settle = () => { if (pending.get(key) === promise) pending.delete(key) }
    promise.then(settle, settle)
    return promise
  }

  function revalidate(key, load) {
    if (pending.has(key)) return
    loadNow(key, load).catch(() => { /* keep serving the stale value; retry later */ })
  }

  return {
    async get(key, refresh, load) {
      const record = entries.get(key)
      if (record !== undefined && refresh !== true) {
        const status = freshness(record)
        if (status === 'fresh') return { value: record.value, fetchedAt: record.fetchedAt, stale: false }
        if (status === 'stale') {
          revalidate(key, load)
          return { value: record.value, fetchedAt: record.fetchedAt, stale: true }
        }
      }
      const loaded = await loadNow(key, load)
      return { value: loaded.value, fetchedAt: loaded.fetchedAt, stale: false }
    },
    /** Diagnostic helper: number of in-memory entries. */
    size() { return entries.size },
  }
}

/** Answer for a cold `/config` while the background probe is still running. */
const PENDING_GH_HEALTH = Object.freeze({
  available: false,
  version: null,
  account: null,
  error: 'pending',
})

/**
 * Health snapshot shared by `/health` and `/config` (contract §3.1 v0.4.0).
 *
 * `/config` NEVER waits for `gh`: it answers the last snapshot (or the
 * `pending` placeholder on a cold start) and lets one background probe refresh
 * it. `/health` still awaits a real probe, sharing any in-flight one.
 */
function createHealthReader(gh, ttlMs) {
  let record = null
  let pending = null
  let lastAttemptAt = null
  const probeFloorMs = Math.max(250, Math.min(ttlMs > 0 ? ttlMs : 1000, 1000))

  const refresh = () => {
    if (pending !== null) return pending
    lastAttemptAt = Date.now()
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
    /** `/config`: last snapshot, never awaits GitHub. */
    snapshot() {
      if (record === null) {
        if (lastAttemptAt === null || Date.now() - lastAttemptAt >= probeFloorMs) {
          refresh().catch(() => { /* failed probes never fail /config */ })
        }
        return PENDING_GH_HEALTH
      }
      if (isStale()) refresh().catch(() => { /* keep the stale snapshot */ })
      return record.value
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
/* 5.5 Agent tools (contract §3.4).                                    */
/* ------------------------------------------------------------------ */

/** JSON Schema of the canonical `IssueSummary` the tools return. */
const TOOL_ISSUE_SUMMARY_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    repo: { type: 'string', description: 'Repository as owner/name.' },
    number: { type: 'integer', description: 'Issue number.' },
    title: { type: 'string', description: 'Issue title.' },
    url: { type: 'string', description: 'Canonical GitHub Issue URL.' },
    state: { type: 'string', description: 'GitHub issue state, e.g. open/closed.' },
  },
  required: ['repo', 'number', 'title', 'url', 'state'],
})

/** `IssueSummary | null` (previous binding or none). */
const TOOL_PREVIOUS_ISSUE_SCHEMA = Object.freeze({
  oneOf: [TOOL_ISSUE_SUMMARY_SCHEMA, { type: 'null' }],
})

/** Shared `{ ref }` parameters schema for bind/switch. */
const TOOL_REF_PARAMETERS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    ref: {
      type: 'string',
      description: 'Issue reference: a GitHub Issue URL (https://github.com/owner/repo/issues/N) or "owner/repo#N".',
    },
  },
  required: ['ref'],
})

const TOOL_EMPTY_PARAMETERS = Object.freeze({ type: 'object', additionalProperties: false, properties: {} })

/** One text block, the contract's `output.render` shape. */
function toolText(text) {
  return [{ type: 'text', text }]
}

/** `#240 issue title` compact label for tool render output. */
function shortIssueLabel(issue) {
  const number = issue !== null && typeof issue === 'object' && Number.isInteger(issue.number) ? issue.number : null
  const title = issue !== null && typeof issue === 'object' && typeof issue.title === 'string' ? issue.title.trim() : ''
  const compact = title.length > 80 ? `${title.slice(0, 80)}…` : title
  if (number === null) return compact
  return compact === '' ? `#${String(number)}` : `#${String(number)} ${compact}`
}

/**
 * One tool failure whose message starts with the contract error code, so the
 * model-facing `Error: …` text carries the same classification as the HTTP API.
 */
function toolFailure(code, message) {
  return new GhError(code, `${code}: ${message}`)
}

/** The live session id of the calling agent, or a clear "no current session". */
function sessionIdOf(exec) {
  const agent = exec !== null && typeof exec === 'object' ? exec.agent : undefined
  const session = agent !== null && typeof agent === 'object' ? agent.session : undefined
  const id = session !== null && typeof session === 'object' ? session.id : undefined
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw toolFailure('bad-request', 'no current session: agent tools must run inside a session')
  }
  return id.trim()
}

/** Validate the model-supplied `{ ref }` ourselves (plain JSON Schema only). */
function refArgument(args) {
  if (!isRecord(args)) throw toolFailure('bad-request', 'arguments must be a JSON object')
  const ref = args.ref
  if (typeof ref !== 'string' || ref.trim().length === 0) {
    throw toolFailure('bad-request', 'ref must be a non-empty Issue reference (URL or owner/repo#123)')
  }
  return ref.trim()
}

/**
 * Build the three plain-JSON-Schema agent tool definitions (contract §3.4).
 *
 * No `@deepseek-ai/*` import: the raw
 * `{ name, description, parameters, output: { schema, render }, execute }`
 * shape is what `ctx.tools.register` accepts. Tools only address the calling
 * session (`exec.agent.session.id`), only write the local binding store, and
 * never write to GitHub.
 */
export function createAgentToolDefinitions({ gh, store }) {
  async function resolveSummary(ref) {
    const parsed = parseIssueRef(ref)
    if (parsed === null) throw toolFailure('bad-request', `invalid issue reference: ${ref.slice(0, 120)}`)
    try {
      const { issue } = await gh.getIssue(parsed.repo, parsed.number)
      return toIssueSummary(issue)
    } catch (error) {
      if (error instanceof GhError) throw new GhError(error.code, `${error.code}: ${error.message}`)
      throw error
    }
  }

  return [
    {
      name: 'github_issue_bind',
      description: 'Bind a GitHub Issue to the CURRENT session so the session shows its issue subtitle and the issue tab. Refuses when the session already has a bound Issue (use github_issue_switch to replace it). Read-only against GitHub.',
      parameters: TOOL_REF_PARAMETERS,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            bound: { type: 'boolean', const: true },
            issue: TOOL_ISSUE_SUMMARY_SCHEMA,
            previous: TOOL_PREVIOUS_ISSUE_SCHEMA,
          },
          required: ['bound', 'issue', 'previous'],
        },
        render: (_args, value) => toolText(`已绑定 ${shortIssueLabel(value.issue)}（${value.issue.repo}）`),
      },
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        const ref = refArgument(args)
        const current = store.getSession(sessionId)
        if (current.issue !== null) {
          throw toolFailure('bad-request', `already bound: ${current.issue.repo}#${String(current.issue.number)}; use github_issue_switch to replace it`)
        }
        const issue = await resolveSummary(ref)
        const binding = await store.bindIssue(sessionId, issue, current.workspaceId)
        return { bound: true, issue: binding.issue, previous: null }
      },
    },
    {
      name: 'github_issue_switch',
      description: 'Replace the Issue bound to the CURRENT session with another GitHub Issue. Fails when the session has no bound Issue yet (use github_issue_bind). Read-only against GitHub.',
      parameters: TOOL_REF_PARAMETERS,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            switched: { type: 'boolean', const: true },
            issue: TOOL_ISSUE_SUMMARY_SCHEMA,
            previous: TOOL_ISSUE_SUMMARY_SCHEMA,
          },
          required: ['switched', 'issue', 'previous'],
        },
        render: (_args, value) => toolText(`已切换到 ${shortIssueLabel(value.issue)}（${value.issue.repo}）`),
      },
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        const ref = refArgument(args)
        const current = store.getSession(sessionId)
        if (current.issue === null) {
          throw toolFailure('bad-request', 'not bound: no Issue is bound to this session; use github_issue_bind first')
        }
        const issue = await resolveSummary(ref)
        const binding = await store.bindIssue(sessionId, issue, current.workspaceId)
        return { switched: true, issue: binding.issue, previous: current.issue }
      },
    },
    {
      name: 'github_issue_unbind',
      description: 'Remove the Issue bound to the CURRENT session. Succeeds even when nothing is bound (previous is null). Never touches other sessions or GitHub.',
      parameters: TOOL_EMPTY_PARAMETERS,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            unbound: { type: 'boolean', const: true },
            previous: TOOL_PREVIOUS_ISSUE_SCHEMA,
          },
          required: ['unbound', 'previous'],
        },
        render: (_args, value) => toolText(
          value.previous === null
            ? '当前会话未绑定 Issue'
            : `已解绑 ${shortIssueLabel(value.previous)}（${value.previous.repo}）`,
        ),
      },
      async execute(_args, exec) {
        const sessionId = sessionIdOf(exec)
        const current = store.getSession(sessionId)
        await store.unbindIssue(sessionId)
        return { unbound: true, previous: current.issue }
      },
    },
  ]
}

/* ------------------------------------------------------------------ */
/* 6. The HTTP API.                                                    */
/* ------------------------------------------------------------------ */

function createApi({ gh, store, cache, health, logFault }) {
  const iso = (timestamp) => new Date(timestamp).toISOString()

  /* ---- GET handlers (read-only; no GitHub writes) ---- */

  function readConfig(query) {
    const workspaceId = optionalId(query.get('workspaceId'))
    const sessionId = optionalId(query.get('sessionId'))
    const ghHealth = health.snapshot()
    const workspace = workspaceId === null
      ? { workspaceId: '', project: null }
      : store.getWorkspace(workspaceId)
    const storedSession = sessionId === null ? null : store.getSession(sessionId)
    const session = storedSession === null
      ? { sessionId: sessionId ?? '', issue: null, workspaceId: workspaceId ?? null }
      : { ...storedSession, workspaceId: storedSession.workspaceId ?? workspaceId ?? null }
    return { gh: ghHealth, workspace, session }
  }

  /**
   * `GET /bindings` (v0.4.1): every durable session → Issue binding, for the
   * client's sidebar decorator. Local store only — no `gh`, no SWR cache, no
   * `stale` field — so it is cheap enough to poll every few seconds.
   */
  function readBindings() {
    const snapshot = store.snapshot()
    const sessions = {}
    for (const [sessionId, entry] of Object.entries(snapshot.sessions)) {
      if (!isRecord(entry) || !isRecord(entry.issue)) continue
      const summary = toIssueSummary(entry.issue)
      if (summary.repo === '' || !Number.isInteger(summary.number) || summary.number <= 0) continue
      sessions[sessionId] = summary
    }
    return {
      sessions,
      updatedAt: typeof snapshot.updatedAt === 'string' && snapshot.updatedAt !== ''
        ? snapshot.updatedAt
        : new Date().toISOString(),
    }
  }

  async function readProjects(query) {
    const record = await cache.get('projects', isRefresh(query.get('refresh')), () => gh.listProjects())
    const value = record.value
    return {
      owners: Array.isArray(value.owners) ? value.owners : [],
      projects: Array.isArray(value.projects) ? value.projects : [],
      fetchedAt: iso(record.fetchedAt),
      stale: record.stale === true,
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
      stale: record.stale === true,
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
    return { issue: record.value.issue, fetchedAt: iso(record.fetchedAt), stale: record.stale === true }
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
      if (path === '/bindings') return sendJson(res, 200, readBindings())
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

/** One service off the context, tolerating fake/narrow test contexts. */
function serviceOf(ctx, name) {
  return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
}

/** Register the HTTP API, the binding store, and the agent tools. */
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
  const disk = createDiskCache({ filePath: settings.cacheFile, enabled: settings.diskCache })
  const cache = createSwrCache({
    cacheTtlMs: settings.cacheTtlMs,
    staleTtlMs: settings.staleTtlMs,
    disk,
  })
  const health = createHealthReader(gh, settings.healthCacheTtlMs)
  const logFault = (error) => {
    const logger = ctx?.logger
    if (typeof logger?.warn !== 'function') return
    logger.warn(error instanceof Error ? error : new Error(String(error)))
  }
  const api = createApi({ gh, store, cache, health, logFault })

  // Agent tools (contract §3.4): effect-owned registrations on the `tools`
  // service, so unloading the plugin removes them.
  const tools = serviceOf(ctx, 'tools')
  if (tools !== undefined && tools !== null && typeof tools.register === 'function') {
    for (const definition of createAgentToolDefinitions({ gh, store })) {
      ctx.effect(() => tools.register(definition), `github-projects: tool ${definition.name}`)
    }
  }

  const registerRoute = (hostCtx) => {
    const webServer = serviceOf(hostCtx, 'webServer')
    if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return false
    hostCtx.effect(() => webServer.register({
      kind: 'prefix',
      path: ROUTE_PATH,
      handler: (req, res) => api.handle(req, res),
    }), 'github-projects: http api')
    return true
  }

  if (registerRoute(ctx)) return
  // No web server on this composition: if the service may still arrive, wait
  // for it; otherwise HTTP stays inert while the tools above still register.
  if (typeof ctx?.inject === 'function') {
    try {
      ctx.inject(['webServer'], (injectedCtx) => { registerRoute(injectedCtx) })
    } catch {
      // Optional service unavailable for good: stay inert, never throw at load.
    }
  }
}

export { createApi as createGitHubProjectsApi }
