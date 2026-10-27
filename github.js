/**
 * `gh` CLI adapter for the `github-projects` host plugin (contract §3.2).
 *
 * Every read is one or more `gh` child processes: there is no HTTP client and
 * no credential handling here — `gh` owns authentication. The runner is
 * injectable so tests never spawn a process; the default runner uses
 * `child_process.execFile` with a configurable command, timeout, and output
 * cap (32 MiB). Non-zero exits are classified into the contract error codes
 * (`gh-missing`, `gh-auth`, `gh-failed`, `timeout`) and never leak stdout
 * bodies into error messages.
 *
 * Normalizers map the captured `gh` JSON payloads onto the exact wire types of
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

/** GraphQL 404 markers for Projects v2 reads. */
const PROJECT_NOT_FOUND_PATTERN = /could not resolve to a projectv2|could not find project|no project with number|project .* not found/i

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

function asProjectNotFound(error) {
  const classified = classifyGhError(error)
  if (classified.code !== 'gh-failed') return classified
  if (!PROJECT_NOT_FOUND_PATTERN.test(classified.message) && !NOT_FOUND_PATTERN.test(classified.message)) {
    return classified
  }
  return new GhError('project-not-found', '找不到该 Project（或无权访问）')
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

  /** Owner logins of the authenticated account's organizations. */
  async function organizationLogins() {
    const parsed = await execJson(['api', 'user/orgs', '--jq', '[.[].login]'])
    if (!Array.isArray(parsed)) throw new GhError('gh-failed', 'gh api user/orgs 返回了非数组 JSON')
    const logins = []
    const seen = new Set()
    for (const value of parsed) {
      if (typeof value !== 'string' || value.length === 0) continue
      const lowered = value.toLowerCase()
      if (seen.has(lowered)) continue
      seen.add(lowered)
      logins.push(value)
    }
    return logins
  }

  /**
   * Every accessible Project grouped by owner (contract §3.2 query 2).
   * The current user is always listed first; an owner whose project listing
   * fails contributes to `errors` instead of failing the whole response.
   */
  async function listProjects() {
    const login = await accountLogin()
    if (typeof login !== 'string' || login.length === 0) {
      throw new GhError('gh-failed', '无法确定已登录的 GitHub 账号')
    }
    const owners = [{ login, type: 'user' }]
    const errors = []
    try {
      for (const org of await organizationLogins()) {
        if (org.toLowerCase() === login.toLowerCase()) continue
        owners.push({ login: org, type: 'organization' })
      }
    } catch (error) {
      const classified = classifyGhError(error)
      // Missing CLI / broken credentials fail the whole read; anything else is
      // reported per owner and the user's own projects remain usable.
      if (classified.code === 'gh-missing' || classified.code === 'gh-auth' || classified.code === 'timeout') {
        throw classified
      }
      errors.push({ owner: 'user/orgs', code: classified.code, message: classified.message })
    }

    const results = await Promise.all(owners.map(async (owner) => {
      try {
        const parsed = await execJson([
          'project', 'list',
          '--owner', owner.login,
          '--format', 'json',
          '--limit', '100',
        ])
        const rawProjects = Array.isArray(parsed?.projects) ? parsed.projects : []
        const projects = rawProjects
          .map(normalizeProject)
          .filter(project => project.number > 0 && project.owner !== '')
        return { projects, error: null }
      } catch (error) {
        const classified = classifyGhError(error)
        return {
          projects: [],
          error: { owner: owner.login, code: classified.code, message: classified.message },
        }
      }
    }))

    const projects = []
    for (const result of results) {
      projects.push(...result.projects)
      if (result.error !== null) errors.push(result.error)
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
   * One Project's items (contract §3.2 query 3) plus the Project summary the
   * `/items` wire object carries. `gh project item-list` does not echo the
   * project metadata, so `gh project view` supplies it.
   */
  async function projectItems(owner, number) {
    const project = validateProjectRequest(owner, number)
    const [itemsOutcome, projectOutcome] = await Promise.allSettled([
      execJson([
        'project', 'item-list', String(project.number),
        '--owner', project.owner,
        '--format', 'json',
        '--limit', String(maxProjectItems),
      ]),
      execJson(['project', 'view', String(project.number), '--owner', project.owner, '--format', 'json']),
    ])
    if (itemsOutcome.status === 'rejected') throw asProjectNotFound(itemsOutcome.reason)
    if (projectOutcome.status === 'rejected') throw asProjectNotFound(projectOutcome.reason)
    const parsedItems = itemsOutcome.value
    const rawItems = Array.isArray(parsedItems?.items) ? parsedItems.items : []
    const items = rawItems.map(normalizeProjectItem)
    const totalCount = Number.isInteger(parsedItems?.totalCount) && parsedItems.totalCount >= 0
      ? parsedItems.totalCount
      : items.length
    return {
      project: normalizeProject(projectOutcome.value),
      items,
      truncated: totalCount > items.length,
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
    maxComments,
    maxProjectItems,
    config: { ghCommand, timeoutMs, maxBuffer },
  }
}

/* Re-export the bounded int helper for the HTTP layer's config resolution. */
export { boundedInt }
