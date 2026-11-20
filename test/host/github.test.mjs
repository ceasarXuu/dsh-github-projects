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
  normalizeProjectMeta,
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
  PROJECT_META_IDS,
} from './support.mjs'

const REPO = 'acme/web'
const ITEM_240_ID = 'PVTI_lAHOAwDbXM4Bocj3zhDFfBs'
const ITEM_91_ID = 'PVTI_lAHOAwDbXM4Bocj3zhDFgtI'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'ghp-gh-'))
}

/* ------------------------------------------------------------------ */
/* parseIssueRef                                                       */
/* ------------------------------------------------------------------ */

test('parseIssueRef accepts the documented reference forms', () => {
  const cases = [
    ['https://github.com/acme/web/issues/240', { repo: REPO, number: 240 }],
    ['http://github.com/acme/web/issues/240', { repo: REPO, number: 240 }],
    ['https://www.github.com/acme/web/issues/240/', { repo: REPO, number: 240 }],
    ['https://github.com/acme/web/issues/240?foo=1', { repo: REPO, number: 240 }],
    ['https://github.com/acme/web/issues/240#issuecomment-1', { repo: REPO, number: 240 }],
    ['github.com/acme/web/issues/240', { repo: REPO, number: 240 }],
    ['  acme/web#240  ', { repo: REPO, number: 240 }],
    ['acme/web 240', { repo: REPO, number: 240 }],
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
    'https://github.com/acme/web/pull/240',
    'https://github.com/acme/web/issues/abc',
    'https://github.com/acme/web/issues/0',
    'https://github.com/acme/web/issues/240/extra',
    'https://gitlab.com/acme/web/issues/240',
    'acme/web#0',
    'acme/web#12x',
    'acme/web#123/4',
    'acme/web   ',
    'acme/web 0',
    '../etc/passwd#1',
    'owner/repo/issue#1',
    'a'.repeat(600),
    null,
    42,
  ]
  for (const input of cases) assert.equal(parseIssueRef(input), null, `input: ${String(input)}`)
})

test('repo/owner/number parameter validators reject traversal and junk', () => {
  assert.deepEqual(parseRepoParam('acme/web'), { repo: REPO, owner: 'acme', name: 'web' })
  assert.equal(parseRepoParam('acme/../etc'), null)
  assert.equal(parseRepoParam('../web'), null)
  assert.equal(parseRepoParam('acme/web/extra'), null)
  assert.equal(parseRepoParam('acme/'), null)
  assert.equal(parseRepoParam('/web'), null)
  assert.equal(parseRepoParam(''), null)
  assert.equal(parseOwnerParam('acme'), 'acme')
  assert.equal(parseOwnerParam('acme/web'), null)
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
    owner: 'acme',
    ownerType: 'user',
    number: 9,
    title: 'web-issues',
    url: 'https://github.com/users/acme/projects/9',
    itemCount: 195,
    closed: false,
    description: first.shortDescription,
  })
  assert.ok(project.description.length > 0)
  // Organization owners are lowercased from gh's `Organization`.
  assert.equal(normalizeProject({ number: 1, owner: { login: 'acme-labs', type: 'Organization' } }).ownerType, 'organization')
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
    title: '[v1.2.0][UI] Tidy label picker (91)',
    url: 'https://github.com/acme/web/issues/240',
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
  assert.deepEqual(normalizeGraphqlProject(open, { owner: 'acme', ownerType: 'user' }), {
    owner: 'acme',
    ownerType: 'user',
    number: 9,
    title: 'web-issues',
    url: 'https://github.com/users/acme/projects/9',
    itemCount: 195,
    closed: false,
    description: open.shortDescription,
  })
  const closed = viewer.projectsV2.nodes.find(node => node.number === 4)
  assert.equal(normalizeGraphqlProject(closed, { owner: 'acme', ownerType: 'user' }).closed, true)

  // The items payload does not repeat `number`; the read target supplies it.
  const itemsProject = fixture.graphqlItemsPage1.data.repositoryOwner.projectV2
  assert.equal(normalizeGraphqlProject(itemsProject, { owner: 'acme', ownerType: 'user', number: 9 }).number, 9)
  assert.equal(
    normalizeGraphqlProject({ number: 1, shortDescription: 'x'.repeat(900) }, { owner: 'o' }).description.length,
    500,
  )
})

test('ownerTypeFromProjectUrl distinguishes user and organization Projects', () => {
  assert.equal(ownerTypeFromProjectUrl('https://github.com/users/acme/projects/9'), 'user')
  assert.equal(ownerTypeFromProjectUrl('https://github.com/orgs/acme-labs/projects/2'), 'organization')
  assert.equal(ownerTypeFromProjectUrl(null), 'user')
  assert.equal(ownerTypeFromProjectUrl('https://example.com/x'), 'user')
})

test('normalizeGraphqlItem maps Issue / PullRequest / DraftIssue nodes', () => {
  const first = fixture.graphqlItemsPage1.data.repositoryOwner.projectV2.items.nodes[0]
  assert.deepEqual(normalizeGraphqlItem(first), {
    id: 'PVTI_lAHOAwDbXM4Bocj3zhDFfBs',
    type: 'issue',
    number: 240,
    repo: 'acme/web',
    title: '[v1.2.0][UI] Tidy label picker (91)',
    url: 'https://github.com/acme/web/issues/240',
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

test('normalizeProjectMeta maps the captured Project status-field payload', () => {
  const node = fixture.graphqlProjectMeta.data.repositoryOwner.projectV2
  assert.deepEqual(normalizeProjectMeta(node, { owner: 'acme', number: 9 }), {
    project: {
      id: PROJECT_META_IDS.projectId,
      owner: 'acme',
      number: 9,
      title: 'web-issues',
    },
    statusField: {
      id: PROJECT_META_IDS.statusFieldId,
      name: 'Status',
      options: [
        { id: PROJECT_META_IDS.options.TODO, name: 'TODO' },
        { id: PROJECT_META_IDS.options['In Progress'], name: 'In Progress' },
        { id: PROJECT_META_IDS.options['In Review'], name: 'In Review' },
        { id: PROJECT_META_IDS.options.Done, name: 'Done' },
      ],
    },
  })

  // Defensive: a Project without a single-select Status field has none.
  assert.equal(normalizeProjectMeta({ id: 'PVT_x', title: 't' }, { owner: 'o', number: 2 }).statusField, null)
  assert.equal(normalizeProjectMeta({ id: 'PVT_x', field: { id: '', options: [] } }, { owner: 'o', number: 2 }).statusField, null)
  // Missing option names fall back to the option id; a missing field name is `Status`.
  const sparse = normalizeProjectMeta({ id: 'PVT_x', field: { id: 'F', options: [{ id: 'o1' }] } }, { owner: 'o', number: 3 })
  assert.equal(sparse.project.id, 'PVT_x')
  assert.equal(sparse.project.number, 3)
  assert.equal(sparse.statusField.id, 'F')
  assert.equal(sparse.statusField.name, 'Status')
  assert.deepEqual(sparse.statusField.options, [{ id: 'o1', name: 'o1' }])
})

test('normalizeIssue maps the captured REST issue + comments payload', () => {
  const issue = normalizeIssue(fixture.issue, fixture.comments, { repo: REPO, number: 240, maxComments: 30 })
  assert.equal(issue.repo, REPO)
  assert.equal(issue.number, 240)
  assert.equal(issue.state, 'open')
  assert.equal(issue.author, 'acme')
  assert.equal(issue.createdAt, '2026-10-14T21:25:15Z')
  assert.equal(issue.updatedAt, '2026-10-26T11:26:01Z')
  assert.equal(issue.url, 'https://github.com/acme/web/issues/240')
  assert.deepEqual(issue.labels, ['enhancement', 'todo'])
  assert.deepEqual(issue.assignees, [])
  assert.equal(issue.body.length, fixture.issue.body.length)
  assert.equal(issue.bodyTruncated, false)
  assert.equal(issue.commentCount, 5)
  assert.equal(issue.comments.length, 5)
  assert.equal(issue.commentsTruncated, false)
  assert.deepEqual(issue.comments.map(comment => comment.author), Array(5).fill('acme'))
  assert.equal(issue.comments[0].id, String(fixture.comments[0].id))
  assert.equal(issue.comments[0].url, fixture.comments[0].html_url)
  for (let index = 1; index < issue.comments.length; index += 1) {
    assert.ok(Date.parse(issue.comments[index - 1].createdAt) <= Date.parse(issue.comments[index].createdAt))
  }
  assert.deepEqual(toIssueSummary(issue), {
    repo: REPO,
    number: 240,
    title: fixture.issue.title,
    url: 'https://github.com/acme/web/issues/240',
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
    account: 'acme',
    error: null,
  })
})

test('listProjects makes ONE GraphQL call and drops closed Projects', async () => {
  const runner = fixtureRunner()
  const gh = createGh({ run: runner })
  const result = await gh.listProjects()
  assert.deepEqual(result.owners, [
    { login: 'acme', type: 'user' },
    { login: 'acme-labs', type: 'organization' },
    { login: 'northwind', type: 'organization' },
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
        message: 'Could not resolve to an Organization with the login of acme-labs.',
        path: ['viewer', 'organizations', 'nodes', 0, 'projectsV2'],
      }]
      return { stdout: `${JSON.stringify(payload)}\n`, stderr: '' }
    }
    return fixtureRun(args)
  })
  const result = await createGh({ run: runner }).listProjects()
  assert.equal(result.projects.length, 4)
  assert.deepEqual(result.errors.map(error => error.owner), ['acme-labs'])
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
  const result = await createGh({ run: runner }).projectItems('acme', 9)
  assert.equal(result.project.owner, 'acme')
  assert.equal(result.project.ownerType, 'user')
  assert.equal(result.project.number, 9)
  assert.equal(result.project.title, 'web-issues')
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
      owner.projectV2.url = 'https://github.com/orgs/acme-labs/projects/9'
      return { stdout: `${JSON.stringify(payload)}\n`, stderr: '' }
    }
    return fixtureRun(args)
  })
  const organization = await createGh({ run: asOrganization }).projectItems('acme-labs', 9)
  assert.equal(organization.project.ownerType, 'organization')

  // No __typename in the payload: the /orgs/ URL still tells the truth.
  const urlOnly = createRunner(async (args) => {
    if (args[0] === 'api' && args[1] === 'graphql') {
      const payload = JSON.parse(JSON.stringify(fixture.graphqlItemsPage1))
      payload.data.repositoryOwner.projectV2.url = 'https://github.com/orgs/acme-labs/projects/9'
      return { stdout: `${JSON.stringify(payload)}\n`, stderr: '' }
    }
    return fixtureRun(args)
  })
  const fallback = await createGh({ run: urlOnly }).projectItems('acme-labs', 9)
  assert.equal(fallback.project.ownerType, 'organization')
})

test('projectItems caps at maxProjectItems and flags truncated', async () => {
  const capped = createGh({ run: fixtureRunner(), maxProjectItems: 50 })
  const result = await capped.projectItems('acme', 9)
  assert.equal(result.items.length, 50)
  assert.equal(result.truncated, true)
  assert.equal(result.project.itemCount, 195)
})

test('projectItems maps a GraphQL-null Project to project-not-found', async () => {
  // Real `gh api graphql` answers 200 with `projectV2: null` for a missing or
  // unauthorized Project; the adapter classifies that as a 404-domain error.
  const gh = createGh({ run: fixtureRunner() })
  await assert.rejects(gh.projectItems('acme', 99999), { code: 'project-not-found' })
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
  await assert.rejects(gh.projectItems('acme', 0), { code: 'bad-request' })
  await assert.rejects(gh.getIssue('not-a-repo', 1), { code: 'bad-request' })
  await assert.rejects(gh.getIssue(REPO, -1), { code: 'bad-request' })
  assert.deepEqual(runner.calls, [])
})

test('resolveIssueRef resolves valid refs and returns null for invalid ones', async () => {
  const gh = createGh({ run: fixtureRunner() })
  assert.equal(await gh.resolveIssueRef('nonsense'), null)
  const resolved = await gh.resolveIssueRef('https://github.com/acme/web/issues/240')
  assert.deepEqual(resolved.ref, { repo: REPO, number: 240 })
  assert.equal(resolved.summary.repo, REPO)
  assert.equal(resolved.summary.number, 240)
  assert.equal(resolved.summary.state, 'open')
})

/* ------------------------------------------------------------------ */
/* Adapter: v1.1.0 write path (contract §3.2)                          */
/* ------------------------------------------------------------------ */

test('getProjectMeta makes ONE GraphQL read and maps a missing Project to project-not-found', async () => {
  const runner = fixtureRunner()
  const gh = createGh({ run: runner })
  const meta = await gh.getProjectMeta('acme', 9)
  assert.equal(meta.project.id, PROJECT_META_IDS.projectId)
  assert.equal(meta.project.owner, 'acme')
  assert.equal(meta.project.number, 9)
  assert.equal(meta.statusField.id, PROJECT_META_IDS.statusFieldId)
  assert.equal(meta.statusField.options.length, 4)
  assert.equal(runner.calls.length, 1, 'one gh api graphql read')
  assert.match(runner.calls[0].join(' '), /field\(name:"Status"\)/u)

  await assert.rejects(gh.getProjectMeta('acme', 99999), { code: 'project-not-found' })
  await assert.rejects(gh.getProjectMeta('bad/owner', 9), { code: 'bad-request' })
  await assert.rejects(gh.getProjectMeta('acme', 0), { code: 'bad-request' })
})

test('getProjectMeta raises gh-failed when the Project has no Status single-select field', async () => {
  const runner = createRunner(async () => ({
    stdout: `${JSON.stringify({ data: { repositoryOwner: { projectV2: { id: 'PVT_x', title: 't', field: null } } } })}\n`,
    stderr: '',
  }))
  await assert.rejects(createGh({ run: runner }).getProjectMeta('acme', 9), { code: 'gh-failed' })
})

test('findProjectItem resolves content references by paging the items read', async () => {
  const runner = fixtureRunner()
  const gh = createGh({ run: runner })
  const item = await gh.findProjectItem('acme', 9, REPO, 240)
  assert.equal(item.id, ITEM_240_ID)
  assert.equal(item.number, 240)
  assert.equal(item.status, 'In Progress')
  // GitHub repo names are case-insensitive; the comparison is too.
  const second = await gh.findProjectItem('acme', 9, 'ACME/web', 91)
  assert.equal(second.id, ITEM_91_ID)
  // Page 1 already contains #240/#91, but a later page is reachable for the miss.
  await assert.rejects(gh.findProjectItem('acme', 9, REPO, 999999), { code: 'item-not-found' })
  await assert.rejects(gh.findProjectItem('acme', 9, 'not-a-repo', 240), { code: 'bad-request' })
  await assert.rejects(gh.findProjectItem('acme', 9, REPO, 0), { code: 'bad-request' })
  assert.ok(!runner.calls.some(args => args.some(arg => typeof arg === 'string' && /ItemFieldValue/u.test(arg))))
})

test('findProjectItemById requires a PVTI_ node id and resolves from the items read', async () => {
  const runner = fixtureRunner()
  const gh = createGh({ run: runner })
  const item = await gh.findProjectItemById('acme', 9, ITEM_91_ID)
  assert.equal(item.number, 91)
  await assert.rejects(gh.findProjectItemById('acme', 9, 'PVTI_missing'), { code: 'item-not-found' })
  await assert.rejects(gh.findProjectItemById('acme', 9, 'not-a-node'), { code: 'bad-request' })
})

test('updateItemStatus writes the Status field with the real project/field ids', async () => {
  const runner = fixtureRunner()
  const gh = createGh({ run: runner })
  const result = await gh.updateItemStatus({
    owner: 'acme',
    number: 9,
    itemId: ITEM_240_ID,
    optionId: PROJECT_META_IDS.options['In Review'],
  })
  assert.deepEqual(result, {
    item: { id: ITEM_240_ID },
    status: { optionId: PROJECT_META_IDS.options['In Review'], name: 'In Review' },
  })
  // One metadata read + one mutation.
  assert.equal(runner.calls.length, 2)
  const mutation = runner.calls.find(args => args.some(arg => typeof arg === 'string' && /updateProjectV2ItemFieldValue/u.test(arg)))
  assert.ok(mutation, 'no updateProjectV2ItemFieldValue mutation')
  const command = mutation.join(' ')
  assert.ok(command.includes(`-f projectId=${PROJECT_META_IDS.projectId}`))
  assert.ok(command.includes(`-f itemId=${ITEM_240_ID}`))
  assert.ok(command.includes(`-f fieldId=${PROJECT_META_IDS.statusFieldId}`))
  assert.ok(command.includes(`-f optionId=${PROJECT_META_IDS.options['In Review']}`))
  // `gh -F` would infer the real all-digit Done option id as a JSON number, so
  // mutation variables are passed as raw strings (`-f`) and the mutation
  // declares the GitHub schema's `singleSelectOptionId: String`.
  assert.match(command, /\$optionId:String!/u)
  assert.ok(command.includes('-f optionId='))
})

test('updateItemStatus accepts the real all-digit Done option id', async () => {
  assert.equal(PROJECT_META_IDS.options.Done, '98236657')
  const runner = fixtureRunner()
  const gh = createGh({ run: runner })
  const result = await gh.updateItemStatus({
    owner: 'acme',
    number: 9,
    itemId: ITEM_240_ID,
    optionId: PROJECT_META_IDS.options.Done,
  })
  assert.deepEqual(result.status, { optionId: '98236657', name: 'Done' })
  const mutation = runner.calls.find(args => args.some(arg => typeof arg === 'string' && /updateProjectV2ItemFieldValue/u.test(arg)))
  assert.ok(mutation.join(' ').includes('-f optionId=98236657'))
})

test('updateItemStatus clears with clearProjectV2ItemFieldValue and no optionId', async () => {
  const runner = fixtureRunner()
  const gh = createGh({ run: runner })
  const result = await gh.updateItemStatus({ owner: 'acme', number: 9, itemId: ITEM_240_ID, optionId: null })
  assert.deepEqual(result, {
    item: { id: ITEM_240_ID },
    status: { optionId: null, name: null },
  })
  const mutation = runner.calls.find(args => args.some(arg => typeof arg === 'string' && /clearProjectV2ItemFieldValue/u.test(arg)))
  assert.ok(mutation, 'no clearProjectV2ItemFieldValue mutation')
  const command = mutation.join(' ')
  assert.ok(!command.includes('optionId='))
  assert.ok(command.includes(`-f itemId=${ITEM_240_ID}`))
})

test('updateItemStatus rejects bad item/option ids before mutating', async () => {
  const runner = fixtureRunner()
  const gh = createGh({ run: runner })
  await assert.rejects(
    gh.updateItemStatus({ owner: 'acme', number: 9, itemId: 'not-a-node-id', optionId: null }),
    { code: 'bad-request' },
  )
  await assert.rejects(
    gh.updateItemStatus({ owner: 'acme', number: 9, itemId: ITEM_240_ID, optionId: 'f0000000' }),
    { code: 'bad-request' },
  )
  const mutations = runner.calls.filter(args => args.some(arg => typeof arg === 'string' && /ItemFieldValue/u.test(arg)))
  assert.deepEqual(mutations, [])
})

test('updateItemStatus maps GraphQL NOT_FOUND / scope / auth failures to contract codes', async () => {
  const notFound = createRunner(async (args) => {
    if (args.some(arg => typeof arg === 'string' && /updateProjectV2ItemFieldValue/u.test(arg))) {
      throw ghError("gh: Could not resolve to a node with the global id of 'PVTI_stale'")
    }
    return fixtureRun(args)
  })
  await assert.rejects(
    createGh({ run: notFound }).updateItemStatus({
      owner: 'acme', number: 9, itemId: ITEM_240_ID, optionId: PROJECT_META_IDS.options.Done,
    }),
    (error) => {
      assert.equal(error.code, 'item-not-found')
      assert.match(error.message, /找不到该 Project 条目/u)
      return true
    },
  )

  const scope = createRunner(async (args) => {
    if (args.some(arg => typeof arg === 'string' && /updateProjectV2ItemFieldValue/u.test(arg))) {
      throw ghError('gh: Your token has not been granted the required scopes to execute this query.')
    }
    return fixtureRun(args)
  })
  await assert.rejects(
    createGh({ run: scope }).updateItemStatus({
      owner: 'acme', number: 9, itemId: ITEM_240_ID, optionId: PROJECT_META_IDS.options.Done,
    }),
    (error) => {
      assert.equal(error.code, 'gh-auth')
      assert.match(error.message, /gh auth refresh -s project/u)
      return true
    },
  )

  const auth = createRunner(async (args) => {
    if (args.some(arg => typeof arg === 'string' && /clearProjectV2ItemFieldValue/u.test(arg))) {
      throw ghAuthError()
    }
    return fixtureRun(args)
  })
  await assert.rejects(
    createGh({ run: auth }).updateItemStatus({ owner: 'acme', number: 9, itemId: ITEM_240_ID, optionId: null }),
    (error) => {
      assert.equal(error.code, 'gh-auth')
      assert.match(error.message, /gh auth refresh -s project/u)
      return true
    },
  )
})

test('updateItemStatus maps a GraphQL errors payload to the write error code', async () => {
  const runner = createRunner(async (args) => {
    if (args.some(arg => typeof arg === 'string' && /clearProjectV2ItemFieldValue/u.test(arg))) {
      return {
        stdout: `${JSON.stringify({ errors: [{ message: "Could not resolve to a node with the global id of 'PVTI_stale'" }] })}\n`,
        stderr: '',
      }
    }
    return fixtureRun(args)
  })
  await assert.rejects(
    createGh({ run: runner }).updateItemStatus({ owner: 'acme', number: 9, itemId: ITEM_240_ID, optionId: null }),
    { code: 'item-not-found' },
  )
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
  await assert.rejects(gh.projectItems('acme', 9), { code: 'timeout' })
})
