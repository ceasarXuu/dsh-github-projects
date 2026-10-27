/**
 * Contract-shaped MOCK host half for UI and e2e development.
 *
 * It serves exactly the HTTP contract in `docs/CONTRACT.md` from the captured
 * `gh` fixtures, with in-memory bindings, so the browser half can be developed
 * and screenshotted without the real `gh` CLI.
 *
 * Load it through a `--patch` overlay row whose `name` is the absolute path of
 * this file; the client bundle is still served from this package because the
 * nearest `package.json` carries the `dsh.client` declaration.
 */

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
]

const projects = (projectList.projects ?? []).map(projectOf)
const issue = issueOf(issueFixture, commentFixtures)

function health() {
  return { available: true, version: 'gh version 2.96.0 (mock)', account: 'ceasarXuu', error: null }
}

function configFor(sessionId, workspaceId) {
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

async function handle(req, res, config) {
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
    return send(res, 200, configFor(sessionId, workspaceId))
  }
  if (req.method === 'GET' && route === '/projects') {
    await delay(180)
    return send(res, 200, {
      owners: [{ login: 'ceasarXuu', type: 'user' }, { login: 'XuyuTech', type: 'organization' }],
      projects,
      fetchedAt: new Date().toISOString(),
      errors: [],
    })
  }
  if (req.method === 'GET' && route === '/items') {
    await delay(220)
    const owner = query.get('owner') ?? projects[0]?.owner ?? ''
    const number = Number(query.get('number') ?? projects[0]?.number ?? 0)
    const project = projects.find(item => item.number === number && item.owner === owner) ?? projects[0]
    return send(res, 200, {
      project,
      items: [...(itemList.items ?? []).map(itemOf), ...syntheticItems],
      fetchedAt: new Date().toISOString(),
      truncated: (itemList.totalCount ?? 0) > (itemList.items ?? []).length,
    })
  }
  if (req.method === 'GET' && route === '/issue') {
    await delay(220)
    return send(res, 200, { issue, fetchedAt: new Date().toISOString() })
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
  return fail(res, 404, 'not-found', `unknown mock route ${req.method ?? ''} ${route}`)
}

export const name = 'github-projects-mock'

/** Wait for the HTTP carrier before registering the route (same as index.js). */
export const inject = ['webServer']

export function apply(ctx, config = {}) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return
  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/plugin/github-projects',
    handler: (req, res) => {
      handle(req, res, config).catch((error) => {
        try { fail(res, 500, 'internal', String(error?.message ?? error)) } catch { /* already closed */ }
      })
    },
  }), 'github-projects-mock: route')
}
