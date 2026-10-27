/**
 * End-to-end-ish tests of the host HTTP API (contract §3.1): a fake
 * `webServer` service captures the single prefix route, then every endpoint is
 * driven through the real handler with a fake `gh` runner and a temp state
 * file. Also covers request gating, caching/single-flight, error envelopes,
 * and the no-`gh` degradation path.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, inject, name as pluginName, ROUTE_PATH } from '../../index.js'
import {
  APP_PREFIX,
  createRunner,
  expectErrorJson,
  expectJson,
  fixture,
  fixtureRun,
  ghAuthError,
  ghMissingError,
  ghNotFound,
  startApp,
} from './support.mjs'

const PROJECT = {
  owner: 'ceasarXuu',
  ownerType: 'user',
  number: 9,
  title: 'Astropath-issues',
  url: 'https://github.com/users/ceasarXuu/projects/9',
  itemCount: 195,
  closed: false,
  description: null,
}

const ISSUE_SUMMARY = {
  repo: 'ceasarXuu/Astropath',
  number: 240,
  title: '会话名称丰富化',
  url: 'https://github.com/ceasarXuu/Astropath/issues/240',
  state: 'open',
}

const sleep = (ms) => new Promise(resolve => { setTimeout(resolve, ms) })

function useApp(t, options) {
  const app = startApp(options)
  t.after(() => app.dispose())
  return app
}

/* ------------------------------------------------------------------ */
/* Registration + idle behaviours                                      */
/* ------------------------------------------------------------------ */

test('module declares the mandatory webServer + tools injects so Cordis waits before apply', () => {
  // Activation ordering: `--patch`/bundle rows can run before the carriers exist.
  assert.deepEqual(inject, ['webServer', 'tools'])
  assert.equal(pluginName, 'github-projects')
})

test('apply registers exactly one prefix route and the three agent tools', (t) => {
  const app = useApp(t)
  assert.equal(app.routes.length, 1)
  assert.equal(app.routes[0].kind, 'prefix')
  assert.equal(app.routes[0].path, ROUTE_PATH)
  assert.equal(ROUTE_PATH, '/plugin/github-projects')
  assert.equal(typeof app.routes[0].handler, 'function')

  assert.deepEqual(app.tools.map(definition => definition.name), [
    'github_issue_bind',
    'github_issue_switch',
    'github_issue_unbind',
  ])
  for (const definition of app.tools) {
    assert.equal(typeof definition.description, 'string')
    assert.equal(definition.parameters.type, 'object')
    assert.equal(typeof definition.output.schema, 'object')
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(typeof definition.execute, 'function')
  }
})

test('apply is inert instead of throwing when the composition has no webServer/tools', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ghp-inert-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = {
    get: () => undefined,
    effect: () => { throw new Error('must not register anything without its services') },
  }
  assert.doesNotThrow(() => apply(ctx, {
    statePath: join(dir, 'state.json'),
    cacheFile: join(dir, 'cache.json'),
  }))
})

test('the route handler also accepts a pre-stripped request path', async (t) => {
  const app = useApp(t)
  const response = await app.request({ method: 'GET', url: '/health' })
  const body = expectJson(response)
  assert.equal(body.ok, true)
})

/* ------------------------------------------------------------------ */
/* GET /health, /config                                                */
/* ------------------------------------------------------------------ */

test('GET /health answers the GhHealth contract', async (t) => {
  const app = useApp(t)
  const body = expectJson(await app.get('/health'))
  assert.deepEqual(Object.keys(body).sort(), ['gh', 'ok'])
  assert.equal(body.ok, true)
  assert.deepEqual(body.gh, {
    available: true,
    version: 'gh version 2.96.0 (2026-07-02)',
    account: 'ceasarXuu',
    error: null,
  })
})

test('GET /config reads bindings only and never waits for gh', async (t) => {
  const app = useApp(t)

  // Cold start: the placeholder, immediately (never a blocking health probe).
  const started = Date.now()
  const cold = expectJson(await app.get('/config?sessionId=session-abc&workspaceId=ws-123'))
  const elapsed = Date.now() - started
  assert.deepEqual(Object.keys(cold).sort(), ['gh', 'session', 'workspace'])
  assert.deepEqual(cold.workspace, { workspaceId: 'ws-123', project: null })
  assert.deepEqual(cold.session, { sessionId: 'session-abc', issue: null, workspaceId: 'ws-123' })
  assert.deepEqual(cold.gh, { available: false, version: null, account: null, error: 'pending' })
  assert.ok(elapsed < 50, `cold /config took ${String(elapsed)}ms`)

  // The background probe populates the snapshot soon after.
  await sleep(25)
  const warm = expectJson(await app.get('/config?sessionId=session-abc&workspaceId=ws-123'))
  assert.equal(warm.gh.available, true)
  assert.equal(warm.gh.account, 'ceasarXuu')

  const empty = expectJson(await app.get('/config'))
  assert.deepEqual(empty.workspace, { workspaceId: '', project: null })
  assert.deepEqual(empty.session, { sessionId: '', issue: null, workspaceId: null })

  // Bindings reads never trigger a Project GraphQL read.
  assert.deepEqual(app.commands().filter(command => command.includes('projectsV2')), [])
})

test('GET /health awaits a fresh probe on every call', async (t) => {
  const app = useApp(t)
  expectJson(await app.get('/health'))
  expectJson(await app.get('/health'))
  assert.equal(app.commands().filter(command => command === '--version').length, 2)
})

test('GET /config answers the last health snapshot instead of blocking on a slow refresh', async (t) => {
  let slow = false
  const runner = createRunner(async (args) => {
    if (slow) await sleep(300)
    return fixtureRun(args)
  })
  const app = useApp(t)

  // First probe populates the baseline snapshot.
  const baseline = expectJson(await app.get('/health'))
  assert.equal(baseline.gh.available, true)
  const callsBefore = app.commands().length

  slow = true
  const started = Date.now()
  const body = expectJson(await app.get('/config?workspaceId=w'))
  const elapsed = Date.now() - started
  assert.equal(body.gh.available, true)
  assert.ok(elapsed < 150, `config blocked ${String(elapsed)}ms on the slow gh probe`)

  // The background refresh still runs and settles the snapshot.
  await sleep(450)
  assert.ok(app.commands().length > callsBefore)
  const after = expectJson(await app.get('/config'))
  assert.equal(after.gh.available, true)
})

test('GET /config answers instantly while the very first gh probe hangs', async (t) => {
  let release
  const hanging = new Promise((resolve) => { release = resolve })
  const runner = createRunner(async (args) => {
    if (args[0] === '--version' || (args[0] === 'api' && args[1] === 'user')) await hanging
    return fixtureRun(args)
  })
  const app = useApp(t, { runner })

  const started = Date.now()
  const body = expectJson(await app.get('/config?workspaceId=w'))
  const elapsed = Date.now() - started
  assert.deepEqual(body.gh, { available: false, version: null, account: null, error: 'pending' })
  assert.ok(elapsed < 50, `cold /config blocked ${String(elapsed)}ms on a hanging gh probe`)
  release()
  await sleep(25)
  assert.equal(expectJson(await app.get('/config')).gh.available, true)
})

/* ------------------------------------------------------------------ */
/* Workspace bindings                                                  */
/* ------------------------------------------------------------------ */

test('POST /bind-workspace persists a Project and /config reads it back', async (t) => {
  const app = useApp(t)
  const response = await app.post('/bind-workspace', {
    sessionId: 'session-abc',
    workspaceId: 'ws-123',
    workspacePath: '/tmp/workspace',
    project: PROJECT,
  })
  const body = expectJson(response)
  assert.deepEqual(body, { ok: true, workspace: { workspaceId: 'ws-123', project: PROJECT } })

  const config = expectJson(await app.get('/config?sessionId=session-abc&workspaceId=ws-123'))
  assert.deepEqual(config.workspace.project, PROJECT)

  const state = app.readState()
  assert.equal(state.version, 1)
  assert.deepEqual(state.workspaces['ws-123'].project, PROJECT)
  assert.match(state.workspaces['ws-123'].boundAt, /^\d{4}-\d{2}-\d{2}T/u)
})

test('POST /bind-workspace validates workspaceId and project', async (t) => {
  const app = useApp(t)
  expectErrorJson(await app.post('/bind-workspace', { project: PROJECT }), 400, 'bad-request')
  expectErrorJson(await app.post('/bind-workspace', { workspaceId: 'w' }), 400, 'bad-request')
  expectErrorJson(await app.post('/bind-workspace', { workspaceId: 'w', project: { ...PROJECT, owner: 'bad/owner' } }), 400, 'bad-request')
  expectErrorJson(await app.post('/bind-workspace', { workspaceId: 'w', project: { ...PROJECT, number: 0 } }), 400, 'bad-request')
})

test('POST /unbind-workspace clears the binding and is idempotent', async (t) => {
  const app = useApp(t)
  await app.post('/bind-workspace', { workspaceId: 'ws-123', project: PROJECT })
  assert.deepEqual(expectJson(await app.post('/unbind-workspace', { workspaceId: 'ws-123' })), { ok: true })
  const config = expectJson(await app.get('/config?workspaceId=ws-123'))
  assert.equal(config.workspace.project, null)
  assert.deepEqual(expectJson(await app.post('/unbind-workspace', { workspaceId: 'ws-123' })), { ok: true })
  expectErrorJson(await app.post('/unbind-workspace', {}), 400, 'bad-request')
})

test('bindings survive a plugin reload (durable state file)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ghp-durable-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const statePath = join(dir, 'state.json')

  const first = startApp({ statePath })
  await first.post('/bind-workspace', { workspaceId: 'ws-persist', project: PROJECT })
  await first.post('/bind-issue', { sessionId: 's-persist', workspaceId: 'ws-persist', issue: ISSUE_SUMMARY })
  first.dispose()

  const second = startApp({ statePath })
  t.after(() => second.dispose())
  const config = expectJson(await second.get('/config?workspaceId=ws-persist&sessionId=s-persist'))
  assert.deepEqual(config.workspace.project, PROJECT)
  assert.deepEqual(config.session.issue, ISSUE_SUMMARY)
  assert.equal(config.session.workspaceId, 'ws-persist')
})

/* ------------------------------------------------------------------ */
/* GET /projects                                                       */
/* ------------------------------------------------------------------ */

/** Count the `gh api graphql` invocations one fake app has made. */
function graphqlCalls(app) {
  return app.calls.filter(args => args[0] === 'api' && args[1] === 'graphql').length
}

/** Wait a little for an async background cache revalidation to settle. */
const settle = () => sleep(120)

test('GET /projects returns owners, normalized Projects, fetchedAt, stale, errors', async (t) => {
  const app = useApp(t)
  const body = expectJson(await app.get('/projects'))
  assert.deepEqual(Object.keys(body).sort(), ['errors', 'fetchedAt', 'owners', 'projects', 'stale'])
  assert.deepEqual(body.owners, [
    { login: 'ceasarXuu', type: 'user' },
    { login: 'XuyuTech', type: 'organization' },
    { login: 'BeanDoor', type: 'organization' },
  ])
  // The 4 closed Projects in the GraphQL fixture are filtered out.
  assert.equal(body.projects.length, 4)
  assert.deepEqual(body.projects.map(project => project.number), [9, 8, 6, 5])
  assert.deepEqual(body.errors, [])
  assert.equal(body.stale, false)
  assert.match(body.fetchedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  assert.deepEqual(Object.keys(body.projects[0]).sort(), [
    'closed', 'description', 'itemCount', 'number', 'owner', 'ownerType', 'title', 'url',
  ])
  assert.equal(body.projects[0].number, 9)
  assert.equal(body.projects[0].ownerType, 'user')
  assert.equal(body.projects[0].itemCount, 195)
  assert.equal(body.projects[0].closed, false)
  assert.equal(app.commands().filter(command => command.startsWith('project list')).length, 0)
})

test('GET /projects uses ONE GraphQL call and serves the fresh cache without gh', async (t) => {
  const app = useApp(t, { config: { cacheTtlMs: 60_000 } })

  expectJson(await app.get('/projects'))
  assert.equal(graphqlCalls(app), 1)
  const cached = expectJson(await app.get('/projects'))
  assert.equal(graphqlCalls(app), 1)
  assert.equal(cached.stale, false)
  assert.equal(cached.fetchedAt, expectJson(await app.get('/projects')).fetchedAt)

  const refreshed = expectJson(await app.get('/projects?refresh=1'))
  assert.equal(graphqlCalls(app), 2)
  assert.equal(refreshed.stale, false)
})

/* ------------------------------------------------------------------ */
/* SWR cache (fresh / stale / refresh / cold)                          */
/* ------------------------------------------------------------------ */

test('SWR: a stale entry returns immediately as stale while one background refresh runs', async (t) => {
  const runner = createRunner(async (args) => {
    if (args[0] === 'api' && args[1] === 'graphql' && args.some(arg => typeof arg === 'string' && /projectsV2/u.test(arg))) {
      await sleep(120)
    }
    return fixtureRun(args)
  })
  const app = useApp(t, { runner, config: { cacheTtlMs: 0, staleTtlMs: 600_000 } })

  // Cold: awaits the read and is not stale.
  const coldStarted = Date.now()
  const cold = expectJson(await app.get('/projects'))
  assert.ok(Date.now() - coldStarted >= 100, 'cold read must await the loader')
  assert.equal(cold.stale, false)
  assert.equal(graphqlCalls(app), 1)

  // Stale: returns the cached payload instantly, one background refresh.
  const staleStarted = Date.now()
  const stale = expectJson(await app.get('/projects'))
  const staleElapsed = Date.now() - staleStarted
  assert.equal(stale.stale, true)
  assert.ok(staleElapsed < 60, `stale read blocked ${String(staleElapsed)}ms`)
  assert.equal(stale.fetchedAt, cold.fetchedAt)
  assert.equal(graphqlCalls(app), 2)

  // Single-flight: concurrent stale reads share one background revalidation.
  await settle()
  const callsBefore = graphqlCalls(app)
  const [left, right] = await Promise.all([app.get('/projects'), app.get('/projects')])
  assert.equal(expectJson(left).stale, true)
  assert.equal(expectJson(right).stale, true)
  await settle()
  assert.equal(graphqlCalls(app) - callsBefore, 1, 'one background revalidation for concurrent stale reads')
})

test('SWR: refresh=1 awaits a fresh read and reports stale:false', async (t) => {
  const runner = createRunner(async (args) => {
    if (args[0] === 'api' && args[1] === 'graphql' && args.some(arg => typeof arg === 'string' && /projectsV2/u.test(arg))) {
      await sleep(80)
    }
    return fixtureRun(args)
  })
  const app = useApp(t, { runner, config: { cacheTtlMs: 0, staleTtlMs: 600_000 } })

  expectJson(await app.get('/projects'))
  const started = Date.now()
  const refreshed = expectJson(await app.get('/projects?refresh=1'))
  assert.ok(Date.now() - started >= 60, 'refresh=1 must await the fresh read')
  assert.equal(refreshed.stale, false)

  // Concurrent refresh=1 calls share one in-flight gh read.
  const callsBefore = graphqlCalls(app)
  const [left, right] = await Promise.all([
    app.get('/projects?refresh=1'),
    app.get('/projects?refresh=1'),
  ])
  assert.equal(expectJson(left).stale, false)
  assert.equal(expectJson(right).stale, false)
  assert.equal(graphqlCalls(app) - callsBefore, 1)
})

test('SWR: cold reads await, single-flight concurrent cold reads into one gh call', async (t) => {
  const runner = createRunner(async (args) => {
    if (args[0] === 'api' && args[1] === 'graphql' && args.some(arg => typeof arg === 'string' && /projectsV2/u.test(arg))) {
      await sleep(60)
    }
    return fixtureRun(args)
  })
  const app = useApp(t, { runner })
  const [first, second] = await Promise.all([app.get('/projects'), app.get('/projects')])
  assert.equal(expectJson(first).stale, false)
  assert.equal(expectJson(second).stale, false)
  assert.equal(graphqlCalls(app), 1)
})

test('SWR: disk cache persists successful reads and warm-starts the next plugin instance', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ghp-disk-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const cacheFile = join(dir, 'cache.json')

  const first = startApp({ cacheFile, config: { cacheTtlMs: 60_000 } })
  expectJson(await first.get('/projects'))
  await settle()
  first.dispose()

  const persisted = JSON.parse(readFileSync(cacheFile, 'utf8'))
  assert.equal(persisted.version, 1)
  assert.ok(Object.hasOwn(persisted.entries, 'projects'))
  assert.deepEqual(persisted.entries.projects.value.projects.map(project => project.number), [9, 8, 6, 5])

  const second = startApp({ cacheFile, config: { cacheTtlMs: 60_000 } })
  t.after(() => second.dispose())
  const warmed = expectJson(await second.get('/projects'))
  assert.equal(warmed.stale, false)
  assert.equal(warmed.projects.length, 4)
  assert.equal(graphqlCalls(second), 0, 'a fresh disk entry must not spawn gh')
})

test('SWR: diskCache:false writes no cache file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ghp-nodisk-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const cacheFile = join(dir, 'cache.json')
  const app = useApp(t, { cacheFile, config: { diskCache: false } })
  expectJson(await app.get('/projects'))
  await settle()
  assert.equal(existsSync(cacheFile), false)
})

/* ------------------------------------------------------------------ */
/* GET /items                                                          */
/* ------------------------------------------------------------------ */

test('GET /items returns the Project summary plus 195 normalized GraphQL items', async (t) => {
  const app = useApp(t)
  const body = expectJson(await app.get('/items?owner=ceasarXuu&number=9'))
  assert.deepEqual(Object.keys(body).sort(), ['fetchedAt', 'items', 'project', 'stale', 'truncated'])
  assert.equal(body.project.owner, 'ceasarXuu')
  assert.equal(body.project.ownerType, 'user')
  assert.equal(body.project.number, 9)
  assert.equal(body.project.title, 'Astropath-issues')
  assert.equal(body.project.itemCount, 195)
  assert.equal(body.project.closed, false)
  assert.equal(body.items.length, 195)
  assert.equal(body.truncated, false)
  assert.equal(body.stale, false)
  assert.equal(body.items[0].type, 'issue')
  assert.equal(body.items[0].number, 240)
  assert.equal(body.items[0].repo, 'ceasarXuu/Astropath')
  assert.equal(body.items[0].status, 'In Progress')
  assert.equal(body.items[0].state, 'OPEN')
  assert.deepEqual(body.items[0].labels, ['enhancement', 'todo'])
  assert.equal(body.items[0].milestone, 'v1.2.0')
  const statusCounts = body.items.reduce((counts, item) => {
    counts[item.status ?? 'null'] = (counts[item.status ?? 'null'] ?? 0) + 1
    return counts
  }, {})
  assert.deepEqual(statusCounts, { 'In Progress': 1, 'In Review': 1, TODO: 27, Done: 166 })
})

test('GET /items paginates at 100/page using the page cursor', async (t) => {
  const app = useApp(t)
  expectJson(await app.get('/items?owner=ceasarXuu&number=9'))
  const itemQueries = app.calls.filter(args => (
    args[0] === 'api'
    && args[1] === 'graphql'
    && args.some(arg => typeof arg === 'string' && /projectV2\(number/u.test(arg))
  ))
  assert.equal(itemQueries.length, 2)
  const flat = itemQueries.map(args => args.join(' '))
  assert.ok(flat[0].includes('-F limit=100'))
  assert.ok(!flat[0].includes('-F cursor='))
  assert.ok(flat[1].includes('-F limit=100'))
  assert.ok(flat[1].includes('-F cursor='))
})

test('GET /items caps at maxProjectItems and flags truncated', async (t) => {
  const capped = useApp(t, { config: { maxProjectItems: 50 } })
  const body = expectJson(await capped.get('/items?owner=ceasarXuu&number=9'))
  assert.equal(body.items.length, 50)
  assert.equal(body.truncated, true)
  const queries = capped.commands().filter(command => command.includes('projectV2(number'))
  assert.equal(queries.length, 1)
  assert.ok(queries[0].includes('-F limit=50'))

  const partial = useApp(t, { config: { maxProjectItems: 150 } })
  const partialBody = expectJson(await partial.get('/items?owner=ceasarXuu&number=9'))
  assert.equal(partialBody.items.length, 150)
  assert.equal(partialBody.truncated, true)
  const partialQueries = partial.calls.filter(args => (
    args[0] === 'api' && args[1] === 'graphql' && args.some(arg => typeof arg === 'string' && /projectV2\(number/u.test(arg))
  ))
  assert.equal(partialQueries.length, 2)
  assert.ok(partialQueries[0].join(' ').includes('-F limit=100'))
  assert.ok(partialQueries[1].join(' ').includes('-F limit=50'))
})

test('GET /items maps a missing Project to 404 and bad params to 400', async (t) => {
  const app = useApp(t)
  expectErrorJson(await app.get('/items?owner=ceasarXuu&number=99999'), 404, 'project-not-found')
  expectErrorJson(await app.get('/items?owner=bad/owner&number=9'), 400, 'bad-request')
  expectErrorJson(await app.get('/items?owner=ceasarXuu&number=abc'), 400, 'bad-request')
  expectErrorJson(await app.get('/items?owner=ceasarXuu'), 400, 'bad-request')
})

/* ------------------------------------------------------------------ */
/* GET /issue                                                          */
/* ------------------------------------------------------------------ */

test('GET /issue returns a contract IssueDetail with comments', async (t) => {
  const app = useApp(t)
  const body = expectJson(await app.get('/issue?repo=ceasarXuu/Astropath&number=240'))
  assert.deepEqual(Object.keys(body).sort(), ['fetchedAt', 'issue', 'stale'])
  assert.equal(body.stale, false)
  const issue = body.issue
  assert.equal(issue.repo, 'ceasarXuu/Astropath')
  assert.equal(issue.number, 240)
  assert.equal(issue.title, fixture.issue.title)
  assert.equal(issue.url, 'https://github.com/ceasarXuu/Astropath/issues/240')
  assert.equal(issue.state, 'open')
  assert.equal(issue.author, 'ceasarXuu')
  assert.deepEqual(issue.labels, ['enhancement', 'todo'])
  assert.deepEqual(issue.assignees, [])
  assert.equal(issue.body.length, fixture.issue.body.length)
  assert.equal(issue.bodyTruncated, false)
  assert.equal(issue.commentCount, 5)
  assert.equal(issue.comments.length, 5)
  assert.equal(issue.commentsTruncated, false)
  assert.deepEqual(Object.keys(issue.comments[0]).sort(), ['author', 'body', 'createdAt', 'id', 'url'])
})

test('GET /issue rejects Pull Requests and bad parameters', async (t) => {
  const app = useApp(t)
  const pr = expectErrorJson(await app.get('/issue?repo=ceasarXuu/Astropath&number=283'), 404, 'issue-not-found')
  assert.equal(pr.message, '这是 Pull Request')
  expectErrorJson(await app.get('/issue?repo=not-a-repo&number=1'), 400, 'bad-request')
  expectErrorJson(await app.get('/issue?repo=ceasarXuu/Astropath&number=0'), 400, 'bad-request')
  expectErrorJson(await app.get('/issue?repo=ceasarXuu/Astropath'), 400, 'bad-request')
})

test('GET /issue caches per repo#number and shares one in-flight read', async (t) => {
  let issueReads = 0
  const runner = createRunner(async (args) => {
    if (args[0] === 'api' && args[1] === 'repos/ceasarXuu/Astropath/issues/240') {
      issueReads += 1
      await sleep(30)
      return { stdout: `${JSON.stringify(fixture.issue)}\n`, stderr: '' }
    }
    return fixtureRun(args)
  })
  const app = useApp(t, { runner, config: { cacheTtlMs: 60_000 } })
  const url = '/issue?repo=ceasarXuu/Astropath&number=240'

  const [first, second] = await Promise.all([app.get(url), app.get(url)])
  expectJson(first)
  expectJson(second)
  assert.equal(issueReads, 1)

  expectJson(await app.get(url))
  assert.equal(issueReads, 1)

  expectJson(await app.get(`${url}&refresh=1`))
  assert.equal(issueReads, 2)
})

/* ------------------------------------------------------------------ */
/* POST /bind-issue, /unbind-issue                                     */
/* ------------------------------------------------------------------ */

test('POST /bind-issue stores a complete client summary without any gh read', async (t) => {
  const app = useApp(t)
  const response = await app.post('/bind-issue', {
    sessionId: 'session-abc',
    workspaceId: 'ws-123',
    issue: ISSUE_SUMMARY,
  })
  const body = expectJson(response)
  assert.deepEqual(body, {
    ok: true,
    session: { sessionId: 'session-abc', issue: ISSUE_SUMMARY, workspaceId: 'ws-123' },
  })
  assert.deepEqual(app.commands().filter(command => command.includes('/issues/')), [])

  const config = expectJson(await app.get('/config?sessionId=session-abc&workspaceId=ws-123'))
  assert.deepEqual(config.session.issue, ISSUE_SUMMARY)
  assert.equal(app.readState().sessions['session-abc'].issue.number, 240)
})

test('POST /bind-issue resolves an Issue URL / short ref through gh', async (t) => {
  const app = useApp(t)
  const fromUrl = expectJson(await app.post('/bind-issue', {
    sessionId: 's-url',
    ref: 'https://github.com/ceasarXuu/Astropath/issues/240',
  }))
  assert.deepEqual(fromUrl.session.issue, {
    repo: 'ceasarXuu/Astropath',
    number: 240,
    title: fixture.issue.title,
    url: 'https://github.com/ceasarXuu/Astropath/issues/240',
    state: 'open',
  })

  const fromShort = expectJson(await app.post('/bind-issue', {
    sessionId: 's-short',
    ref: 'ceasarXuu/Astropath#240',
  }))
  assert.equal(fromShort.session.issue.number, 240)
})

test('POST /bind-issue completes a partial summary from one gh read', async (t) => {
  const app = useApp(t)
  const body = expectJson(await app.post('/bind-issue', {
    sessionId: 's-partial',
    workspaceId: 'w1',
    issue: { repo: 'ceasarXuu/Astropath', number: 240 },
  }))
  assert.equal(body.session.issue.title, fixture.issue.title)
  assert.equal(body.session.issue.url, 'https://github.com/ceasarXuu/Astropath/issues/240')
  assert.equal(body.session.issue.state, 'open')
})

test('POST /bind-issue maps bad refs to 400 and missing Issues to 404', async (t) => {
  const app = useApp(t)
  expectErrorJson(await app.post('/bind-issue', { sessionId: 's', ref: 'not a ref' }), 400, 'bad-request')
  expectErrorJson(await app.post('/bind-issue', { sessionId: 's' }), 400, 'bad-request')
  expectErrorJson(await app.post('/bind-issue', { ref: 'ceasarXuu/Astropath#240' }), 400, 'bad-request')
  expectErrorJson(await app.post('/bind-issue', { sessionId: 's', issue: { repo: 'bad', number: 1 } }), 400, 'bad-request')

  const runner = createRunner(async (args) => {
    if (args[0] === 'api' && args[1] === 'repos/ceasarXuu/Astropath/issues/123') throw ghNotFound()
    return fixtureRun(args)
  })
  const app404 = useApp(t, { runner })
  expectErrorJson(await app404.post('/bind-issue', { sessionId: 's', ref: 'ceasarXuu/Astropath#123' }), 404, 'issue-not-found')
})

test('POST /unbind-issue clears the session binding', async (t) => {
  const app = useApp(t)
  await app.post('/bind-issue', { sessionId: 's1', workspaceId: 'w1', issue: ISSUE_SUMMARY })
  assert.deepEqual(expectJson(await app.post('/unbind-issue', { sessionId: 's1' })), { ok: true })
  const config = expectJson(await app.get('/config?sessionId=s1&workspaceId=w1'))
  assert.equal(config.session.issue, null)
  assert.equal(config.session.workspaceId, 'w1')
  expectErrorJson(await app.post('/unbind-issue', {}), 400, 'bad-request')
})

/* ------------------------------------------------------------------ */
/* Agent tools (contract §3.4)                                         */
/* ------------------------------------------------------------------ */

const TOOL_EXEC = { agent: { session: { id: 'sess-tool-1' } }, signal: new AbortController().signal }
const OTHER_TOOL_EXEC = { agent: { session: { id: 'sess-tool-2' } }, signal: new AbortController().signal }

function toolOf(app, name) {
  const definition = app.tools.find(tool => tool.name === name)
  assert.ok(definition, `tool ${name} not registered`)
  return definition
}

const EXPECTED_TOOL_ISSUE = {
  repo: 'ceasarXuu/Astropath',
  number: 240,
  title: fixture.issue.title,
  url: 'https://github.com/ceasarXuu/Astropath/issues/240',
  state: 'open',
}

test('tool github_issue_bind binds the current session and renders text', async (t) => {
  const app = useApp(t)
  const tool = toolOf(app, 'github_issue_bind')
  const value = await tool.execute({ ref: 'ceasarXuu/Astropath#240' }, TOOL_EXEC)
  assert.deepEqual(value, { bound: true, issue: EXPECTED_TOOL_ISSUE, previous: null })

  const config = expectJson(await app.get('/config?sessionId=sess-tool-1'))
  assert.deepEqual(config.session.issue, EXPECTED_TOOL_ISSUE)
  assert.equal(app.readState().sessions['sess-tool-1'].issue.number, 240)

  const rendered = tool.output.render({ ref: 'ceasarXuu/Astropath#240' }, value)
  assert.deepEqual(rendered, [{ type: 'text', text: `已绑定 #240 ${fixture.issue.title}（ceasarXuu/Astropath）` }])
})

test('tool github_issue_bind refuses when the session is already bound', async (t) => {
  const app = useApp(t)
  const tool = toolOf(app, 'github_issue_bind')
  await tool.execute({ ref: 'ceasarXuu/Astropath#240' }, TOOL_EXEC)
  await assert.rejects(tool.execute({ ref: 'ceasarXuu/Astropath#240' }, TOOL_EXEC), (error) => {
    assert.equal(error.code, 'bad-request')
    assert.match(error.message, /already bound: ceasarXuu\/Astropath#240/u)
    return true
  })
})

test('tool github_issue_switch replaces the binding and reports the previous issue', async (t) => {
  const app = useApp(t)
  const bind = toolOf(app, 'github_issue_bind')
  const switchTool = toolOf(app, 'github_issue_switch')

  await assert.rejects(switchTool.execute({ ref: 'ceasarXuu/Astropath#240' }, TOOL_EXEC), (error) => {
    assert.equal(error.code, 'bad-request')
    assert.match(error.message, /not bound/u)
    return true
  })

  await bind.execute({ ref: 'ceasarXuu/Astropath#240' }, TOOL_EXEC)
  const value = await switchTool.execute({ ref: 'https://github.com/ceasarXuu/Astropath/issues/240' }, TOOL_EXEC)
  assert.deepEqual(value, { switched: true, issue: EXPECTED_TOOL_ISSUE, previous: EXPECTED_TOOL_ISSUE })
  const rendered = switchTool.output.render({}, value)
  assert.match(rendered[0].text, /已切换到 #240/u)
})

test('tool github_issue_unbind clears the binding and is idempotent', async (t) => {
  const app = useApp(t)
  const bind = toolOf(app, 'github_issue_bind')
  const unbind = toolOf(app, 'github_issue_unbind')

  // Nothing bound: still a successful no-op.
  assert.deepEqual(await unbind.execute({}, TOOL_EXEC), { unbound: true, previous: null })
  assert.deepEqual(unbind.output.render({}, { unbound: true, previous: null }), [
    { type: 'text', text: '当前会话未绑定 Issue' },
  ])

  await bind.execute({ ref: 'ceasarXuu/Astropath#240' }, TOOL_EXEC)
  const value = await unbind.execute({}, TOOL_EXEC)
  assert.deepEqual(value, { unbound: true, previous: EXPECTED_TOOL_ISSUE })
  assert.match(unbind.output.render({}, value)[0].text, /已解绑 #240/u)
  assert.equal(expectJson(await app.get('/config?sessionId=sess-tool-1')).session.issue, null)
  assert.deepEqual(await unbind.execute({}, TOOL_EXEC), { unbound: true, previous: null })
})

test('agent tools validate the calling session and the ref argument', async (t) => {
  const app = useApp(t)
  const bind = toolOf(app, 'github_issue_bind')
  for (const exec of [undefined, {}, { agent: {} }, { agent: { session: {} } }, { agent: { session: { id: '  ' } } }]) {
    await assert.rejects(bind.execute({ ref: 'ceasarXuu/Astropath#240' }, exec), (error) => {
      assert.match(error.message, /no current session/u)
      return true
    })
  }
  await assert.rejects(bind.execute({}, TOOL_EXEC), (error) => {
    assert.equal(error.code, 'bad-request')
    assert.match(error.message, /ref must be/u)
    return true
  })
  for (const args of [null, 'nope', 42, { ref: 'not a reference' }, { ref: 'https://github.com/a/b/pull/1' }]) {
    await assert.rejects(bind.execute(args, TOOL_EXEC), (error) => {
      assert.equal(error.code, 'bad-request')
      assert.match(error.message, /bad-request:/u)
      return true
    })
  }
})

test('agent tools surface gh failures with the contract code and never touch other sessions', async (t) => {
  const runner = createRunner(async (args) => {
    if (args[0] === 'api' && args[1] === 'repos/ceasarXuu/Astropath/issues/123') throw ghNotFound()
    return fixtureRun(args)
  })
  const app = useApp(t, { runner })
  const bind = toolOf(app, 'github_issue_bind')

  await assert.rejects(bind.execute({ ref: 'ceasarXuu/Astropath#123' }, TOOL_EXEC), (error) => {
    assert.equal(error.code, 'issue-not-found')
    assert.match(error.message, /^issue-not-found: /u)
    return true
  })

  await bind.execute({ ref: 'ceasarXuu/Astropath#240' }, TOOL_EXEC)
  // Session 2 is untouched, and its own tools address only its own id.
  assert.equal(expectJson(await app.get('/config?sessionId=sess-tool-2')).session.issue, null)
  const switchTool = toolOf(app, 'github_issue_switch')
  await assert.rejects(switchTool.execute({ ref: 'ceasarXuu/Astropath#240' }, OTHER_TOOL_EXEC), /not bound/u)
})

/* ------------------------------------------------------------------ */
/* Request gating                                                      */
/* ------------------------------------------------------------------ */

test('POST rejects hostile Origins with 403 and accepts the documented ones', async (t) => {
  const app = useApp(t)
  const payload = { sessionId: 's-gate' }
  const rejected = await app.post('/unbind-issue', payload, { headers: { origin: 'https://evil.example' } })
  expectErrorJson(rejected, 403, 'forbidden')

  for (const origin of ['dsh-app://app', 'http://127.0.0.1:49342', 'http://localhost:8080']) {
    const accepted = await app.post('/unbind-issue', payload, { headers: { origin } })
    assert.deepEqual(expectJson(accepted), { ok: true })
  }
  // No Origin header (curl / non-browser caller) is allowed.
  assert.deepEqual(expectJson(await app.post('/unbind-issue', payload)), { ok: true })
})

test('POST requires a JSON content type', async (t) => {
  const app = useApp(t)
  const send = (headers) => app.request({
    method: 'POST',
    url: `${APP_PREFIX}/unbind-issue`,
    headers,
    body: JSON.stringify({ sessionId: 's' }),
  })
  expectErrorJson(await send({}), 415, 'unsupported-media-type')
  expectErrorJson(await send({ 'content-type': 'text/plain' }), 415, 'unsupported-media-type')
  expectJson(await send({ 'content-type': 'application/json; charset=utf-8' }))
})

test('POST caps the body at 64 KiB and parses JSON defensively', async (t) => {
  const app = useApp(t)
  const tooLarge = await app.request({
    method: 'POST',
    url: `${APP_PREFIX}/unbind-issue`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'x'.repeat(70 * 1024) }),
  })
  expectErrorJson(tooLarge, 413, 'payload-too-large')

  expectErrorJson(await app.post('/unbind-issue', null, { raw: '{not json' }), 400, 'bad-request')
  expectErrorJson(await app.post('/unbind-issue', null, { raw: '[]' }), 400, 'bad-request')
  expectErrorJson(await app.post('/unbind-issue', null, { raw: '' }), 400, 'bad-request')
})

/* ------------------------------------------------------------------ */
/* Routing + error envelope basics                                     */
/* ------------------------------------------------------------------ */

test('unknown routes answer 404 with the error envelope', async (t) => {
  const app = useApp(t)
  expectErrorJson(await app.get('/nope'), 404, 'not-found')
  expectErrorJson(await app.get('/health/extra'), 404, 'not-found')
  expectErrorJson(await app.request({ method: 'PUT', url: `${APP_PREFIX}/health` }), 404, 'not-found')
  expectErrorJson(await app.request({ method: 'POST', url: `${APP_PREFIX}/health`, headers: { 'content-type': 'application/json' }, body: '{}' }), 404, 'not-found')
})

test('malformed percent-encoding in the URL answers 400', async (t) => {
  const app = useApp(t)
  expectErrorJson(
    await app.request({ method: 'GET', url: `${APP_PREFIX}/issue?repo=%E0%A4%A&number=1` }),
    400,
    'bad-request',
  )
  expectErrorJson(
    await app.request({ method: 'GET', url: `${APP_PREFIX}/items?owner=%ZZ&number=1` }),
    400,
    'bad-request',
  )
})

/* ------------------------------------------------------------------ */
/* Failure modes: no gh, bad credentials, unwritable state             */
/* ------------------------------------------------------------------ */

test('without gh: /health and /config still work, GitHub reads answer 503 gh-missing', async (t) => {
  const runner = createRunner(async () => { throw ghMissingError() })
  const app = useApp(t, { runner })

  const health = expectJson(await app.get('/health'))
  assert.equal(health.ok, true)
  assert.equal(health.gh.available, false)
  assert.match(health.gh.error, /找不到 GitHub CLI/u)

  const config = expectJson(await app.get('/config?workspaceId=w'))
  assert.deepEqual(config.workspace, { workspaceId: 'w', project: null })
  assert.equal(config.gh.available, false)

  expectErrorJson(await app.get('/projects'), 503, 'gh-missing')
  expectErrorJson(await app.get('/items?owner=ceasarXuu&number=9'), 503, 'gh-missing')
  expectErrorJson(await app.get('/issue?repo=ceasarXuu/Astropath&number=240'), 503, 'gh-missing')
})

test('bad credentials answer 503 gh-auth for GitHub reads', async (t) => {
  const runner = createRunner(async () => { throw ghAuthError() })
  const app = useApp(t, { runner })
  expectErrorJson(await app.get('/projects'), 503, 'gh-auth')
  const health = expectJson(await app.get('/health'))
  assert.equal(health.gh.available, false)
  assert.equal(health.gh.account, null)
})

test('an unwritable state file answers 500 state-write-failed without crashing', async (t) => {
  const app = useApp(t)
  // A directory in place of the state file makes the atomic rename fail while
  // leaving the rest of the host alive.
  mkdirSync(app.statePath, { recursive: true })
  const response = await app.post('/bind-workspace', { workspaceId: 'w', project: PROJECT })
  expectErrorJson(response, 500, 'state-write-failed')
  // The API still answers afterwards.
  const health = expectJson(await app.get('/health'))
  assert.equal(health.ok, true)
})

test('responses never echo environment variables or tokens', async (t) => {
  const app = useApp(t)
  const config = expectJson(await app.get('/config'))
  const serialized = JSON.stringify(config)
  for (const secret of [process.env.HOME, process.env.PATH, process.env.DSH_HOME]) {
    if (typeof secret === 'string' && secret.length > 8) assert.ok(!serialized.includes(secret))
  }
  assert.ok(!serialized.includes('token'))
})
