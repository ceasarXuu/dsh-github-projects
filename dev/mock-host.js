/**
 * Contract-shaped MOCK host half for UI and e2e development.
 *
 * It serves exactly the HTTP contract in `docs/CONTRACT.md` from the captured
 * `gh` fixtures, with in-memory bindings and (v1.1.0) in-memory Project item
 * status writes, so the browser half can be developed and screenshotted
 * without the real `gh` CLI.
 *
 * v1.1.0 additions: `GET /config.writes`, `GET /project-meta`,
 * `POST /item-status` (honoring `allowWrites` from the overlay config), and one
 * deterministic failure item (`MOCK_FAILURE_ITEM`, see below) so the e2e
 * rollback stage can force a 5xx on demand. `GET /mock-state` is a
 * mock-only debug/assertion aid (not part of the shipped contract) exposing the
 * accepted write log and the current in-memory statuses.
 *
 * Load it through a `--patch` overlay row whose `name` is the absolute path of
 * this file; the client bundle is still served from this package because the
 * nearest `package.json` carries the `dsh.client` declaration.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const fixtureDir = join(here, '..', 'test', 'fixtures')
const readJson = name => JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'))

const projectList = readJson('project-list.json')
const itemList = readJson('item-list.json')
const issueFixture = readJson('issue.json')
const commentFixtures = readJson('issue-comments.json')
const projectMetaFixture = readJson('graphql-project-meta.json')

/** @type {Map<string, { workspaceId: string, project: object }>} */
const workspaceBindings = new Map()
/** @type {Map<string, { sessionId: string, issue: object, workspaceId: string | null }>} */
const sessionBindings = new Map()

function ownerTypeOf(owner) {
  const type = String(owner?.type ?? 'User')
  return type.toLowerCase() === 'organization' ? 'organization' : 'user'
}

function projectOf(raw) {
  return {
    owner: raw.owner?.login ?? '',
    ownerType: ownerTypeOf(raw.owner),
    number: raw.number,
    title: raw.title ?? '',
    url: raw.url ?? null,
    itemCount: raw.items?.totalCount ?? null,
    closed: raw.closed === true,
    description: raw.shortDescription ?? null,
  }
}

function summaryOfIssue(raw) {
  const repo = String(raw.repository ?? '').replace(/^https:\/\/github\.com\//u, '')
  return {
    repo,
    number: raw.number,
    title: raw.title ?? '',
    url: raw.url ?? '',
    state: String(raw.state ?? 'open').toLowerCase(),
  }
}

function itemOf(raw) {
  const type = raw.content?.type === 'PullRequest' ? 'pr' : raw.content?.type === 'DraftIssue' ? 'draft' : 'issue'
  return {
    id: raw.id,
    type,
    number: raw.content?.number ?? null,
    repo: raw.content?.repository ?? null,
    title: raw.content?.title ?? raw.title ?? '',
    url: raw.content?.url ?? null,
    state: null,
    status: raw.status ?? null,
    labels: Array.isArray(raw.labels) ? raw.labels : [],
    milestone: raw.milestone?.title ?? null,
  }
}

function issueOf(raw, comments) {
  return {
    repo: String(raw.html_url ?? '').match(/github\.com\/([^/]+\/[^/]+)\/issues\//u)?.[1] ?? 'ceasarXuu/Astropath',
    number: raw.number,
    title: raw.title ?? '',
    url: raw.html_url ?? '',
    state: String(raw.state ?? 'open').toLowerCase(),
    author: raw.user?.login ?? null,
    createdAt: raw.created_at ?? '',
    updatedAt: raw.updated_at ?? '',
    labels: (raw.labels ?? []).map(label => label.name ?? String(label)),
    assignees: (raw.assignees ?? []).map(user => user.login),
    body: raw.body ?? '',
    bodyTruncated: false,
    commentCount: raw.comments ?? comments.length,
    comments: comments.map(comment => ({
      id: String(comment.id),
      author: comment.user?.login ?? null,
      createdAt: comment.created_at ?? '',
      body: comment.body ?? '',
      url: comment.html_url ?? null,
    })),
    commentsTruncated: (raw.comments ?? 0) > comments.length,
  }
}

/**
 * v1.1.0 deterministic write-failure item (e2e rollback stage):
 * `POST /item-status` for this id always answers 502 `gh-failed`, so the
 * client's optimistic-update rollback + failure toast can be driven in
 * fixture mode. The id and title are stable mock-host contract surface.
 */
const MOCK_FAILURE_ITEM = Object.freeze({
  id: 'PVTI_mock_write_failure',
  number: 9005,
  title: '[mock] 写入失败条目（e2e 回滚验证）',
  repo: 'ceasarXuu/Astropath',
})

/**
 * Extra fixture-only items so the v1.1 board/filter stages have data in every
 * swimlane and a real "Backlog" population. They never reach real mode.
 */
const syntheticItems = [
  {
    id: 'mock-item-todo-backlog', type: 'issue', number: 9001, repo: 'ceasarXuu/Astropath',
    title: '[mock] 待定需求：未分配 milestone 的条目', url: 'https://github.com/ceasarXuu/Astropath/issues/9001',
    state: 'OPEN', status: 'TODO', labels: ['todo', 'mock'], milestone: null,
  },
  {
    id: 'mock-item-in-progress', type: 'issue', number: 9002, repo: 'ceasarXuu/Astropath',
    title: '[mock] 进行中：验收 board 的 In Progress 泳道', url: 'https://github.com/ceasarXuu/Astropath/issues/9002',
    state: 'OPEN', status: 'In Progress', labels: ['enhancement'], milestone: 'v1.2.0',
  },
  {
    id: 'mock-item-no-status', type: 'issue', number: 9003, repo: 'ceasarXuu/Astropath',
    title: '[mock] 无状态条目：验证 No status 泳道', url: 'https://github.com/ceasarXuu/Astropath/issues/9003',
    state: 'OPEN', status: null, labels: ['bug'], milestone: null,
  },
  {
    id: 'mock-item-done', type: 'issue', number: 9004, repo: 'ceasarXuu/Astropath',
    title: '[mock] 已完成条目：验证 Done 泳道', url: 'https://github.com/ceasarXuu/Astropath/issues/9004',
    state: 'CLOSED', status: 'Done', labels: ['done'], milestone: 'v1.2.0',
  },
  {
    id: 'mock-item-draft', type: 'draft', number: null, repo: null,
    title: '[mock] Draft 条目：无编号、无仓库', url: null,
    state: null, status: 'TODO', labels: [], milestone: null,
  },
  {
    id: MOCK_FAILURE_ITEM.id, type: 'issue', number: MOCK_FAILURE_ITEM.number, repo: MOCK_FAILURE_ITEM.repo,
    title: MOCK_FAILURE_ITEM.title,
    url: `https://github.com/${MOCK_FAILURE_ITEM.repo}/issues/${String(MOCK_FAILURE_ITEM.number)}`,
    state: 'OPEN', status: 'TODO', labels: ['mock', 'failure'], milestone: null,
  },
]

const projects = (projectList.projects ?? []).map(projectOf)
const issue = issueOf(issueFixture, commentFixtures)

/** Every mock item in board order: captured fixture items, then synthetic ones. */
const baseItems = [...(itemList.items ?? []).map(itemOf), ...syntheticItems]

/** v1.1.0 in-memory Status overrides: itemId → status name (`null` = No status). */
const statusByItemId = new Map(baseItems.map(item => [item.id, item.status ?? null]))

/** Accepted write log exposed by the mock-only `/mock-state` route. */
const writeLog = []

/**
 * v1.2.0 `GET /branches` fixture: one entry per *bound* workspace (the mock has
 * no workspace registry), cycling through a plain branch, a slash branch, and a
 * detached HEAD so the chip's three presentations are all reachable. Override
 * with `MOCK_BRANCHES="<workspaceId>=<branch>,<workspaceId>=detached"`.
 * A `!` prefix marks a workspace whose directory is not a git repository.
 */
const MOCK_BRANCHES = [
  { branch: 'main', detached: false },
  { branch: 'feat/left-sidebar-branch', detached: false },
  { branch: null, detached: true, commit: '9f2c1ab' },
]

const branchOverrides = new Map()
/** `*=<branch>` sets the value for every workspace without its own entry. */
let branchDefault = null
/**
 * `*=git:<dir>` makes every workspace answer whatever branch `<dir>` is really
 * on, read live. The e2e harness uses this so the fixture stack reports the same
 * fact as the real git repository it created (including a checkout performed
 * mid-run by the repaint assertion) without pretending to be a workspace list.
 */
let branchGitDirectory = null
for (const pair of String(process.env.MOCK_BRANCHES ?? '').split(',')) {
  const index = pair.indexOf('=')
  if (index <= 0) continue
  const id = pair.slice(0, index).trim()
  const value = pair.slice(index + 1).trim()
  if (id === '' || value === '') continue
  const parsed = value === 'detached'
    ? { branch: null, detached: true, commit: '9f2c1ab' }
    : value.startsWith('!')
      ? { repo: false }
      : { branch: value, detached: false }
  if (id === '*' && value.startsWith('git:')) branchGitDirectory = value.slice('git:'.length).trim()
  else if (id === '*') branchDefault = parsed
  else branchOverrides.set(id, parsed)
}

/**
 * v1.3.0 `GET /auto-bind` fixture. The mode comes from `MOCK_AUTOBIND` (read
 * per request so the e2e harness can switch it without a second stack).
 */
function autoBindPayload(workspaceId) {
  const mode = String(process.env.MOCK_AUTOBIND ?? 'bound').trim() || 'bound'
  if (mode === 'disabled') return { enabled: false, applied: false, reason: 'disabled' }
  if (typeof workspaceId !== 'string' || workspaceId === '') {
    return { enabled: true, applied: false, reason: 'no-workspace' }
  }
  // Mirror the real contract: a workspace that already has a binding is never
  // re-bound, whichever way that binding was made. The explicit mode stays so a
  // test can reach the answer without a prior bind.
  if (workspaceBindings.has(workspaceId) || mode === 'already-bound') {
    return { enabled: true, applied: false, reason: 'already-bound' }
  }
  if (mode === 'no-project') {
    return { enabled: true, applied: false, reason: 'no-project', repository: 'ceasarXuu/Astropath', project: null, ambiguous: false, considered: 0 }
  }
  const project = projects.find(entry => entry.number === 9) ?? projects[0]
  const ambiguous = mode === 'ambiguous'
  const binding = {
    project,
    autoBind: {
      repository: 'ceasarXuu/Astropath',
      ambiguous,
      considered: ambiguous ? 2 : 1,
      appliedAt: new Date().toISOString(),
    },
  }
  workspaceBindings.set(workspaceId, { workspaceId, ...binding })
  return {
    enabled: true,
    workspaceId,
    applied: true,
    reason: ambiguous ? 'bound-ambiguous' : 'bound',
    repository: 'ceasarXuu/Astropath',
    project,
    ambiguous,
    considered: ambiguous ? 2 : 1,
  }
}

/** Live branch of `branchGitDirectory`, or `null` when it cannot be read. */
function liveGitBranch() {
  if (branchGitDirectory === null || branchGitDirectory === '') return null
  try {
    const branch = execFileSync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], {
      cwd: branchGitDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return branch === '' ? null : branch
  } catch {
    return null
  }
}

/** True when a workspace id is a real workspace row (not the ungrouped bucket). */
function branchPayload() {
  const live = liveGitBranch()
  const workspaces = {}
  let index = 0
  for (const workspaceId of workspaceBindings.keys()) {
    if (typeof workspaceId !== 'string' || workspaceId === '' || workspaceId === 'ungrouped') continue
    const override = branchOverrides.get(workspaceId) ?? branchDefault
    const fixture = live !== null
      ? { branch: live, detached: false }
      : override ?? MOCK_BRANCHES[index % MOCK_BRANCHES.length]
    index += 1
    if (fixture.repo === false) continue
    workspaces[workspaceId] = {
      workspaceId,
      path: `/mock/workspace/${workspaceId}`,
      repo: true,
      branch: fixture.detached === true ? null : fixture.branch,
      detached: fixture.detached === true,
      commit: fixture.detached === true ? fixture.commit ?? '9f2c1ab' : null,
      readAt: new Date().toISOString(),
    }
  }
  return {
    revision: 1,
    updatedAt: new Date().toISOString(),
    git: { available: true, error: null },
    workspaces,
  }
}

/** Real ids captured in `test/fixtures/graphql-project-meta.json`. */
const projectMetaNode = projectMetaFixture.data.repositoryOwner.projectV2
const statusField = {
  id: projectMetaNode.field.id,
  name: projectMetaNode.field.name,
  options: projectMetaNode.field.options.map(option => ({ id: option.id, name: option.name })),
}

/** Every mock item with its current in-memory Status. */
function allItems() {
  return baseItems.map(item => ({ ...item, status: statusByItemId.get(item.id) ?? null }))
}

/** The mock Project matching `owner`/`number`, or `undefined`. */
function findProject(owner, number) {
  return projects.find(project => project.number === number && project.owner === owner)
}

function health() {
  return { available: true, version: 'gh version 2.96.0 (mock)', account: 'ceasarXuu', error: null }
}

function configFor(sessionId, workspaceId, allowWrites) {
  return {
    gh: health(),
    workspace: {
      workspaceId: workspaceId ?? '',
      project: workspaceBindings.get(workspaceId)?.project ?? null,
    },
    session: {
      sessionId: sessionId ?? '',
      issue: sessionBindings.get(sessionId)?.issue ?? null,
      workspaceId: sessionBindings.get(sessionId)?.workspaceId ?? workspaceId ?? null,
    },
    // v1.1.0 opt-in writes: mirrored from the mock host's overlay config.
    writes: { allowed: allowWrites === true },
  }
}

function send(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function fail(res, status, code, message) {
  send(res, status, { error: { code, message } })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 65536) {
        reject(Object.assign(new Error('body too large'), { code: 'too-large' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const delay = ms => new Promise(resolve => { setTimeout(resolve, ms) })

function normalizeRef(ref) {
  const text = String(ref ?? '').trim()
  const url = text.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)/u)
  if (url !== null) return { repo: `${url[1]}/${url[2]}`, number: Number(url[3]) }
  const short = text.match(/^([^/\s#]+)\/([^/\s#]+)#(\d+)$/u)
  if (short !== null) return { repo: `${short[1]}/${short[2]}`, number: Number(short[3]) }
  return null
}

async function handle(req, res, allowWrites) {
  const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
  // The shipped webServer matches a prefix route but passes the UNSTRIPPED
  // pathname (see docs/CONTRACT.md §3.1 and index.js `routePath`).
  const route = requestUrl.pathname.startsWith('/plugin/github-projects')
    ? requestUrl.pathname.slice('/plugin/github-projects'.length) || '/'
    : requestUrl.pathname
  const query = requestUrl.searchParams
  const sessionId = query.get('sessionId') ?? ''
  const workspaceId = query.get('workspaceId') ?? ''

  if (req.method === 'GET' && route === '/health') {
    return send(res, 200, { ok: true, gh: health() })
  }
  if (req.method === 'GET' && route === '/config') {
    return send(res, 200, configFor(sessionId, workspaceId, allowWrites))
  }
  if (req.method === 'GET' && route === '/bindings') {
    const sessions = {}
    for (const [id, binding] of sessionBindings.entries()) sessions[id] = binding.issue
    const workspaces = {}
    for (const [id, binding] of workspaceBindings.entries()) {
      workspaces[id] = binding.autoBind === undefined
        ? binding.project
        : { ...binding.project, autoBind: binding.autoBind }
    }
    return send(res, 200, { sessions, workspaces, updatedAt: new Date().toISOString() })
  }
  // Mock-only debug/assertion aid (NOT part of the shipped contract): the e2e
  // harness can read the accepted write payloads and the in-memory statuses.
  if (req.method === 'GET' && route === '/mock-state') {
    return send(res, 200, {
      allowWrites: allowWrites === true,
      writes: [...writeLog],
      statuses: Object.fromEntries(statusByItemId),
      failureItem: { id: MOCK_FAILURE_ITEM.id, title: MOCK_FAILURE_ITEM.title, number: MOCK_FAILURE_ITEM.number },
    })
  }
  if (req.method === 'GET' && route === '/projects') {
    await delay(180)
    return send(res, 200, {
      owners: [{ login: 'ceasarXuu', type: 'user' }, { login: 'XuyuTech', type: 'organization' }],
      projects,
      fetchedAt: new Date().toISOString(),
      stale: false,
      errors: [],
    })
  }
  if (req.method === 'GET' && route === '/items') {
    await delay(220)
    const owner = query.get('owner') ?? projects[0]?.owner ?? ''
    const number = Number(query.get('number') ?? projects[0]?.number ?? 0)
    const project = findProject(owner, number) ?? projects[0]
    const items = allItems()
    return send(res, 200, {
      project,
      // v1.1.0: reflects in-memory status writes.
      items,
      fetchedAt: new Date().toISOString(),
      truncated: (itemList.totalCount ?? 0) > items.length,
      stale: false,
    })
  }
  if (req.method === 'GET' && route === '/branches') {
    return send(res, 200, branchPayload())
  }
  // v1.3.0 auto-bind: mirror the real host's contract. `MOCK_AUTOBIND` decides
  // which answer the fixture returns, so every reason is reachable in e2e:
  // `bound` (default), `ambiguous`, `no-project`, `already-bound`, `disabled`.
  if (req.method === 'GET' && route === '/auto-bind') {
    return send(res, 200, autoBindPayload(workspaceId))
  }
  // v1.1.0 write-side metadata: Project node id + Status field options.
  if (req.method === 'GET' && route === '/project-meta') {
    const owner = query.get('owner') ?? ''
    const number = Number(query.get('number') ?? 0)
    const project = findProject(owner, number)
    if (project === undefined) return fail(res, 404, 'project-not-found', '找不到该 Project（mock）')
    return send(res, 200, {
      project: {
        id: projectMetaNode.id,
        owner: project.owner,
        number: project.number,
        title: project.title,
      },
      statusField: {
        id: statusField.id,
        name: statusField.name,
        options: statusField.options.map(option => ({ ...option })),
      },
      fetchedAt: new Date().toISOString(),
      stale: false,
    })
  }
  if (req.method === 'GET' && route === '/issue') {
    await delay(220)
    return send(res, 200, { issue, fetchedAt: new Date().toISOString(), stale: false })
  }
  if (req.method === 'POST' && route === '/bind-workspace') {
    const body = JSON.parse(await readBody(req))
    const target = {
      workspaceId: body.workspaceId,
      project: body.project ?? projects.find(item => item.number === body.project?.number) ?? null,
    }
    workspaceBindings.set(body.workspaceId, target)
    if (body.sessionId) {
      const current = sessionBindings.get(body.sessionId)
      if (current !== undefined) current.workspaceId = body.workspaceId
    }
    return send(res, 200, { ok: true, workspace: target })
  }
  if (req.method === 'POST' && route === '/unbind-workspace') {
    const body = JSON.parse(await readBody(req))
    workspaceBindings.delete(body.workspaceId)
    return send(res, 200, { ok: true })
  }
  if (req.method === 'POST' && route === '/bind-issue') {
    const body = JSON.parse(await readBody(req))
    let summary = body.issue ?? null
    if (summary === null && body.ref !== undefined) {
      if (normalizeRef(body.ref) === null) return fail(res, 400, 'bad-request', 'invalid issue reference')
      summary = summaryOfIssue(issueFixture)
    }
    if (summary === null) return fail(res, 400, 'bad-request', 'issue or ref is required')
    const target = { sessionId: body.sessionId, issue: summary, workspaceId: body.workspaceId ?? null }
    sessionBindings.set(body.sessionId, target)
    return send(res, 200, { ok: true, session: target })
  }
  if (req.method === 'POST' && route === '/unbind-issue') {
    const body = JSON.parse(await readBody(req))
    sessionBindings.delete(body.sessionId)
    return send(res, 200, { ok: true })
  }
  // v1.1.0 the only mock write: in-memory Status updates, gated by allowWrites.
  if (req.method === 'POST' && route === '/item-status') {
    if (allowWrites !== true) {
      return fail(res, 403, 'writes-disabled', '写操作未启用：mock host 的 overlay config 未设置 allowWrites: true')
    }
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return fail(res, 400, 'bad-request', '请求体不是合法 JSON')
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return fail(res, 400, 'bad-request', '请求体必须是 JSON 对象')
    }
    const owner = String(body.owner ?? '')
    const number = Number(body.number ?? 0)
    const itemId = typeof body.itemId === 'string' ? body.itemId.trim() : ''
    const project = findProject(owner, number)
    if (project === undefined) return fail(res, 404, 'project-not-found', '找不到该 Project（mock）')
    if (itemId === '') return fail(res, 400, 'bad-request', '缺少 itemId')
    const item = baseItems.find(entry => entry.id === itemId)
    if (item === undefined) return fail(res, 404, 'item-not-found', '找不到该 Project 条目（mock）')
    if (itemId === MOCK_FAILURE_ITEM.id) {
      // Deterministic 5xx for the e2e rollback stage: the client must roll the
      // optimistic card back and show the failure toast.
      writeLog.push({ at: new Date().toISOString(), owner, number, itemId, optionId: body.optionId ?? null, ok: false, code: 'gh-failed' })
      return fail(res, 502, 'gh-failed', 'mock injected mutation failure（回滚条目，确定性失败）')
    }
    if (!Object.hasOwn(body, 'optionId')) return fail(res, 400, 'bad-request', '缺少 optionId（清除请显式传 null）')
    let status
    if (body.optionId === null) {
      statusByItemId.set(itemId, null)
      status = { optionId: null, name: null }
    } else {
      const option = statusField.options.find(entry => entry.id === String(body.optionId))
      if (option === undefined) return fail(res, 400, 'bad-request', `未知的 Status 选项 id：${String(body.optionId)}`)
      statusByItemId.set(itemId, option.name)
      status = { optionId: option.id, name: option.name }
    }
    writeLog.push({ at: new Date().toISOString(), owner, number, itemId, optionId: status.optionId, name: status.name, ok: true })
    return send(res, 200, {
      item: { id: itemId },
      status,
      fetchedAt: new Date().toISOString(),
    })
  }
  return fail(res, 404, 'not-found', `unknown mock route ${req.method ?? ''} ${route}`)
}

/**
 * Module-lifetime in-memory state, exposed for tests only. The e2e harness runs
 * one mock per process, so nothing else needs a reset; unit tests mount several
 * instances and use this to keep cases independent.
 */
export function __resetMockState() {
  workspaceBindings.clear()
  sessionBindings.clear()
  writeLog.length = 0
  statusByItemId.clear()
  for (const item of baseItems) statusByItemId.set(item.id, item.status ?? null)
}

export const name = 'github-projects-mock'

/** Wait for the HTTP carrier before registering the route (same as index.js). */
export const inject = ['webServer']

export function apply(ctx, config = {}) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return
  // v1.1.0: opt-in writes come from the overlay row config, exactly like the
  // real host's `allowWrites` (default false).
  const allowWrites = config?.allowWrites === true
  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/plugin/github-projects',
    handler: (req, res) => {
      handle(req, res, allowWrites).catch((error) => {
        try { fail(res, 500, 'internal', String(error?.message ?? error)) } catch { /* already closed */ }
      })
    },
  }), 'github-projects-mock: route')
}
