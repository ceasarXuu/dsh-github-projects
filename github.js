/**
 * `gh` CLI adapter for the `github-projects` host plugin (contract §3.2/§3.5).
 *
 * Every read is one or more `gh` child processes: there is no HTTP client and
 * no credential handling here — `gh` owns authentication. The runner is
 * injectable so tests never spawn a process; the default runner uses
 * `child_process.execFile` with a configurable command, timeout, and output
 * cap (32 MiB). Non-zero exits are classified into the contract error codes
 * (`gh-missing`, `gh-auth`, `gh-failed`, `timeout`) and never leak stdout
 * bodies into error messages.
 *
 * Read path (v0.4.0, contract §3.5):
 * - Projects: exactly ONE `gh api graphql` call for the viewer and its
 *   organizations; closed Projects are dropped and partial GraphQL errors are
 *   preserved per owner.
 * - Project items: `gh api graphql` paginated 100 nodes per page, status /
 *   milestone / labels / content from the same payload, no `gh project view`.
 * - Issue detail: REST (`gh api repos/.../issues/N` + comments) as before.
 *
 * Normalizers map captured `gh` JSON payloads onto the exact wire types of
 * contract §3.1. They are exported so unit tests can drive them from
 * `test/fixtures/*` without a process.
 *
 * Plain ESM, `node:*` builtins only.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/* ------------------------------------------------------------------ */
/* 1. Bounds shared by the adapter and the HTTP layer.                 */
/* ------------------------------------------------------------------ */

export const DEFAULT_GH_COMMAND = 'gh'
export const DEFAULT_TIMEOUT_MS = 20_000
export const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024
export const DEFAULT_MAX_COMMENTS = 30
export const DEFAULT_MAX_PROJECT_ITEMS = 200
/** Issue bodies larger than this are cut by the host (`bodyTruncated`). */
export const MAX_ISSUE_BODY_CHARS = 100_000
/** `shortDescription` is truncated to this many characters. */
export const MAX_DESCRIPTION_CHARS = 500

const execFileAsync = promisify(execFile)

/* ------------------------------------------------------------------ */
/* 2. Errors and classification.                                       */
/* ------------------------------------------------------------------ */

/**
 * Stable adapter error: `code` is one of the contract error codes, `message`
 * is a short human message safe to put into a JSON error envelope.
 */
export class GhError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'GhError'
    this.code = code
  }
}

/** stderr markers `gh` prints when the CLI is not authenticated. */
const AUTH_PATTERN = /auth login|authenticate|authentication|not logged in|no oauth token|invalid token|\b401\b/i

/** `gh api` 404 markers for GitHub REST reads. */
const NOT_FOUND_PATTERN = /http 404|\b404\b|not found/i

/** v1.1.0 GraphQL write errors for a missing ProjectV2Item / node. */
const NODE_NOT_FOUND_PATTERN = /could not resolve to a node|does not exist|no node with id|not found/i

/** v1.1.0 GraphQL write errors caused by a missing `project`/`repo` scope. */
const WRITE_SCOPE_PATTERN = /scope|permission|forbidden|not accessible|unauthorized|not authorized/i

/** Hint appended to `gh-auth` write failures (contract §3.1 v1.1.0). */
const PROJECT_SCOPE_HINT = 'GitHub CLI 令牌缺少 project 权限，请运行 gh auth refresh -s project'

function lastChars(text, max) {
  const value = typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : ''
  return value.length <= max ? value : value.slice(-max)
}

/**
 * Map one failed `gh` invocation onto a `GhError`.
 * The message keeps at most the last 500 characters of stderr; stdout (which
 * can carry issue bodies or tokens in odd setups) is never included.
 */
export function classifyGhError(error) {
  if (error instanceof GhError) return error
  const stderr = typeof error?.stderr === 'string' ? error.stderr : ''
  const tail = lastChars(stderr, 500)
  if (error?.code === 'ENOENT') {
    return new GhError(
      'gh-missing',
      '找不到 GitHub CLI（gh），请先安装并确保它在 PATH 中',
    )
  }
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return new GhError('gh-failed', `gh 输出超过上限（${tail || 'maxBuffer'}）`)
  }
  if (error?.code === 'ETIMEDOUT' || error?.code === 'ABORT_ERR' || error?.killed === true) {
    return new GhError('timeout', `调用 gh 超时${tail === '' ? '' : `：${tail}`}`)
  }
  if (AUTH_PATTERN.test(stderr)) {
    return new GhError('gh-auth', `GitHub CLI 未登录或凭据失效，请运行 gh auth login${tail === '' ? '' : `（${tail}）`}`)
  }
  const exit = Number.isInteger(error?.code) ? `退出码 ${error.code}` : '未知退出码'
  return new GhError('gh-failed', `gh 调用失败（${exit}）${tail === '' ? '' : `：${tail}`}`)
}

/** Translate a classified gh 404 into the domain-specific 404 codes. */
function asIssueNotFound(error) {
  const classified = classifyGhError(error)
  if (classified.code !== 'gh-failed') return classified
  if (!NOT_FOUND_PATTERN.test(classified.message)) return classified
  return new GhError('issue-not-found', '找不到该 Issue（或无权访问）')
}

/* ------------------------------------------------------------------ */
/* 3. Bounded primitive parsers.                                       */
/* ------------------------------------------------------------------ */

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedInt(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/** `owner` / `repo` path segment accepted by GitHub (and by this host). */
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u
const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/u
const ISSUE_NUMBER_PATTERN = /^[1-9]\d{0,9}$/u

function validRepoPath(owner, name) {
  if (!OWNER_PATTERN.test(owner)) return null
  if (!REPO_NAME_PATTERN.test(name)) return null
  if (name === '.' || name === '..') return null
  return { repo: `${owner}/${name}`, owner, name }
}

/** Validate a `owner/name` path parameter (never a URL, never traversal). */
export function parseRepoParam(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text.length === 0 || text.length > 140) return null
  const slash = text.indexOf('/')
  if (slash <= 0 || slash !== text.lastIndexOf('/')) return null
  return validRepoPath(text.slice(0, slash), text.slice(slash + 1))
}

/** Validate an owner login parameter (user or organization). */
export function parseOwnerParam(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text.length === 0 || text.length > 39) return null
  return OWNER_PATTERN.test(text) ? text : null
}

function toPositiveInt(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 && value <= 1e9 ? value : null
  if (typeof value === 'string' && ISSUE_NUMBER_PATTERN.test(value.trim())) return Number(value.trim())
  return null
}

/** Validate a positive Issue/Project number from a query string or JSON body. */
export function parsePositiveInt(value) {
  return toPositiveInt(value)
}

/* ------------------------------------------------------------------ */
/* 4. `parseIssueRef` — pasted Issue references.                       */
/* ------------------------------------------------------------------ */

/**
 * Parse an Issue reference pasted by the user.
 *
 * Accepted: `https://github.com/<owner>/<repo>/issues/<n>` (also `http`,
 * `www`, bare `github.com/...`, trailing slash/query/hash), `owner/repo#123`,
 * and `owner/repo 123`. Returns `{ repo, number }` or `null`; never throws.
 */
export function parseIssueRef(text) {
  if (typeof text !== 'string') return null
  const value = text.trim()
  if (value.length === 0 || value.length > 500) return null

  const looksAbsolute = /^[a-z][a-z0-9+.-]*:\/\//iu.test(value)
  const looksBareGithub = /^(?:www\.)?github\.com\//iu.test(value)
  if (looksAbsolute || looksBareGithub) {
    let url
    try {
      url = new URL(looksAbsolute ? value : `https://${value}`)
    } catch {
      return null
    }
    const host = url.hostname.toLowerCase()
    if (host !== 'github.com' && host !== 'www.github.com') return null
    const match = /^\/([^/]+)\/([^/]+)\/issues\/([1-9]\d*)\/?$/u.exec(url.pathname)
    if (match === null) return null
    const number = Number(match[3])
    if (!Number.isSafeInteger(number) || number > 1e9) return null
    const ref = validRepoPath(match[1], match[2])
    return ref === null ? null : { repo: ref.repo, number }
  }

  const hashForm = /^([^/\s#]+)\/([^/\s#]+)#([1-9]\d{0,9})$/u.exec(value)
  if (hashForm !== null) {
    const ref = validRepoPath(hashForm[1], hashForm[2])
    const number = Number(hashForm[3])
    return ref === null || !Number.isSafeInteger(number) || number > 1e9 ? null : { repo: ref.repo, number }
  }

  const spaceForm = /^([^/\s]+)\/([^/\s]+)\s+([1-9]\d{0,9})$/u.exec(value)
  if (spaceForm !== null) {
    const ref = validRepoPath(spaceForm[1], spaceForm[2])
    const number = Number(spaceForm[3])
    return ref === null || !Number.isSafeInteger(number) || number > 1e9 ? null : { repo: ref.repo, number }
  }

  return null
}

/* ------------------------------------------------------------------ */
/* 5. Normalizers — wire types of contract §3.1.                       */
/* ------------------------------------------------------------------ */

function truncateChars(value, max) {
  const text = typeof value === 'string'
    ? value
    : value === null || value === undefined ? '' : String(value)
  if (text.length <= max) return { text, truncated: false }
  const points = Array.from(text)
  if (points.length <= max) return { text, truncated: false }
  return { text: points.slice(0, max).join(''), truncated: true }
}

function httpUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : null
  } catch {
    return null
  }
}

function ownerTypeOf(value) {
  const text = typeof value === 'string' ? value.toLowerCase() : ''
  return text === 'organization' || text === 'org' ? 'organization' : 'user'
}

/** One `gh project list` / `gh project view` entry → contract `Project`. */
export function normalizeProject(raw) {
  const source = isRecord(raw) ? raw : {}
  const owner = isRecord(source.owner) ? source.owner : null
  const login = owner !== null && typeof owner.login === 'string'
    ? owner.login
    : typeof source.owner === 'string' ? source.owner : ''
  const items = isRecord(source.items) ? source.items : null
  const itemCount = items !== null && Number.isInteger(items.totalCount) && items.totalCount >= 0
    ? items.totalCount
    : null
  const description = typeof source.shortDescription === 'string'
    ? truncateChars(source.shortDescription, MAX_DESCRIPTION_CHARS).text
    : null
  const number = Number.isInteger(source.number) && source.number > 0 ? source.number : 0
  return {
    owner: login,
    ownerType: ownerTypeOf(owner?.type ?? source.ownerType),
    number,
    title: typeof source.title === 'string' ? source.title : '',
    url: httpUrl(source.url),
    itemCount,
    closed: source.closed === true,
    description: description === '' ? null : description,
  }
}

/** Derive `owner/name` from a github.com repository URL. */
function repoFromHtmlUrl(value) {
  if (typeof value !== 'string') return null
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/u.exec(value.trim())
  if (match === null) return null
  return validRepoPath(match[1], match[2])?.repo ?? null
}

const ITEM_TYPE_BY_CONTENT = new Map([
  ['issue', 'issue'],
  ['pullrequest', 'pr'],
  ['draftissue', 'draft'],
])

/** One `gh project item-list` entry → contract `ProjectItem`. */
export function normalizeProjectItem(raw) {
  const source = isRecord(raw) ? raw : {}
  const content = isRecord(source.content) ? source.content : {}
  const contentText = typeof content.type === 'string' ? content.type.toLowerCase() : ''
  const type = ITEM_TYPE_BY_CONTENT.get(contentText) ?? 'draft'
  const contentRepo = typeof content.repository === 'string' ? content.repository : null
  const repo = contentRepo !== null && contentRepo.includes('/')
    ? contentRepo
    : repoFromHtmlUrl(source.repository)
  const milestoneRaw = source.milestone
  const milestone = typeof milestoneRaw === 'string'
    ? (milestoneRaw === '' ? null : milestoneRaw)
    : isRecord(milestoneRaw) && typeof milestoneRaw.title === 'string' && milestoneRaw.title !== ''
      ? milestoneRaw.title
      : null
  const labels = Array.isArray(source.labels)
    ? source.labels
      .map(label => (typeof label === 'string' ? label : isRecord(label) && typeof label.name === 'string' ? label.name : null))
      .filter(label => typeof label === 'string' && label.length > 0)
    : []
  const number = Number.isInteger(content.number) && content.number > 0 ? content.number : null
  const state = typeof content.state === 'string' ? content.state.toUpperCase() : null
  const normalizedState = state === 'OPEN' || state === 'CLOSED' || state === 'MERGED' ? state : null
  return {
    id: source.id === undefined || source.id === null ? '' : String(source.id),
    type,
    number,
    repo,
    title: typeof content.title === 'string'
      ? content.title
      : typeof source.title === 'string' ? source.title : '',
    url: httpUrl(content.url),
    state: normalizedState,
    status: typeof source.status === 'string' && source.status.length > 0 ? source.status : null,
    labels,
    milestone,
  }
}

function repoOfIssue(raw) {
  const html = typeof raw.html_url === 'string' ? raw.html_url : ''
  const fromHtml = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/\d+/u.exec(html)
  if (fromHtml !== null) return validRepoPath(fromHtml[1], fromHtml[2])?.repo ?? ''
  const api = typeof raw.repository_url === 'string' ? raw.repository_url : ''
  const fromApi = /\/repos\/([^/]+)\/([^/]+)\/?$/u.exec(api)
  if (fromApi !== null) return validRepoPath(fromApi[1], fromApi[2])?.repo ?? ''
  return ''
}

/** One REST comment entry → contract `IssueComment`. */
export function normalizeIssueComment(raw) {
  const source = isRecord(raw) ? raw : {}
  const author = isRecord(source.user) && typeof source.user.login === 'string' ? source.user.login : null
  return {
    id: source.id === undefined || source.id === null ? '' : String(source.id),
    author,
    createdAt: typeof source.created_at === 'string' ? source.created_at : '',
    body: typeof source.body === 'string' ? source.body : '',
    url: httpUrl(source.html_url),
  }
}

/**
 * One REST issue payload (+ its comments) → contract `IssueDetail`.
 * `options.repo`/`options.number` override the URL-derived identity so a
 * request always echoes the repo the caller asked for.
 */
export function normalizeIssue(raw, rawComments = [], options = {}) {
  const source = isRecord(raw) ? raw : {}
  const repo = typeof options.repo === 'string' && options.repo.length > 0 ? options.repo : repoOfIssue(source)
  const number = Number.isInteger(options.number) && options.number > 0
    ? options.number
    : Number.isInteger(source.number) && source.number > 0 ? source.number : 0
  const maxComments = boundedInt(options.maxComments, 1, 100, DEFAULT_MAX_COMMENTS)
  const maxBodyChars = boundedInt(options.maxBodyChars, 1_000, MAX_ISSUE_BODY_CHARS, MAX_ISSUE_BODY_CHARS)
  const url = httpUrl(source.html_url)
    ?? (repo === '' ? '' : `https://github.com/${repo}/issues/${String(number)}`)

  const comments = (Array.isArray(rawComments) ? rawComments : [])
    .map(normalizeIssueComment)
    .filter(comment => comment.id !== '')
    .sort((left, right) => {
      const leftTime = Date.parse(left.createdAt)
      const rightTime = Date.parse(right.createdAt)
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
        return leftTime - rightTime
      }
      return left.id.localeCompare(right.id)
    })
    .slice(0, maxComments)

  const commentCount = Number.isInteger(source.comments) && source.comments >= 0
    ? source.comments
    : comments.length
  const body = truncateChars(source.body, maxBodyChars)
  const author = isRecord(source.user) && typeof source.user.login === 'string' ? source.user.login : null
  const labels = Array.isArray(source.labels)
    ? source.labels
      .map(label => (typeof label === 'string' ? label : isRecord(label) && typeof label.name === 'string' ? label.name : null))
      .filter(label => typeof label === 'string' && label.length > 0)
    : []
  const assignees = Array.isArray(source.assignees)
    ? source.assignees
      .map(assignee => (typeof assignee === 'string' ? assignee : isRecord(assignee) && typeof assignee.login === 'string' ? assignee.login : null))
      .filter(login => typeof login === 'string' && login.length > 0)
    : []
  return {
    repo,
    number,
    title: typeof source.title === 'string' ? source.title : '',
    url,
    state: String(source.state ?? 'open').toLowerCase(),
    author,
    createdAt: typeof source.created_at === 'string' ? source.created_at : '',
    updatedAt: typeof source.updated_at === 'string' ? source.updated_at : '',
    labels,
    assignees,
    body: body.text,
    bodyTruncated: body.truncated,
    commentCount,
    comments,
    commentsTruncated: commentCount > comments.length,
  }
}

/** Contract `IssueSummary` from a detail (or a client-provided summary). */
export function toIssueSummary(issue) {
  return {
    repo: String(issue.repo ?? ''),
    number: Number(issue.number ?? 0),
    title: String(issue.title ?? ''),
    url: String(issue.url ?? ''),
    state: String(issue.state ?? 'open').toLowerCase(),
  }
}

/* ------------------------------------------------------------------ */
/* 5.5 GraphQL read path (v0.4.0).                                     */
/* ------------------------------------------------------------------ */

/**
 * One call for every accessible Project (contract §3.5): the viewer's own
 * Projects plus the Projects of every organization the viewer belongs to.
 * Mirrors `test/fixtures/queries/projects.graphql`.
 */
export const GRAPHQL_PROJECTS_QUERY = `query {
  viewer {
    login
    projectsV2(first: 100) {
      totalCount
      nodes { number title url closed shortDescription items { totalCount } }
    }
    organizations(first: 50) {
      nodes {
        login
        projectsV2(first: 100) {
          totalCount
          nodes { number title url closed shortDescription items { totalCount } }
        }
      }
    }
  }
}`

/**
 * One page of a Project's items plus the Project summary, mirroring
 * `test/fixtures/queries/items.graphql` (plus `closed`/`__typename` so the
 * `/items` response can carry the full `Project` without a second read).
 */
export const GRAPHQL_ITEMS_QUERY = `query($owner:String!,$number:Int!,$limit:Int!,$cursor:String){
  repositoryOwner(login:$owner){
    __typename
    ... on ProjectV2Owner {
      projectV2(number:$number){
        title
        url
        closed
        shortDescription
        items(first:$limit, after:$cursor){
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes{
            id
            fieldValues(first:20){ nodes{ ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } } } }
            content{
              __typename
              ... on Issue { number title url state repository { nameWithOwner } labels(first:10){ nodes{ name } } milestone { title } }
              ... on PullRequest { number title url state repository { nameWithOwner } labels(first:10){ nodes{ name } } milestone { title } }
              ... on DraftIssue { title }
            }
          }
        }
      }
    }
  }
}`

/**
 * v1.1.0 write-side metadata (contract §3.2): Project node id + the
 * single-select `Status` field id/options, in ONE read. Mirrors
 * `test/fixtures/queries/project-meta.graphql`.
 */
export const GRAPHQL_PROJECT_META_QUERY = `query($owner:String!,$number:Int!){
  repositoryOwner(login:$owner){
    __typename
    ... on ProjectV2Owner {
      projectV2(number:$number){
        id
        title
        field(name:"Status"){
          __typename
          ... on ProjectV2SingleSelectField {
            id
            name
            options { id name }
          }
        }
      }
    }
  }
}`

/** v1.1.0: set one Project item's `Status` single-select value. */
export const GRAPHQL_UPDATE_ITEM_STATUS_MUTATION = `mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$optionId:String!){
  updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId,value:{singleSelectOptionId:$optionId}}){
    projectV2Item { id }
  }
}`

/** v1.1.0: clear one Project item's `Status` field (`optionId: null`). */
export const GRAPHQL_CLEAR_ITEM_STATUS_MUTATION = `mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!){
  clearProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId}){
    projectV2Item { id }
  }
}`

/** Nodes of one GraphQL connection, tolerating a missing/`null` connection. */
function graphqlNodes(connection) {
  return isRecord(connection) && Array.isArray(connection.nodes) ? connection.nodes : []
}

/** First GraphQL error carrying a message, or null. */
function firstGraphqlError(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.errors)) return null
  for (const error of payload.errors) {
    if (isRecord(error) && typeof error.message === 'string' && error.message.length > 0) return error
  }
  return null
}

function graphqlErrorTail(payload) {
  const error = firstGraphqlError(payload)
  return error === null ? null : truncateChars(error.message, 300).text
}

/** Resolve the owner a partially-failed GraphQL error belongs to, best-effort. */
function ownerOfGraphqlError(payload, error) {
  const path = isRecord(error) && Array.isArray(error.path) ? error.path : []
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : null
  try {
    if (path[0] === 'viewer' && path[1] === 'organizations' && path[2] === 'nodes') {
      const index = Number(path[3])
      const node = Number.isInteger(index) ? graphqlNodes(data?.viewer?.organizations)[index] : undefined
      if (isRecord(node) && typeof node.login === 'string') return node.login
    }
    if (path[0] === 'viewer' && path[1] === 'projectsV2') {
      return typeof data?.viewer?.login === 'string' ? data.viewer.login : 'viewer'
    }
  } catch {
    /* fall through to the generic owner label */
  }
  return 'graphql'
}

/** GraphQL errors preserved as the contract's per-owner `errors` entries. */
function graphqlOwnerErrors(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.errors)) return []
  const errors = []
  for (const error of payload.errors) {
    if (!isRecord(error) || typeof error.message !== 'string' || error.message.length === 0) continue
    errors.push({
      owner: ownerOfGraphqlError(payload, error),
      code: 'gh-failed',
      message: truncateChars(error.message, 300).text,
    })
  }
  return errors
}

/** Owner type from the public Project URL (`/users/…` vs `/orgs/…`). */
export function ownerTypeFromProjectUrl(url) {
  if (typeof url === 'string') {
    if (/^https?:\/\/github\.com\/orgs\//u.test(url)) return 'organization'
    if (/^https?:\/\/github\.com\/users\//u.test(url)) return 'user'
  }
  return 'user'
}

/**
 * One GraphQL `ProjectV2` node → contract `Project`.
 * `context.owner`/`context.ownerType` come from the connection that returned it.
 */
export function normalizeGraphqlProject(raw, context = {}) {
  const source = isRecord(raw) ? raw : {}
  const owner = typeof context.owner === 'string' ? context.owner : ''
  const ownerType = context.ownerType === 'organization' ? 'organization' : 'user'
  const items = isRecord(source.items) ? source.items : null
  const itemCount = items !== null && Number.isInteger(items.totalCount) && items.totalCount >= 0
    ? items.totalCount
    : null
  const number = Number.isInteger(source.number) && source.number > 0
    ? source.number
    : Number.isInteger(context.number) && context.number > 0 ? context.number : 0
  const rawDescription = typeof source.shortDescription === 'string' ? source.shortDescription : ''
  return {
    owner,
    ownerType,
    number,
    title: typeof source.title === 'string' ? source.title : '',
    url: httpUrl(source.url),
    itemCount,
    closed: source.closed === true,
    description: rawDescription === '' ? null : truncateChars(rawDescription, MAX_DESCRIPTION_CHARS).text,
  }
}

/**
 * One GraphQL `ProjectV2Item` node → contract `ProjectItem`.
 * The Status value is the single-select field literally named `Status`.
 */
export function normalizeGraphqlItem(raw) {
  const source = isRecord(raw) ? raw : {}
  const content = isRecord(source.content) ? source.content : {}
  const typename = typeof content.__typename === 'string' ? content.__typename : ''
  const type = typename === 'PullRequest' ? 'pr' : typename === 'DraftIssue' ? 'draft' : 'issue'
  const repository = isRecord(content.repository) ? content.repository : null
  const repo = repository !== null
    && typeof repository.nameWithOwner === 'string'
    && repository.nameWithOwner.includes('/')
    ? repository.nameWithOwner
    : null
  const labels = isRecord(content.labels) && Array.isArray(content.labels.nodes)
    ? content.labels.nodes
      .map(label => (isRecord(label) && typeof label.name === 'string' && label.name.length > 0 ? label.name : null))
      .filter(name => name !== null)
    : []
  const milestone = isRecord(content.milestone)
    && typeof content.milestone.title === 'string'
    && content.milestone.title.length > 0
    ? content.milestone.title
    : null
  let status = null
  const fieldValues = isRecord(source.fieldValues) && Array.isArray(source.fieldValues.nodes)
    ? source.fieldValues.nodes
    : []
  for (const value of fieldValues) {
    if (!isRecord(value) || !isRecord(value.field)) continue
    if (value.field.name !== 'Status') continue
    if (typeof value.name === 'string' && value.name.length > 0) status = value.name
    break
  }
  const stateText = typeof content.state === 'string' ? content.state.toUpperCase() : null
  const state = stateText === 'OPEN' || stateText === 'CLOSED' || stateText === 'MERGED' ? stateText : null
  return {
    id: source.id === undefined || source.id === null ? '' : String(source.id),
    type,
    number: Number.isInteger(content.number) && content.number > 0 ? content.number : null,
    repo,
    title: typeof content.title === 'string' ? content.title : '',
    url: httpUrl(content.url),
    state,
    status,
    labels,
    milestone,
  }
}

/**
 * One GraphQL `ProjectV2` node from `GRAPHQL_PROJECT_META_QUERY` → the
 * `project` + `statusField` halves of contract `ProjectMeta` (v1.1.0).
 * `statusField` is `null` when the Project has no single-select `Status`
 * field (the adapter turns that into `gh-failed`, since writes cannot work).
 */
export function normalizeProjectMeta(raw, context = {}) {
  const source = isRecord(raw) ? raw : {}
  const owner = typeof context.owner === 'string' ? context.owner : ''
  const number = Number.isInteger(context.number) && context.number > 0 ? context.number : 0
  const field = isRecord(source.field) ? source.field : null
  const rawOptions = field !== null && Array.isArray(field.options) ? field.options : []
  const options = rawOptions
    .filter(option => isRecord(option) && typeof option.id === 'string' && option.id.length > 0)
    .map(option => ({
      id: option.id,
      name: typeof option.name === 'string' && option.name.length > 0 ? option.name : option.id,
    }))
  const statusField = field === null
    || typeof field.id !== 'string'
    || field.id.length === 0
    || options.length === 0
    ? null
    : {
        id: field.id,
        name: typeof field.name === 'string' && field.name.length > 0 ? field.name : 'Status',
        options,
      }
  return {
    project: {
      id: typeof source.id === 'string' ? source.id : '',
      owner,
      number,
      title: typeof source.title === 'string' ? source.title : '',
    },
    statusField,
  }
}

/* ------------------------------------------------------------------ */
/* 6. The adapter.                                                     */
/* ------------------------------------------------------------------ */

function createExecRunner({ ghCommand, timeoutMs, maxBuffer }) {
  return async (args) => {
    const result = await execFileAsync(ghCommand, args, {
      env: process.env,
      timeout: timeoutMs,
      maxBuffer,
      encoding: 'utf8',
      windowsHide: true,
    })
    return { stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
  }
}

/**
 * Create the `gh` adapter.
 *
 * @param {object} [options]
 * @param {string} [options.ghCommand] - executable to spawn (default `gh`).
 * @param {number} [options.timeoutMs] - one invocation deadline.
 * @param {number} [options.maxBuffer] - stdout/stderr byte cap.
 * @param {number} [options.maxComments] - comment page size cap.
 * @param {number} [options.maxProjectItems] - `--limit` for one item read.
 * @param {(args: string[]) => Promise<{stdout: string, stderr?: string} | string>} [options.run]
 *   injected runner for tests (must reject on non-zero exit like `execFile`).
 */
export function createGh(options = {}) {
  const settings = isRecord(options) ? options : {}
  const ghCommand = typeof settings.ghCommand === 'string' && settings.ghCommand.trim() !== ''
    ? settings.ghCommand.trim()
    : DEFAULT_GH_COMMAND
  const timeoutMs = boundedInt(settings.timeoutMs, 100, 600_000, DEFAULT_TIMEOUT_MS)
  const maxBuffer = boundedInt(settings.maxBuffer, 1024, 1024 * 1024 * 1024, DEFAULT_MAX_BUFFER)
  const maxComments = boundedInt(settings.maxComments, 1, 100, DEFAULT_MAX_COMMENTS)
  const maxProjectItems = boundedInt(settings.maxProjectItems, 1, 1_000, DEFAULT_MAX_PROJECT_ITEMS)
  const runner = typeof settings.run === 'function'
    ? settings.run
    : createExecRunner({ ghCommand, timeoutMs, maxBuffer })

  /** Run one gh invocation, normalizing the runner result shape. */
  async function exec(args) {
    let result
    try {
      result = await runner(args)
    } catch (error) {
      throw classifyGhError(error)
    }
    if (typeof result === 'string') return { stdout: result, stderr: '' }
    return {
      stdout: typeof result?.stdout === 'string' ? result.stdout : String(result?.stdout ?? ''),
      stderr: typeof result?.stderr === 'string' ? result.stderr : String(result?.stderr ?? ''),
    }
  }

  /** Run one gh invocation and parse stdout as JSON. */
  async function execJson(args) {
    const { stdout } = await exec(args)
    try {
      return JSON.parse(stdout)
    } catch {
      throw new GhError('gh-failed', `gh 返回了无法解析的 JSON（${args.join(' ')}）`)
    }
  }

  /** `gh --version` first line, e.g. `gh version 2.96.0 (2026-07-02)`. */
  async function versionText() {
    const { stdout } = await exec(['--version'])
    const line = stdout.split(/\r?\n/u).map(part => part.trim()).find(part => part.length > 0)
    return line ?? null
  }

  /** Authenticated account login. */
  async function accountLogin() {
    const { stdout } = await exec(['api', 'user', '--jq', '.login'])
    const login = stdout.trim()
    return login.length > 0 ? login : null
  }

  /**
   * `gh` availability: installed (version) and authenticated (account).
   * Never throws — the HTTP `/health` and `/config` routes need an answer even
   * when GitHub is unreachable.
   */
  async function health() {
    const [versionOutcome, accountOutcome] = await Promise.allSettled([versionText(), accountLogin()])
    const available = versionOutcome.status === 'fulfilled' && versionOutcome.value !== null
    let error = null
    if (versionOutcome.status === 'rejected') {
      error = lastChars(classifyGhError(versionOutcome.reason).message, 300)
    } else if (versionOutcome.value === null) {
      error = '无法读取 gh 版本信息'
    } else if (accountOutcome.status === 'rejected') {
      error = lastChars(classifyGhError(accountOutcome.reason).message, 300)
    } else if (accountOutcome.value === null) {
      error = '无法确定已登录的 GitHub 账号'
    }
    return {
      available,
      version: versionOutcome.status === 'fulfilled' ? versionOutcome.value : null,
      account: accountOutcome.status === 'fulfilled' ? accountOutcome.value : null,
      error,
    }
  }

  /**
   * One `gh api graphql` invocation.
   *
   * Variables use `-F` (typed): reads need it for `Int!` variables such as
   * `$number`/`$limit`. v1.1.0 mutations pass `rawStrings: true` and use `-f`
   * (raw string) instead, because `-F` infers all-digit values as JSON numbers
   * and a real Status option id such as Done (`98236657`) must arrive as the
   * GraphQL `String` argument `singleSelectOptionId`.
   */
  async function execGraphql(query, variables = {}, options = {}) {
    const rawStrings = isRecord(options) && options.rawStrings === true
    const args = ['api', 'graphql', '-f', `query=${query}`]
    for (const [key, value] of Object.entries(variables)) {
      if (value === undefined || value === null) continue
      args.push(rawStrings ? '-f' : '-F', `${key}=${String(value)}`)
    }
    return execJson(args)
  }

  /**
   * Every accessible Project grouped by owner (contract §3.5): ONE GraphQL
   * call for the viewer's Projects plus every organization's Projects.
   * Closed Projects are dropped; GraphQL errors that arrive beside a usable
   * payload are preserved as the per-owner `errors` array.
   */
  async function listProjects() {
    const payload = await execGraphql(GRAPHQL_PROJECTS_QUERY)
    const errors = graphqlOwnerErrors(payload)
    const data = isRecord(payload.data) ? payload.data : null
    const viewer = data !== null && isRecord(data.viewer) ? data.viewer : null
    if (viewer === null || typeof viewer.login !== 'string' || viewer.login.length === 0) {
      const tail = graphqlErrorTail(payload)
      throw new GhError('gh-failed', `GraphQL 响应缺少 viewer${tail === null ? '' : `：${tail}`}`)
    }
    const owners = [{ login: viewer.login, type: 'user' }]
    const projects = []
    const seenOwners = new Set([viewer.login.toLowerCase()])
    const appendProjects = (connection, owner, ownerType) => {
      for (const node of graphqlNodes(connection)) {
        const project = normalizeGraphqlProject(node, { owner, ownerType })
        if (project.number > 0 && project.closed === false) projects.push(project)
      }
    }
    appendProjects(viewer.projectsV2, viewer.login, 'user')
    for (const organization of graphqlNodes(viewer.organizations)) {
      if (!isRecord(organization) || typeof organization.login !== 'string' || organization.login.length === 0) continue
      if (seenOwners.has(organization.login.toLowerCase())) continue
      seenOwners.add(organization.login.toLowerCase())
      owners.push({ login: organization.login, type: 'organization' })
      appendProjects(organization.projectsV2, organization.login, 'organization')
    }
    return { owners, projects, errors }
  }

  function validateProjectRequest(owner, number) {
    const ownerLogin = parseOwnerParam(owner)
    if (ownerLogin === null) throw new GhError('bad-request', 'owner 参数无效')
    const projectNumber = toPositiveInt(number)
    if (projectNumber === null) throw new GhError('bad-request', 'number 参数无效')
    return { owner: ownerLogin, number: projectNumber }
  }

  /**
   * Page one Project's items (contract §3.5): `gh api graphql` at 100 nodes
   * per page until `totalCount`/`maxProjectItems`/`maxPages`. The Project
   * summary comes from the same payload (no second `gh project view` read).
   * `onItem` may return `true` to stop paging early (used by the v1.1.0
   * `findProjectItem` write-side helper).
   */
  async function paginateProjectItems(target, onItem) {
    const collected = []
    let project = null
    let totalCount = null
    let cursor = null
    let hasNextPage = true
    let pages = 0
    // Bound the loop independently of GitHub's pagination as a failure guard.
    const maxPages = 40
    while (hasNextPage && collected.length < maxProjectItems && pages < maxPages) {
      const limit = Math.max(1, Math.min(100, maxProjectItems - collected.length))
      const variables = { owner: target.owner, number: target.number, limit }
      if (cursor !== null) variables.cursor = cursor
      const payload = await execGraphql(GRAPHQL_ITEMS_QUERY, variables)
      pages += 1
      const data = isRecord(payload.data) ? payload.data : null
      const ownerNode = data !== null && isRecord(data.repositoryOwner) ? data.repositoryOwner : null
      const projectNode = ownerNode !== null && isRecord(ownerNode.projectV2) ? ownerNode.projectV2 : null
      if (projectNode === null || projectNode === undefined) {
        const tail = graphqlErrorTail(payload)
        throw new GhError('project-not-found', `找不到该 Project（或无权访问）${tail === null ? '' : `：${tail}`}`)
      }
      if (project === null) {
        const typename = typeof ownerNode.__typename === 'string' ? ownerNode.__typename.toLowerCase() : ''
        const ownerType = typename === 'organization' || typename === 'user'
          ? typename
          : ownerTypeFromProjectUrl(projectNode.url)
        project = normalizeGraphqlProject(projectNode, { owner: target.owner, ownerType, number: target.number })
      }
      const itemsNode = isRecord(projectNode.items) ? projectNode.items : null
      if (itemsNode === null) throw new GhError('gh-failed', 'GraphQL 响应缺少 items')
      if (Number.isInteger(itemsNode.totalCount) && itemsNode.totalCount >= 0) totalCount = itemsNode.totalCount
      for (const node of graphqlNodes(itemsNode)) {
        const item = normalizeGraphqlItem(node)
        collected.push(item)
        if (typeof onItem === 'function' && onItem(item, project) === true) {
          return { project, totalCount, items: collected, stopped: true }
        }
      }
      const pageInfo = isRecord(itemsNode.pageInfo) ? itemsNode.pageInfo : null
      hasNextPage = pageInfo !== null
        && pageInfo.hasNextPage === true
        && typeof pageInfo.endCursor === 'string'
        && pageInfo.endCursor.length > 0
        && collected.length < maxProjectItems
      cursor = hasNextPage ? pageInfo.endCursor : null
    }
    return { project, totalCount, items: collected, stopped: false }
  }

  /**
   * One Project's items (contract §3.5) via paginated GraphQL, 100 nodes per
   * page, stopping at `totalCount`/`maxProjectItems`.
   */
  async function projectItems(owner, number) {
    const target = validateProjectRequest(owner, number)
    const result = await paginateProjectItems(target)
    const items = result.items.slice(0, maxProjectItems)
    const total = result.totalCount === null ? items.length : result.totalCount
    return {
      project: result.project ?? {
        owner: target.owner,
        ownerType: 'user',
        number: target.number,
        title: '',
        url: null,
        itemCount: null,
        closed: false,
        description: null,
      },
      items,
      truncated: total > items.length,
    }
  }

  /**
   * Locate one Project item by predicate, paging the §3.5 items query and
   * stopping as soon as a node matches. Returns the normalized item or `null`.
   */
  async function locateProjectItem(owner, number, predicate) {
    const target = validateProjectRequest(owner, number)
    let found = null
    await paginateProjectItems(target, (item) => {
      if (predicate(item) === true) {
        found = item
        return true
      }
      return false
    })
    return found
  }

  /**
   * v1.1.0 (contract §3.2): resolve a content reference (`owner/name#N`) to
   * its `ProjectV2Item` node, paging the same items query as §3.5.
   * Not found → `item-not-found`.
   */
  async function findProjectItem(owner, number, repo, contentNumber) {
    const parsedRepo = parseRepoParam(repo)
    if (parsedRepo === null) throw new GhError('bad-request', 'repo 必须是 owner/name')
    const content = toPositiveInt(contentNumber)
    if (content === null) throw new GhError('bad-request', 'number 参数无效')
    const wantedRepo = parsedRepo.repo.toLowerCase()
    const item = await locateProjectItem(owner, number, candidate => (
      typeof candidate.repo === 'string'
      && candidate.repo.toLowerCase() === wantedRepo
      && candidate.number === content
    ))
    if (item === null) {
      throw new GhError('item-not-found', `Project 中没有 ${parsedRepo.repo}#${String(content)}`)
    }
    return item
  }

  /**
   * v1.1.0: locate one item by its `ProjectV2Item` node id (the agent tool's
   * direct `itemId` form), using the same paginated items read.
   */
  async function findProjectItemById(owner, number, itemId) {
    const id = typeof itemId === 'string' ? itemId.trim() : ''
    if (!id.startsWith('PVTI_') || id.length > 200) {
      throw new GhError('bad-request', 'itemId 必须是 ProjectV2Item 节点 id（PVTI_ 开头）')
    }
    const item = await locateProjectItem(owner, number, candidate => candidate.id === id)
    if (item === null) throw new GhError('item-not-found', `Project 中没有条目 ${id}`)
    return item
  }

  /**
   * One Project's write-side metadata (contract §3.2): Project node id plus
   * the single-select `Status` field id/options, from ONE GraphQL read.
   * A missing/unauthorized Project → `project-not-found`.
   */
  async function getProjectMeta(owner, number) {
    const target = validateProjectRequest(owner, number)
    const payload = await execGraphql(GRAPHQL_PROJECT_META_QUERY, {
      owner: target.owner,
      number: target.number,
    })
    const data = isRecord(payload.data) ? payload.data : null
    const ownerNode = data !== null && isRecord(data.repositoryOwner) ? data.repositoryOwner : null
    const projectNode = ownerNode !== null && isRecord(ownerNode.projectV2) ? ownerNode.projectV2 : null
    if (projectNode === null) {
      const tail = graphqlErrorTail(payload)
      throw new GhError('project-not-found', `找不到该 Project（或无权访问）${tail === null ? '' : `：${tail}`}`)
    }
    const meta = normalizeProjectMeta(projectNode, { owner: target.owner, number: target.number })
    if (meta.project.id === '') throw new GhError('gh-failed', 'GraphQL 响应缺少 Project id')
    if (meta.statusField === null) {
      throw new GhError('gh-failed', '该 Project 没有名为 Status 的单选字段，无法修改状态')
    }
    return meta
  }

  /**
   * Classify one failed mutation (thrown by the runner or carried in a
   * GraphQL `errors` array) into the contract write error codes (v1.1.0):
   * `item-not-found` for a stale/deleted item id, `gh-auth` with the
   * `gh auth refresh -s project` hint for missing scopes/permissions.
   */
  function asWriteError(error) {
    const classified = classifyGhError(error)
    const text = classified.message
    if (NODE_NOT_FOUND_PATTERN.test(text)) {
      return new GhError('item-not-found', '找不到该 Project 条目（或无权访问）')
    }
    if (classified.code === 'gh-auth') {
      return new GhError('gh-auth', `${classified.message}；${PROJECT_SCOPE_HINT}`)
    }
    if (WRITE_SCOPE_PATTERN.test(text)) {
      const tail = lastChars(text, 300)
      return new GhError('gh-auth', `${PROJECT_SCOPE_HINT}（${tail}）`)
    }
    return classified
  }

  /**
   * v1.1.0 (contract §3.2): the ONLY GitHub write. Moves one Project item's
   * `Status` single-select value through `gh api graphql`
   * (`updateProjectV2ItemFieldValue`; `optionId: null` clears the field via
   * `clearProjectV2ItemFieldValue`). The adapter itself fetches the Project
   * metadata the mutation needs, so callers only pass ids. Returns the applied
   * `{ item: { id }, status: { optionId, name } }` (`name` null when cleared).
   * Never reads tokens; scopes stay owned by `gh`.
   */
  async function updateItemStatus(input) {
    const settings = isRecord(input) ? input : {}
    const target = validateProjectRequest(settings.owner, settings.number)
    const itemId = typeof settings.itemId === 'string' ? settings.itemId.trim() : ''
    if (!itemId.startsWith('PVTI_') || itemId.length > 200) {
      throw new GhError('bad-request', 'itemId 必须是 ProjectV2Item 节点 id（PVTI_ 开头）')
    }
    let optionId = null
    if (settings.optionId !== null && settings.optionId !== undefined) {
      if (typeof settings.optionId !== 'string' || settings.optionId.trim() === '') {
        throw new GhError('bad-request', 'optionId 必须是非空字符串或 null')
      }
      optionId = settings.optionId.trim()
    }
    const meta = await getProjectMeta(target.owner, target.number)
    const option = optionId === null
      ? null
      : meta.statusField.options.find(entry => entry.id === optionId) ?? null
    if (optionId !== null && option === null) {
      const valid = meta.statusField.options.map(entry => `${entry.id}=${entry.name}`).join(', ')
      throw new GhError('bad-request', `未知的 Status 选项 id：${optionId}（可选：${valid}）`)
    }
    const variables = { projectId: meta.project.id, itemId, fieldId: meta.statusField.id }
    let payload
    try {
      // Raw strings: all mutation variables are GraphQL String/ID values, and
      // `-f` keeps an all-digit option id (Done `98236657`) a string.
      payload = option === null
        ? await execGraphql(GRAPHQL_CLEAR_ITEM_STATUS_MUTATION, variables, { rawStrings: true })
        : await execGraphql(
          GRAPHQL_UPDATE_ITEM_STATUS_MUTATION,
          { ...variables, optionId: option.id },
          { rawStrings: true },
        )
    } catch (error) {
      throw asWriteError(error)
    }
    const graphqlError = firstGraphqlError(payload)
    if (graphqlError !== null) throw asWriteError(new GhError('gh-failed', String(graphqlError.message)))
    const data = isRecord(payload.data) ? payload.data : null
    const mutated = data !== null && isRecord(data.updateProjectV2ItemFieldValue)
      ? data.updateProjectV2ItemFieldValue
      : data !== null && isRecord(data.clearProjectV2ItemFieldValue)
        ? data.clearProjectV2ItemFieldValue
        : null
    if (mutated === null) throw new GhError('gh-failed', 'GraphQL 写入响应缺少 mutation 结果')
    return {
      item: { id: itemId },
      status: option === null
        ? { optionId: null, name: null }
        : { optionId: option.id, name: option.name },
    }
  }

  function validateIssueRequest(repo, number) {
    const parsed = parseRepoParam(repo)
    if (parsed === null) throw new GhError('bad-request', 'repo 必须是 owner/name')
    const issueNumber = toPositiveInt(number)
    if (issueNumber === null) throw new GhError('bad-request', 'number 参数无效')
    return { repo: parsed.repo, number: issueNumber }
  }

  /**
   * One Issue with its comment page (contract §3.2 query 4).
   * REST is the contract; a PR number resolves to the issue endpoint with a
   * `pull_request` field and is rejected as `issue-not-found`.
   */
  async function getIssue(repo, number) {
    const target = validateIssueRequest(repo, number)
    let raw
    try {
      raw = await execJson(['api', `repos/${target.repo}/issues/${String(target.number)}`])
    } catch (error) {
      throw asIssueNotFound(error)
    }
    if (!isRecord(raw)) throw new GhError('gh-failed', 'gh api 返回了非对象 JSON')
    if (raw.pull_request !== undefined && raw.pull_request !== null) {
      throw new GhError('issue-not-found', '这是 Pull Request')
    }
    let rawComments
    try {
      rawComments = await execJson([
        'api',
        `repos/${target.repo}/issues/${String(target.number)}/comments?per_page=${String(maxComments)}`,
      ])
    } catch (error) {
      throw asIssueNotFound(error)
    }
    return {
      issue: normalizeIssue(raw, rawComments, {
        repo: target.repo,
        number: target.number,
        maxComments,
        maxBodyChars: MAX_ISSUE_BODY_CHARS,
      }),
    }
  }

  /**
   * Resolve a pasted Issue reference to a summary (for `POST /bind-issue`).
   * Returns `null` for a reference that cannot be parsed; throws contract
   * errors for a parseable reference GitHub cannot find/authorize.
   */
  async function resolveIssueRef(ref) {
    const parsed = parseIssueRef(ref)
    if (parsed === null) return null
    const { issue } = await getIssue(parsed.repo, parsed.number)
    return { ref: parsed, summary: toIssueSummary(issue) }
  }

  return {
    health,
    listProjects,
    projectItems,
    getIssue,
    resolveIssueRef,
    // v1.1.0 write path (only reached through `allowWrites: true`).
    getProjectMeta,
    findProjectItem,
    findProjectItemById,
    updateItemStatus,
    maxComments,
    maxProjectItems,
    config: { ghCommand, timeoutMs, maxBuffer },
  }
}

/* Re-export the bounded int helper for the HTTP layer's config resolution. */
export { boundedInt }
