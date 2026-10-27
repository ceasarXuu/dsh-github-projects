/**
 * Unit tests for `github.js` — the `gh` adapter, normalizers, and ref parser
 * (contract §3.2). All `gh` invocations are fake runners or tiny local shell
 * scripts; nothing reaches GitHub or the network.
 */

import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  createGh,
  classifyGhError,
  normalizeGraphqlItem,
  normalizeGraphqlProject,
  normalizeIssue,
  normalizeIssueComment,
  normalizeProject,
  normalizeProjectItem,
  ownerTypeFromProjectUrl,
  parseIssueRef,
  parseOwnerParam,
  parsePositiveInt,
  parseRepoParam,
  toIssueSummary,
} from '../../github.js'
import {
  createRunner,
  fixture,
  fixtureRun,
  fixtureRunner,
  ghAuthError,
  ghError,
  ghMissingError,
  ghNotFound,
  ghTimeoutError,
} from './support.mjs'

const REPO = 'ceasarXuu/Astropath'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'ghp-gh-'))
}

/* ------------------------------------------------------------------ */
/* parseIssueRef                                                       */
/* ------------------------------------------------------------------ */

test('parseIssueRef accepts the documented reference forms', () => {
  const cases = [
    ['https://github.com/ceasarXuu/Astropath/issues/240', { repo: REPO, number: 240 }],
    ['http://github.com/ceasarXuu/Astropath/issues/240', { repo: REPO, number: 240 }],
    ['https://www.github.com/ceasarXuu/Astropath/issues/240/', { repo: REPO, number: 240 }],
    ['https://github.com/ceasarXuu/Astropath/issues/240?foo=1', { repo: REPO, number: 240 }],
    ['https://github.com/ceasarXuu/Astropath/issues/240#issuecomment-1', { repo: REPO, number: 240 }],
    ['github.com/ceasarXuu/Astropath/issues/240', { repo: REPO, number: 240 }],
    ['  ceasarXuu/Astropath#240  ', { repo: REPO, number: 240 }],
    ['ceasarXuu/Astropath 240', { repo: REPO, number: 240 }],
  ]
  for (const [input, expected] of cases) {
    assert.deepEqual(parseIssueRef(input), expected, `input: ${input}`)
  }
})

test('parseIssueRef rejects non-Issue or malformed references', () => {
  const cases = [
    '',
    '   ',
    'not a reference',
    'https://github.com/ceasarXuu/Astropath/pull/240',
    'https://github.com/ceasarXuu/Astropath/issues/abc',
    'https://github.com/ceasarXuu/Astropath/issues/0',
    'https://github.com/ceasarXuu/Astropath/issues/240/extra',
    'https://gitlab.com/ceasarXuu/Astropath/issues/240',
    'ceasarXuu/Astropath#0',
    'ceasarXuu/Astropath#12x',
    'ceasarXuu/Astropath#123/4',
    'ceasarXuu/Astropath   ',
    'ceasarXuu/Astropath 0',
    '../etc/passwd#1',
    'owner/repo/issue#1',
    'a'.repeat(600),
    null,
    42,
  ]
  for (const input of cases) assert.equal(parseIssueRef(input), null, `input: ${String(input)}`)
})

test('repo/owner/number parameter validators reject traversal and junk', () => {
  assert.deepEqual(parseRepoParam('ceasarXuu/Astropath'), { repo: REPO, owner: 'ceasarXuu', name: 'Astropath' })
  assert.equal(parseRepoParam('ceasarXuu/../etc'), null)
  assert.equal(parseRepoParam('../Astropath'), null)
  assert.equal(parseRepoParam('ceasarXuu/Astropath/extra'), null)
  assert.equal(parseRepoParam('ceasarXuu/'), null)
  assert.equal(parseRepoParam('/Astropath'), null)
  assert.equal(parseRepoParam(''), null)
  assert.equal(parseOwnerParam('ceasarXuu'), 'ceasarXuu')
  assert.equal(parseOwnerParam('ceasarXuu/Astropath'), null)
  assert.equal(parsePositiveInt('240'), 240)
  assert.equal(parsePositiveInt(240), 240)
  assert.equal(parsePositiveInt('0'), null)
  assert.equal(parsePositiveInt('2.5'), null)
  assert.equal(parsePositiveInt('abc'), null)
})

/* ------------------------------------------------------------------ */
/* Normalizers (fixture-driven)                                        */
/* ------------------------------------------------------------------ */

test('normalizeProject maps the captured gh project list payload', () => {
  const [first] = fixture.projects.projects
  const project = normalizeProject(first)
  assert.deepEqual(project, {
    owner: 'ceasarXuu',
    ownerType: 'user',
    number: 9,
    title: 'Astropath-issues',
    url: 'https://github.com/users/ceasarXuu/projects/9',
    itemCount: 195,
    closed: false,
    description: first.shortDescription,
  })
  assert.ok(project.description.length > 0)
  // Organization owners are lowercased from gh's `Organization`.
  assert.equal(normalizeProject({ number: 1, owner: { login: 'XuyuTech', type: 'Organization' } }).ownerType, 'organization')
})

test('normalizeProject truncates shortDescription to 500 characters', () => {
  const project = normalizeProject({ number: 3, owner: { login: 'o', type: 'User' }, shortDescription: 'x'.repeat(900) })
  assert.equal(project.description.length, 500)
})

test('normalizeProjectItem maps the captured item list payload', () => {
  const items = fixture.items.items.map(normalizeProjectItem)
  assert.equal(items.length, 3)
  assert.deepEqual(items[0], {
    id: 'PVTI_lAHOAwDbXM4Bocj3zhDFfBs',
    type: 'issue',
    number: 240,
    repo: REPO,
    title: '[v1.2.0][UI] 会话名称丰富化：双标题 / TUI icon / 路径·repo·branch / 运行·已读状态',
    url: 'https://github.com/ceasarXuu/Astropath/issues/240',
    state: null,
    status: 'In Progress',
    labels: ['enhancement', 'todo'],
    milestone: 'v1.2.0',
  })
  assert.equal(items[1].status, 'In Review')
  assert.equal(items[2].milestone, null)
})

test('normalizeProjectItem maps PRs, drafts, and missing milestones', () => {
  const pr = normalizeProjectItem({
    id: 'pr-1',
    status: 'Done',
    milestone: '',
    content: { type: 'PullRequest', number: 12, repository: 'owner/repo', title: 'A PR', url: 'https://github.com/owner/repo/pull/12' },
  })
  assert.equal(pr.type, 'pr')
  assert.equal(pr.number, 12)
  assert.equal(pr.repo, 'owner/repo')
  assert.equal(pr.milestone, null)

  const draft = normalizeProjectItem({ id: 'draft-1', content: { type: 'DraftIssue', title: 'A draft', body: '' } })
  assert.equal(draft.type, 'draft')
  assert.equal(draft.number, null)
  assert.equal(draft.repo, null)
  assert.equal(draft.status, null)

  // Closed state is only emitted when a future payload carries it.
  const closed = normalizeProjectItem({ id: 'c', content: { type: 'Issue', number: 2, repository: 'o/r', title: 't', state: 'closed' } })
  assert.equal(closed.state, 'CLOSED')
})

/* ------------------------------------------------------------------ */
/* GraphQL normalizers (v0.4.0)                                        */
/* ------------------------------------------------------------------ */

test('normalizeGraphqlProject maps a Projects v2 node; closed ones stay flagged', () => {
  const viewer = fixture.graphqlProjects.data.viewer
  const open = viewer.projectsV2.nodes.find(node => node.number === 9)
  assert.deepEqual(normalizeGraphqlProject(open, { owner: 'ceasarXuu', ownerType: 'user' }), {
    owner: 'ceasarXuu',
    ownerType: 'user',
    number: 9,
    title: 'Astropath-issues',
    url: 'https://github.com/users/ceasarXuu/projects/9',
    itemCount: 195,
    closed: false,
    description: open.shortDescription,
  })
  const closed = viewer.projectsV2.nodes.find(node => node.number === 4)
  assert.equal(normalizeGraphqlProject(closed, { owner: 'ceasarXuu', ownerType: 'user' }).closed, true)

  // The items payload does not repeat `number`; the read target supplies it.
  const itemsProject = fixture.graphqlItemsPage1.data.repositoryOwner.projectV2
  assert.equal(normalizeGraphqlProject(itemsProject, { owner: 'ceasarXuu', ownerType: 'user', number: 9 }).number, 9)
  assert.equal(
    normalizeGraphqlProject({ number: 1, shortDescription: 'x'.repeat(900) }, { owner: 'o' }).description.length,
    500,
  )
})

test('ownerTypeFromProjectUrl distinguishes user and organization Projects', () => {
  assert.equal(ownerTypeFromProjectUrl('https://github.com/users/ceasarXuu/projects/9'), 'user')
  assert.equal(ownerTypeFromProjectUrl('https://github.com/orgs/XuyuTech/projects/2'), 'organization')
  assert.equal(ownerTypeFromProjectUrl(null), 'user')
  assert.equal(ownerTypeFromProjectUrl('https://example.com/x'), 'user')
})

test('normalizeGraphqlItem maps Issue / PullRequest / DraftIssue nodes', () => {
  const first = fixture.graphqlItemsPage1.data.repositoryOwner.projectV2.items.nodes[0]
  assert.deepEqual(normalizeGraphqlItem(first), {
    id: 'PVTI_lAHOAwDbXM4Bocj3zhDFfBs',
    type: 'issue',
    number: 240,
    repo: 'ceasarXuu/Astropath',
    title: '[v1.2.0][UI] 会话名称丰富化：双标题 / TUI icon / 路径·repo·branch / 运行·已读状态',
    url: 'https://github.com/ceasarXuu/Astropath/issues/240',
    state: 'OPEN',
    status: 'In Progress',
    labels: ['enhancement', 'todo'],
    milestone: 'v1.2.0',
  })

  const merged = normalizeGraphqlItem({
    id: 'pr-1',
    fieldValues: { nodes: [{}, { name: 'Done', field: { name: 'Status' } }] },
    content: {
      __typename: 'PullRequest',
      number: 12,
      title: 'A PR',
      url: 'https://github.com/o/r/pull/12',
      state: 'MERGED',
      repository: { nameWithOwner: 'o/r' },
      labels: { nodes: [{ name: 'x' }] },
      milestone: null,
    },
  })
  assert.equal(merged.type, 'pr')
  assert.equal(merged.state, 'MERGED')
  assert.equal(merged.status, 'Done')
  assert.deepEqual(merged.labels, ['x'])
  assert.equal(merged.milestone, null)

  const draft = normalizeGraphqlItem({ id: 'draft-1', content: { __typename: 'DraftIssue', title: 'Draft idea' } })
  assert.deepEqual(draft, {
    id: 'draft-1',
    type: 'draft',
    number: null,
    repo: null,
    title: 'Draft idea',
    url: null,
    state: null,
    status: null,
    labels: [],
    milestone: null,
  })

  // A Status field whose value is blank is unmapped.
  const noStatus = normalizeGraphqlItem({
    id: 'x',
    fieldValues: { nodes: [{ name: '', field: { name: 'Status' } }] },
    content: { __typename: 'Issue', number: 1, title: 't' },
  })
  assert.equal(noStatus.status, null)
})

test('normalizeIssue maps the captured REST issue + comments payload', () => {
  const issue = normalizeIssue(fixture.issue, fixture.comments, { repo: REPO, number: 240, maxComments: 30 })
  assert.equal(issue.repo, REPO)
  assert.equal(issue.number, 240)
  assert.equal(issue.state, 'open')
  assert.equal(issue.author, 'ceasarXuu')
  assert.equal(issue.createdAt, '2026-10-14T21:25:15Z')
  assert.equal(issue.updatedAt, '2026-10-26T11:26:01Z')
  assert.equal(issue.url, 'https://github.com/ceasarXuu/Astropath/issues/240')
  assert.deepEqual(issue.labels, ['enhancement', 'todo'])
  assert.deepEqual(issue.assignees, [])
  assert.equal(issue.body.length, fixture.issue.body.length)
  assert.equal(issue.bodyTruncated, false)
  assert.equal(issue.commentCount, 5)
  assert.equal(issue.comments.length, 5)
  assert.equal(issue.commentsTruncated, false)
  assert.deepEqual(issue.comments.map(comment => comment.author), Array(5).fill('ceasarXuu'))
  assert.equal(issue.comments[0].id, String(fixture.comments[0].id))
  assert.equal(issue.comments[0].url, fixture.comments[0].html_url)
  for (let index = 1; index < issue.comments.length; index += 1) {
    assert.ok(Date.parse(issue.comments[index - 1].createdAt) <= Date.parse(issue.comments[index].createdAt))
  }
  assert.deepEqual(toIssueSummary(issue), {
    repo: REPO,
    number: 240,
    title: fixture.issue.title,
    url: 'https://github.com/ceasarXuu/Astropath/issues/240',
    state: 'open',
  })
})

test('normalizeIssue truncates oversized bodies and flags them', () => {
  const raw = { ...fixture.issue, body: 'x'.repeat(100_050) }
  const issue = normalizeIssue(raw, [], { repo: REPO, number: 240 })
  assert.equal(issue.body.length, 100_000)
  assert.equal(issue.bodyTruncated, true)
  assert.equal(issue.comments[0], undefined)
})

test('normalizeIssue limits, sorts, and flags comments; ghost authors stay null', () => {
  const many = Array.from({ length: 35 }, (_, index) => ({
    id: 1000 + index,
    user: index === 0 ? null : { login: `user${String(index)}` },
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 34 - index)).toISOString(),
    body: `c${String(index)}`,
    html_url: `https://github.com/o/r/issues/1#issuecomment-${String(1000 + index)}`,
  }))
  const raw = { ...fixture.issue, comments: 35 }
  const issue = normalizeIssue(raw, many, { repo: REPO, number: 240, maxComments: 30 })
  assert.equal(issue.comments.length, 30)
  assert.equal(issue.commentCount, 35)
  assert.equal(issue.commentsTruncated, true)
  // Sorted oldest first even though the fixture rows arrive shuffled.
  assert.equal(issue.comments[0].body, 'c34')
  assert.equal(issue.comments.at(-1).body, 'c5')
  // Ghost comments have a null author.
  assert.equal(normalizeIssueComment({ id: 1, user: null, body: 'ghost' }).author, null)
})

/* ------------------------------------------------------------------ */
/* Adapter: reads                                                      */
/* ------------------------------------------------------------------ */

test('health reports version + account from the fixture runner', async () => {
  const gh = createGh({ run: fixtureRunner() })
  assert.deepEqual(await gh.health(), {
    available: true,
    version: 'gh version 2.96.0 (2026-07-02)',
    account: 'ceasarXuu',
    error: null,
  })
})

test('listProjects makes ONE GraphQL call and drops closed Projects', async () => {
  const runner = fixtureRunner()
  const gh = createGh({ run: runner })
  const result = await gh.listProjects()
  assert.deepEqual(result.owners, [
    { login: 'ceasarXuu', type: 'user' },
    { login: 'XuyuTech', type: 'organization' },
    { login: 'BeanDoor', type: 'organization' },
  ])
  assert.deepEqual(result.projects.map(project => project.number), [9, 8, 6, 5])
  assert.deepEqual(result.errors, [])
  assert.equal(runner.calls.length, 1, 'exactly one gh invocation for /projects')
  assert.equal(runner.calls[0][0], 'api')
  assert.equal(runner.calls[0][1], 'graphql')
  assert.match(runner.calls[0].join(' '), /projectsV2/u)
})

test('listProjects preserves partial GraphQL errors as per-owner entries', async () => {
  const runner = createRunner(async (args) => {
    if (args[0] === 'api' && args[1] === 'graphql') {
      const payload = JSON.parse(JSON.stringify(fixture.graphqlProjects))
      payload.errors = [{
        message: 'Could not resolve to an Organization with the login of XuyuTech.',
        path: ['viewer', 'organizations', 'nodes', 0, 'projectsV2'],
      }]
      return { stdout: `${JSON.stringify(payload)}\n`, stderr: '' }
    }
    return fixtureRun(args)
  })
  const result = await createGh({ run: runner }).listProjects()
  assert.equal(result.projects.length, 4)
  assert.deepEqual(result.errors.map(error => error.owner), ['XuyuTech'])
  assert.equal(result.errors[0].code, 'gh-failed')
  assert.match(result.errors[0].message, /Could not resolve/u)
})

test('listProjects fails gh-failed when the GraphQL payload has no viewer', async () => {
  const runner = createRunner(async () => ({
    stdout: `${JSON.stringify({ errors: [{ message: 'Bad credentials' }] })}\n`,
    stderr: '',
  }))
  await assert.rejects(createGh({ run: runner }).listProjects(), { code: 'gh-failed' })
})

test('projectItems merges GraphQL pages and derives the Project summary', async () => {
  const runner = fixtureRunner()
  const result = await createGh({ run: runner }).projectItems('ceasarXuu', 9)
  assert.equal(result.project.owner, 'ceasarXuu')
  assert.equal(result.project.ownerType, 'user')
  assert.equal(result.project.number, 9)
  assert.equal(result.project.title, 'Astropath-issues')
  assert.equal(result.project.itemCount, 195)
  assert.equal(result.project.closed, false)
  assert.equal(result.items.length, 195)
  assert.equal(result.truncated, false)
  assert.equal(result.items[0].state, 'OPEN')
  assert.equal(result.items[0].status, 'In Progress')

  const itemQueries = runner.calls.filter(args => (
    args[0] === 'api' && args[1] === 'graphql' && args.some(arg => typeof arg === 'string' && /projectV2\(number/u.test(arg))
  ))
  assert.equal(itemQueries.length, 2)
  assert.ok(itemQueries[0].join(' ').includes('-F limit=100'))
  assert.ok(!itemQueries[0].join(' ').includes('-F cursor='))
  const page1Cursor = fixture.graphqlItemsPage1.data.repositoryOwner.projectV2.items.pageInfo.endCursor
  assert.ok(itemQueries[1].join(' ').includes(`-F cursor=${page1Cursor}`))
})

test('projectItems uses the GraphQL owner __typename or the Project URL for ownerType', async () => {
  const asOrganization = createRunner(async (args) => {
    if (args[0] === 'api' && args[1] === 'graphql') {
      const payload = JSON.parse(JSON.stringify(fixture.graphqlItemsPage1))
      const owner = payload.data.repositoryOwner
      owner.__typename = 'Organization'
      owner.projectV2.url = 'https://github.com/orgs/XuyuTech/projects/9'
      return { stdout: `${JSON.stringify(payload)}\n`, stderr: '' }
    }
    return fixtureRun(args)
  })
  const organization = await createGh({ run: asOrganization }).projectItems('XuyuTech', 9)
  assert.equal(organization.project.ownerType, 'organization')

  // No __typename in the payload: the /orgs/ URL still tells the truth.
  const urlOnly = createRunner(async (args) => {
    if (args[0] === 'api' && args[1] === 'graphql') {
      const payload = JSON.parse(JSON.stringify(fixture.graphqlItemsPage1))
      payload.data.repositoryOwner.projectV2.url = 'https://github.com/orgs/XuyuTech/projects/9'
      return { stdout: `${JSON.stringify(payload)}\n`, stderr: '' }
    }
    return fixtureRun(args)
  })
  const fallback = await createGh({ run: urlOnly }).projectItems('XuyuTech', 9)
  assert.equal(fallback.project.ownerType, 'organization')
})

test('projectItems caps at maxProjectItems and flags truncated', async () => {
  const capped = createGh({ run: fixtureRunner(), maxProjectItems: 50 })
  const result = await capped.projectItems('ceasarXuu', 9)
  assert.equal(result.items.length, 50)
  assert.equal(result.truncated, true)
  assert.equal(result.project.itemCount, 195)
})

test('projectItems maps a GraphQL-null Project to project-not-found', async () => {
  // Real `gh api graphql` answers 200 with `projectV2: null` for a missing or
  // unauthorized Project; the adapter classifies that as a 404-domain error.
  const gh = createGh({ run: fixtureRunner() })
  await assert.rejects(gh.projectItems('ceasarXuu', 99999), { code: 'project-not-found' })
})

test('getIssue returns a contract IssueDetail and issues the REST commands', async () => {
  const runner = fixtureRunner()
  const gh = createGh({ run: runner })
  const { issue } = await gh.getIssue(REPO, 240)
  assert.equal(issue.number, 240)
  assert.equal(issue.state, 'open')
  assert.equal(issue.comments.length, 5)
  assert.ok(runner.commands().includes(`api repos/${REPO}/issues/240`))
  assert.ok(runner.commands().includes(`api repos/${REPO}/issues/240/comments?per_page=30`))
})

test('getIssue rejects Pull Requests with the documented message', async () => {
  const gh = createGh({ run: fixtureRunner() })
  await assert.rejects(gh.getIssue(REPO, 283), (error) => {
    assert.equal(error.code, 'issue-not-found')
    assert.equal(error.message, '这是 Pull Request')
    return true
  })
})

test('getIssue maps a REST 404 and keeps other gh failures classified', async () => {
  const missing = createRunner(async () => { throw ghNotFound() })
  await assert.rejects(createGh({ run: missing }).getIssue(REPO, 999), { code: 'issue-not-found' })

  const broken = createRunner(async () => { throw ghError('GraphQL: rate limit exceeded') })
  await assert.rejects(createGh({ run: broken }).getIssue(REPO, 240), { code: 'gh-failed' })
})

test('adapter validates owner/repo/number parameters before spawning', async () => {
  const runner = createRunner(async () => { throw new Error('must not be called') })
  const gh = createGh({ run: runner })
  await assert.rejects(gh.projectItems('bad/owner', 1), { code: 'bad-request' })
  await assert.rejects(gh.projectItems('ceasarXuu', 0), { code: 'bad-request' })
  await assert.rejects(gh.getIssue('not-a-repo', 1), { code: 'bad-request' })
  await assert.rejects(gh.getIssue(REPO, -1), { code: 'bad-request' })
  assert.deepEqual(runner.calls, [])
})

test('resolveIssueRef resolves valid refs and returns null for invalid ones', async () => {
  const gh = createGh({ run: fixtureRunner() })
  assert.equal(await gh.resolveIssueRef('nonsense'), null)
  const resolved = await gh.resolveIssueRef('https://github.com/ceasarXuu/Astropath/issues/240')
  assert.deepEqual(resolved.ref, { repo: REPO, number: 240 })
  assert.equal(resolved.summary.repo, REPO)
  assert.equal(resolved.summary.number, 240)
  assert.equal(resolved.summary.state, 'open')
})

/* ------------------------------------------------------------------ */
/* Error classification                                                */
/* ------------------------------------------------------------------ */

test('classifyGhError maps spawn/timeout/auth/exit failures', () => {
  assert.equal(classifyGhError(ghMissingError()).code, 'gh-missing')
  assert.equal(classifyGhError(ghTimeoutError()).code, 'timeout')
  assert.equal(classifyGhError(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })).code, 'timeout')
  assert.equal(classifyGhError(ghAuthError()).code, 'gh-auth')
  assert.equal(classifyGhError(ghError('HTTP 401: Bad credentials')).code, 'gh-auth')
  assert.equal(classifyGhError(ghError('GraphQL: Something else broke')).code, 'gh-failed')
  assert.equal(classifyGhError(Object.assign(new Error('max'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })).code, 'gh-failed')
})

test('gh failure messages keep the stderr tail but never leak stdout', () => {
  const stderr = `${'front '.repeat(200)}TAIL-MARKER`
  const error = Object.assign(new Error('exit 1'), { code: 1, stderr, stdout: 'SECRET-BODY-CONTENT' })
  const classified = classifyGhError(error)
  assert.equal(classified.code, 'gh-failed')
  assert.ok(classified.message.includes('TAIL-MARKER'))
  assert.ok(!classified.message.includes('SECRET-BODY-CONTENT'))
  assert.ok(classified.message.length < 800)
})

/* ------------------------------------------------------------------ */
/* Default execFile runner (local shell scripts only)                  */
/* ------------------------------------------------------------------ */

function writeScript(dir, name, body) {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`, 'utf8')
  chmodSync(path, 0o755)
  return path
}

test('default runner uses execFile against the configured ghCommand', async (t) => {
  const dir = tempDir()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const script = writeScript(dir, 'fake-gh', [
    'case "$1" in',
    '  --version) echo "gh version 9.9.9 (test)"; exit 0 ;;',
    '  api) echo "To get started with GitHub CLI, please run: gh auth login" >&2; exit 1 ;;',
    'esac',
    'exit 1',
  ].join('\n'))
  const gh = createGh({ ghCommand: script, timeoutMs: 5_000 })
  const health = await gh.health()
  assert.equal(health.available, true)
  assert.equal(health.version, 'gh version 9.9.9 (test)')
  assert.equal(health.account, null)
  assert.match(health.error, /gh auth login|登录/u)
})

test('default runner classifies a missing binary as gh-missing', async () => {
  const dir = tempDir()
  try {
    const gh = createGh({ ghCommand: join(dir, 'definitely-not-gh') })
    const health = await gh.health()
    assert.equal(health.available, false)
    assert.match(health.error, /找不到 GitHub CLI/u)
    await assert.rejects(gh.listProjects(), { code: 'gh-missing' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('default runner classifies a timeout as timeout', async (t) => {
  const dir = tempDir()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const script = writeScript(dir, 'slow-gh', 'sleep 2\nexit 0')
  const gh = createGh({ ghCommand: script, timeoutMs: 100 })
  await assert.rejects(gh.projectItems('ceasarXuu', 9), { code: 'timeout' })
})
