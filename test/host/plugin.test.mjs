/**
 * End-to-end-ish tests of the host HTTP API (contract §3.1): a fake
 * `webServer` service captures the single prefix route, then every endpoint is
 * driven through the real handler with a fake `gh` runner and a temp state
 * file. Also covers request gating, caching/single-flight, error envelopes,
 * and the no-`gh` degradation path.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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
  ghError,
  ghMissingError,
  ghNotFound,
  PROJECT_META_IDS,
  startApp,
} from './support.mjs'

const PROJECT = {
  owner: 'ceasarXuu',
  ownerType: 'user',
  number: 9,
  title: 'web-issues',
  url: 'https://github.com/users/ceasarXuu/projects/9',
  itemCount: 195,
  closed: false,
  description: null,
}

const ISSUE_SUMMARY = {
  repo: 'acme/web',
  number: 240,
  title: 'Tidy label picker',
  url: 'https://github.com/acme/web/issues/240',
  state: 'open',
}

const SECOND_ISSUE_SUMMARY = {
  repo: 'acme/web',
  number: 91,
  title: 'Refactor export format',
  url: 'https://github.com/acme/web/issues/91',
  state: 'closed',
}

const sleep = (ms) => new Promise(resolve => { setTimeout(resolve, ms) })
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u

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
  assert.deepEqual(Object.keys(cold).sort(), ['gh', 'session', 'workspace', 'writes'])
  assert.deepEqual(cold.workspace, { workspaceId: 'ws-123', project: null })
  assert.deepEqual(cold.session, { sessionId: 'session-abc', issue: null, workspaceId: 'ws-123' })
  assert.deepEqual(cold.gh, { available: false, version: null, account: null, error: 'pending' })
  // v1.1.0: writes are opt-in, so the default host reports writes.allowed=false.
  assert.deepEqual(cold.writes, { allowed: false })
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
/* GET /bindings (v0.4.1 sidebar decoration)                           */
/* ------------------------------------------------------------------ */

test('GET /bindings returns the empty binding map and never invokes gh', async (t) => {
  const app = useApp(t)
  const started = Date.now()
  const body = expectJson(await app.get('/bindings'))
  const elapsed = Date.now() - started
  assert.deepEqual(Object.keys(body).sort(), ['sessions', 'updatedAt', 'workspaces'])
  assert.deepEqual(body.sessions, {})
  assert.deepEqual(body.workspaces, {})
  assert.match(body.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  assert.ok(Number.isFinite(Date.parse(body.updatedAt)))
  assert.ok(elapsed < 50, `/bindings took ${String(elapsed)}ms`)
  // Local store only: not even the cached gh health probe is touched.
  assert.equal(app.calls.length, 0)
})

test('GET /bindings returns every bound session with exact IssueSummary fields', async (t) => {
  const app = useApp(t)
  await app.post('/bind-issue', { sessionId: 'session-A', workspaceId: 'ws-1', issue: ISSUE_SUMMARY })
  await app.post('/bind-issue', { sessionId: 'session-B', issue: SECOND_ISSUE_SUMMARY })
  assert.equal(app.calls.length, 0, 'complete-summary binds must not read gh')

  const body = expectJson(await app.get('/bindings'))
  assert.deepEqual(body.sessions, {
    'session-A': ISSUE_SUMMARY,
    'session-B': SECOND_ISSUE_SUMMARY,
  })
  assert.deepEqual(body.workspaces, {}, 'no workspace is bound yet')
  // Only the BindingsResponse keys; no workspace map and no stale field.
  assert.deepEqual(Object.keys(body.sessions).sort(), ['session-A', 'session-B'])
  assert.deepEqual(Object.keys(body.sessions['session-A']).sort(), ['number', 'repo', 'state', 'title', 'url'])
  assert.equal(app.calls.length, 0, '/bindings must never invoke gh')
})

test('GET /bindings includes workspace → Project bindings with exact stored fields', async (t) => {
  const app = useApp(t)
  const secondProject = { ...PROJECT, number: 8, title: 'api-issues', url: 'https://github.com/users/ceasarXuu/projects/8', itemCount: 9 }

  await app.post('/bind-workspace', { workspaceId: 'ws-1', project: PROJECT })
  await app.post('/bind-workspace', { workspaceId: 'ws-2', project: secondProject })
  await app.post('/bind-issue', { sessionId: 'session-A', workspaceId: 'ws-1', issue: ISSUE_SUMMARY })
  await app.post('/bind-issue', { sessionId: 'session-B', issue: SECOND_ISSUE_SUMMARY })
  assert.equal(app.calls.length, 0, '/bindings reads must not touch gh')

  const body = expectJson(await app.get('/bindings'))
  assert.deepEqual(body.workspaces, { 'ws-1': PROJECT, 'ws-2': secondProject })
  assert.deepEqual(Object.keys(body.workspaces['ws-1']).sort(), [
    'closed', 'description', 'itemCount', 'number', 'owner', 'ownerType', 'title', 'url',
  ])
  assert.deepEqual(body.sessions, { 'session-A': ISSUE_SUMMARY, 'session-B': SECOND_ISSUE_SUMMARY })

  // Unbinding one workspace removes only that entry; sessions are unaffected.
  expectJson(await app.post('/unbind-workspace', { workspaceId: 'ws-1' }))
  const afterUnbind = expectJson(await app.get('/bindings'))
  assert.deepEqual(afterUnbind.workspaces, { 'ws-2': secondProject })
  assert.deepEqual(afterUnbind.sessions, body.sessions)
  assert.equal(app.calls.length, 0)

  // Query parameters stay irrelevant for both maps.
  const withQuery = expectJson(await app.get('/bindings?workspaceId=ws-1&refresh=1&bogus=1'))
  assert.deepEqual(withQuery.workspaces, afterUnbind.workspaces)
  assert.deepEqual(withQuery.sessions, afterUnbind.sessions)
  assert.equal(app.calls.length, 0)
})

test('GET /bindings removes unbound sessions and ignores unknown request state', async (t) => {
  const app = useApp(t)
  await app.post('/bind-issue', { sessionId: 'session-A', workspaceId: 'ws-1', issue: ISSUE_SUMMARY })
  await app.post('/bind-issue', { sessionId: 'session-B', issue: SECOND_ISSUE_SUMMARY })

  await app.post('/unbind-issue', { sessionId: 'session-A' })
  const afterUnbind = expectJson(await app.get('/bindings'))
  assert.deepEqual(Object.keys(afterUnbind.sessions), ['session-B'])

  // Arbitrary query parameters/ids are irrelevant to this route.
  const withQuery = expectJson(await app.get('/bindings?sessionId=session-A&workspaceId=nope&refresh=1'))
  assert.deepEqual(withQuery.sessions, afterUnbind.sessions)
  assert.deepEqual(withQuery.workspaces, {})
  assert.equal(app.calls.length, 0)
})

test('GET /bindings stays cheap and never invokes a hanging gh runner', async (t) => {
  // Every gh invocation would hang forever; /bindings must not start one.
  const runner = createRunner(async () => new Promise(() => {}))
  const app = useApp(t, { runner })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = Date.now()
    const body = expectJson(await app.get('/bindings'))
    assert.ok(Date.now() - started < 50, `/bindings blocked ${String(Date.now() - started)}ms`)
    assert.deepEqual(body.sessions, {})
    assert.deepEqual(body.workspaces, {})
  }
  assert.equal(app.calls.length, 0, 'a hanging gh runner was invoked by /bindings')
  assert.equal(app.routes.length, 1, 'still the single prefix route (no extra registration)')
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
    { login: 'acme-labs', type: 'organization' },
    { login: 'northwind', type: 'organization' },
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
  assert.equal(body.project.title, 'web-issues')
  assert.equal(body.project.itemCount, 195)
  assert.equal(body.project.closed, false)
  assert.equal(body.items.length, 195)
  assert.equal(body.truncated, false)
  assert.equal(body.stale, false)
  assert.equal(body.items[0].type, 'issue')
  assert.equal(body.items[0].number, 240)
  assert.equal(body.items[0].repo, 'acme/web')
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
/* v1.1.0 opt-in writes: /config.writes, /project-meta, /item-status   */
/* ------------------------------------------------------------------ */

/** The real item id of issue #240 in Project 9 (fixture `graphql-items-page1`). */
const ITEM_240_ID = 'PVTI_lAHOAwDbXM4Bocj3zhDFfBs'

/** `gh api graphql` invocations whose query text matches `pattern`. */
function graphqlQueries(app, pattern) {
  return app.calls.filter(args => (
    args[0] === 'api'
    && args[1] === 'graphql'
    && args.some(arg => typeof arg === 'string' && pattern.test(arg))
  ))
}

const metaCalls = (app) => graphqlQueries(app, /field\(name:"Status"\)/u)
const itemPageCalls = (app) => graphqlQueries(app, /items\(first:/u)
const mutationCalls = (app) => graphqlQueries(app, /updateProjectV2ItemFieldValue|clearProjectV2ItemFieldValue/u)

test('GET /config reports writes.allowed from the opt-in allowWrites config', async (t) => {
  const readOnly = useApp(t)
  assert.deepEqual(expectJson(await readOnly.get('/config')).writes, { allowed: false })
  // `allowWrites` is strict opt-in: only an explicit boolean true enables writes.
  for (const value of [false, 'true', 1, undefined]) {
    const app = useApp(t, { config: { allowWrites: value } })
    assert.deepEqual(expectJson(await app.get('/config')).writes, { allowed: false })
  }
  const writable = useApp(t, { config: { allowWrites: true } })
  assert.deepEqual(expectJson(await writable.get('/config')).writes, { allowed: true })
})

test('GET /project-meta returns the Project node id and Status field options', async (t) => {
  const app = useApp(t)
  const body = expectJson(await app.get('/project-meta?owner=ceasarXuu&number=9'))
  assert.deepEqual(Object.keys(body).sort(), ['fetchedAt', 'project', 'stale', 'statusField'])
  assert.deepEqual(body.project, {
    id: PROJECT_META_IDS.projectId,
    owner: 'ceasarXuu',
    number: 9,
    title: 'web-issues',
  })
  assert.equal(body.statusField.id, PROJECT_META_IDS.statusFieldId)
  assert.equal(body.statusField.name, 'Status')
  assert.deepEqual(body.statusField.options, [
    { id: PROJECT_META_IDS.options.TODO, name: 'TODO' },
    { id: PROJECT_META_IDS.options['In Progress'], name: 'In Progress' },
    { id: PROJECT_META_IDS.options['In Review'], name: 'In Review' },
    { id: PROJECT_META_IDS.options.Done, name: 'Done' },
  ])
  assert.equal(body.stale, false)
  assert.match(body.fetchedAt, ISO_TIMESTAMP)

  // One GraphQL read, then the SWR cache; `refresh=1` forces a fresh read.
  assert.equal(metaCalls(app).length, 1)
  const cached = expectJson(await app.get('/project-meta?owner=ceasarXuu&number=9'))
  assert.equal(cached.fetchedAt, body.fetchedAt)
  assert.equal(metaCalls(app).length, 1)
  expectJson(await app.get('/project-meta?owner=ceasarXuu&number=9&refresh=1'))
  assert.equal(metaCalls(app).length, 2)
})

test('GET /project-meta maps a missing Project to 404 and bad params to 400', async (t) => {
  const app = useApp(t)
  expectErrorJson(await app.get('/project-meta?owner=ceasarXuu&number=99999'), 404, 'project-not-found')
  expectErrorJson(await app.get('/project-meta?owner=bad/owner&number=9'), 400, 'bad-request')
  expectErrorJson(await app.get('/project-meta?owner=ceasarXuu&number=abc'), 400, 'bad-request')
  expectErrorJson(await app.get('/project-meta?owner=ceasarXuu'), 400, 'bad-request')
})

test('POST /item-status is refused with 403 writes-disabled when allowWrites is false', async (t) => {
  const app = useApp(t)
  const payload = {
    owner: 'ceasarXuu',
    number: 9,
    itemId: ITEM_240_ID,
    optionId: PROJECT_META_IDS.options['In Review'],
  }
  const error = expectErrorJson(await app.post('/item-status', payload), 403, 'writes-disabled')
  assert.match(error.message, /allowWrites/u)
  // Refused before any gh read or mutation.
  assert.deepEqual(app.calls, [])
  // The gate runs before body parsing: even a malformed body is writes-disabled.
  expectErrorJson(await app.post('/item-status', null, { raw: '{not json' }), 403, 'writes-disabled')
  assert.deepEqual(app.calls, [])
})

test('POST /item-status moves an item and returns the applied Status', async (t) => {
  const app = useApp(t, { config: { allowWrites: true } })
  const body = expectJson(await app.post('/item-status', {
    owner: 'ceasarXuu',
    number: 9,
    itemId: ITEM_240_ID,
    optionId: PROJECT_META_IDS.options['In Review'],
  }))
  assert.deepEqual(Object.keys(body).sort(), ['fetchedAt', 'item', 'status'])
  assert.deepEqual(body.item, { id: ITEM_240_ID })
  assert.deepEqual(body.status, { optionId: PROJECT_META_IDS.options['In Review'], name: 'In Review' })
  assert.match(body.fetchedAt, ISO_TIMESTAMP)

  const calls = mutationCalls(app)
  assert.equal(calls.length, 1)
  const command = calls[0].join(' ')
  assert.match(command, /updateProjectV2ItemFieldValue/u)
  assert.ok(command.includes(`-f projectId=${PROJECT_META_IDS.projectId}`))
  assert.ok(command.includes(`-f itemId=${ITEM_240_ID}`))
  assert.ok(command.includes(`-f fieldId=${PROJECT_META_IDS.statusFieldId}`))
  assert.ok(command.includes(`-f optionId=${PROJECT_META_IDS.options['In Review']}`))
  assert.ok(!command.includes('clearProjectV2ItemFieldValue'))
  // The host resolves projectId/fieldId itself with one metadata read.
  assert.equal(metaCalls(app).length, 1)
})

test('POST /item-status handles the real all-digit Done option id', async (t) => {
  // Real Projects option ids: TODO `8fc1d6c9`, In Progress `47fc9ee4`,
  // In Review `edd18149`, Done `98236657`. `gh -F` would infer the last as a
  // JSON number, so mutation variables are passed raw (`-f`) and the mutation
  // declares the GitHub schema's `singleSelectOptionId: String`.
  assert.equal(PROJECT_META_IDS.options.Done, '98236657')
  assert.match(PROJECT_META_IDS.options['In Review'], /^[a-z0-9]+$/u)
  const app = useApp(t, { config: { allowWrites: true } })
  const body = expectJson(await app.post('/item-status', {
    owner: 'ceasarXuu',
    number: 9,
    itemId: ITEM_240_ID,
    optionId: PROJECT_META_IDS.options.Done,
  }))
  assert.deepEqual(body.status, { optionId: '98236657', name: 'Done' })
  const command = mutationCalls(app)[0].join(' ')
  assert.ok(command.includes('-f optionId=98236657'))
  assert.match(command, /\$optionId:String!/u)
})

test('POST /item-status with optionId:null clears the Status field', async (t) => {
  const app = useApp(t, { config: { allowWrites: true } })
  const body = expectJson(await app.post('/item-status', {
    owner: 'ceasarXuu',
    number: 9,
    itemId: ITEM_240_ID,
    optionId: null,
  }))
  assert.deepEqual(body.item, { id: ITEM_240_ID })
  assert.deepEqual(body.status, { optionId: null, name: null })

  const calls = mutationCalls(app)
  assert.equal(calls.length, 1)
  const command = calls[0].join(' ')
  assert.match(command, /clearProjectV2ItemFieldValue/u)
  assert.ok(!command.includes('optionId='))
  assert.ok(command.includes(`-f itemId=${ITEM_240_ID}`))
})

test('POST /item-status rejects an unknown option id with 400 and writes nothing', async (t) => {
  const app = useApp(t, { config: { allowWrites: true } })
  const error = expectErrorJson(await app.post('/item-status', {
    owner: 'ceasarXuu',
    number: 9,
    itemId: ITEM_240_ID,
    optionId: 'f0000000',
  }), 400, 'bad-request')
  assert.match(error.message, /未知的 Status 选项/u)
  assert.deepEqual(mutationCalls(app), [])
})

test('POST /item-status validates the ItemStatusRequest body', async (t) => {
  const app = useApp(t, { config: { allowWrites: true } })
  const valid = { owner: 'ceasarXuu', number: 9, itemId: ITEM_240_ID, optionId: null }
  expectErrorJson(await app.post('/item-status', { ...valid, owner: 'bad/owner' }), 400, 'bad-request')
  expectErrorJson(await app.post('/item-status', { ...valid, number: 0 }), 400, 'bad-request')
  expectErrorJson(await app.post('/item-status', { ...valid, itemId: 'not-a-node-id' }), 400, 'bad-request')
  expectErrorJson(await app.post('/item-status', { ...valid, itemId: undefined }), 400, 'bad-request')
  // optionId is required: an omitted field is not an implicit clear.
  expectErrorJson(
    await app.post('/item-status', { owner: 'ceasarXuu', number: 9, itemId: ITEM_240_ID }),
    400,
    'bad-request',
  )
  expectErrorJson(await app.post('/item-status', { ...valid, optionId: '' }), 400, 'bad-request')
  expectErrorJson(await app.post('/item-status', { ...valid, optionId: '   ' }), 400, 'bad-request')
  expectErrorJson(await app.post('/item-status', { ...valid, optionId: 42 }), 400, 'bad-request')
  assert.deepEqual(mutationCalls(app), [])
})

test('POST /item-status maps a GraphQL NOT_FOUND write error to 404 item-not-found', async (t) => {
  const runner = createRunner(async (args) => {
    if (args[0] === 'api' && args[1] === 'graphql') {
      const query = args.find(arg => typeof arg === 'string' && arg.startsWith('query=')) ?? ''
      if (/updateProjectV2ItemFieldValue/u.test(query)) {
        throw ghError("gh: Could not resolve to a node with the global id of 'PVTI_stale'")
      }
    }
    return fixtureRun(args)
  })
  const app = useApp(t, { runner, config: { allowWrites: true } })
  const error = expectErrorJson(await app.post('/item-status', {
    owner: 'ceasarXuu',
    number: 9,
    itemId: 'PVTI_stale',
    optionId: PROJECT_META_IDS.options.Done,
  }), 404, 'item-not-found')
  assert.match(error.message, /找不到该 Project 条目/u)
})

test('POST /item-status maps a missing project scope to 503 gh-auth with the refresh hint', async (t) => {
  const runner = createRunner(async (args) => {
    if (args[0] === 'api' && args[1] === 'graphql') {
      const query = args.find(arg => typeof arg === 'string' && arg.startsWith('query=')) ?? ''
      if (/clearProjectV2ItemFieldValue/u.test(query)) {
        throw ghError('gh: Your token has not been granted the required scopes to execute this query.')
      }
    }
    return fixtureRun(args)
  })
  const app = useApp(t, { runner, config: { allowWrites: true } })
  const error = expectErrorJson(await app.post('/item-status', {
    owner: 'ceasarXuu',
    number: 9,
    itemId: ITEM_240_ID,
    optionId: null,
  }), 503, 'gh-auth')
  assert.match(error.message, /gh auth refresh -s project/u)
})

test('POST /item-status maps a missing Project to 404 project-not-found', async (t) => {
  const app = useApp(t, { config: { allowWrites: true } })
  expectErrorJson(await app.post('/item-status', {
    owner: 'ceasarXuu',
    number: 99999,
    itemId: ITEM_240_ID,
    optionId: null,
  }), 404, 'project-not-found')
})

test('POST /item-status invalidates the items SWR entry so the next /items re-reads', async (t) => {
  const app = useApp(t, { config: { allowWrites: true, cacheTtlMs: 60_000 } })
  const itemsUrl = '/items?owner=ceasarXuu&number=9'
  expectJson(await app.get(itemsUrl))
  assert.equal(itemPageCalls(app).length, 2, '195 items are two GraphQL pages')
  // Warm cache: a second /items read must not touch gh.
  expectJson(await app.get(itemsUrl))
  assert.equal(itemPageCalls(app).length, 2)

  expectJson(await app.post('/item-status', {
    owner: 'ceasarXuu',
    number: 9,
    itemId: ITEM_240_ID,
    optionId: PROJECT_META_IDS.options.Done,
  }))
  const refreshed = expectJson(await app.get(itemsUrl))
  assert.equal(itemPageCalls(app).length, 4, 'the write must invalidate the cached item list')
  assert.equal(refreshed.stale, false)
})

/* ------------------------------------------------------------------ */
/* GET /issue                                                          */
/* ------------------------------------------------------------------ */

test('GET /issue returns a contract IssueDetail with comments', async (t) => {
  const app = useApp(t)
  const body = expectJson(await app.get('/issue?repo=acme/web&number=240'))
  assert.deepEqual(Object.keys(body).sort(), ['fetchedAt', 'issue', 'stale'])
  assert.equal(body.stale, false)
  const issue = body.issue
  assert.equal(issue.repo, 'acme/web')
  assert.equal(issue.number, 240)
  assert.equal(issue.title, fixture.issue.title)
  assert.equal(issue.url, 'https://github.com/acme/web/issues/240')
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
  const pr = expectErrorJson(await app.get('/issue?repo=acme/web&number=283'), 404, 'issue-not-found')
  assert.equal(pr.message, '这是 Pull Request')
  expectErrorJson(await app.get('/issue?repo=not-a-repo&number=1'), 400, 'bad-request')
  expectErrorJson(await app.get('/issue?repo=acme/web&number=0'), 400, 'bad-request')
  expectErrorJson(await app.get('/issue?repo=acme/web'), 400, 'bad-request')
})

test('GET /issue caches per repo#number and shares one in-flight read', async (t) => {
  let issueReads = 0
  const runner = createRunner(async (args) => {
    if (args[0] === 'api' && args[1] === 'repos/acme/web/issues/240') {
      issueReads += 1
      await sleep(30)
      return { stdout: `${JSON.stringify(fixture.issue)}\n`, stderr: '' }
    }
    return fixtureRun(args)
  })
  const app = useApp(t, { runner, config: { cacheTtlMs: 60_000 } })
  const url = '/issue?repo=acme/web&number=240'

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
    ref: 'https://github.com/acme/web/issues/240',
  }))
  assert.deepEqual(fromUrl.session.issue, {
    repo: 'acme/web',
    number: 240,
    title: fixture.issue.title,
    url: 'https://github.com/acme/web/issues/240',
    state: 'open',
  })

  const fromShort = expectJson(await app.post('/bind-issue', {
    sessionId: 's-short',
    ref: 'acme/web#240',
  }))
  assert.equal(fromShort.session.issue.number, 240)
})

test('POST /bind-issue completes a partial summary from one gh read', async (t) => {
  const app = useApp(t)
  const body = expectJson(await app.post('/bind-issue', {
    sessionId: 's-partial',
    workspaceId: 'w1',
    issue: { repo: 'acme/web', number: 240 },
  }))
  assert.equal(body.session.issue.title, fixture.issue.title)
  assert.equal(body.session.issue.url, 'https://github.com/acme/web/issues/240')
  assert.equal(body.session.issue.state, 'open')
})

test('POST /bind-issue maps bad refs to 400 and missing Issues to 404', async (t) => {
  const app = useApp(t)
  expectErrorJson(await app.post('/bind-issue', { sessionId: 's', ref: 'not a ref' }), 400, 'bad-request')
  expectErrorJson(await app.post('/bind-issue', { sessionId: 's' }), 400, 'bad-request')
  expectErrorJson(await app.post('/bind-issue', { ref: 'acme/web#240' }), 400, 'bad-request')
  expectErrorJson(await app.post('/bind-issue', { sessionId: 's', issue: { repo: 'bad', number: 1 } }), 400, 'bad-request')

  const runner = createRunner(async (args) => {
    if (args[0] === 'api' && args[1] === 'repos/acme/web/issues/123') throw ghNotFound()
    return fixtureRun(args)
  })
  const app404 = useApp(t, { runner })
  expectErrorJson(await app404.post('/bind-issue', { sessionId: 's', ref: 'acme/web#123' }), 404, 'issue-not-found')
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
  repo: 'acme/web',
  number: 240,
  title: fixture.issue.title,
  url: 'https://github.com/acme/web/issues/240',
  state: 'open',
}

test('tool github_issue_bind binds the current session and renders text', async (t) => {
  const app = useApp(t)
  const tool = toolOf(app, 'github_issue_bind')
  const value = await tool.execute({ ref: 'acme/web#240' }, TOOL_EXEC)
  assert.deepEqual(value, { bound: true, issue: EXPECTED_TOOL_ISSUE, previous: null })

  const config = expectJson(await app.get('/config?sessionId=sess-tool-1'))
  assert.deepEqual(config.session.issue, EXPECTED_TOOL_ISSUE)
  assert.equal(app.readState().sessions['sess-tool-1'].issue.number, 240)

  const rendered = tool.output.render({ ref: 'acme/web#240' }, value)
  assert.deepEqual(rendered, [{ type: 'text', text: `已绑定 #240 ${fixture.issue.title}（acme/web）` }])
})

test('tool github_issue_bind refuses when the session is already bound', async (t) => {
  const app = useApp(t)
  const tool = toolOf(app, 'github_issue_bind')
  await tool.execute({ ref: 'acme/web#240' }, TOOL_EXEC)
  await assert.rejects(tool.execute({ ref: 'acme/web#240' }, TOOL_EXEC), (error) => {
    assert.equal(error.code, 'bad-request')
    assert.match(error.message, /already bound: ceasarXuu\/web#240/u)
    return true
  })
})

test('tool github_issue_switch replaces the binding and reports the previous issue', async (t) => {
  const app = useApp(t)
  const bind = toolOf(app, 'github_issue_bind')
  const switchTool = toolOf(app, 'github_issue_switch')

  await assert.rejects(switchTool.execute({ ref: 'acme/web#240' }, TOOL_EXEC), (error) => {
    assert.equal(error.code, 'bad-request')
    assert.match(error.message, /not bound/u)
    return true
  })

  await bind.execute({ ref: 'acme/web#240' }, TOOL_EXEC)
  const value = await switchTool.execute({ ref: 'https://github.com/acme/web/issues/240' }, TOOL_EXEC)
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

  await bind.execute({ ref: 'acme/web#240' }, TOOL_EXEC)
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
    await assert.rejects(bind.execute({ ref: 'acme/web#240' }, exec), (error) => {
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
    if (args[0] === 'api' && args[1] === 'repos/acme/web/issues/123') throw ghNotFound()
    return fixtureRun(args)
  })
  const app = useApp(t, { runner })
  const bind = toolOf(app, 'github_issue_bind')

  await assert.rejects(bind.execute({ ref: 'acme/web#123' }, TOOL_EXEC), (error) => {
    assert.equal(error.code, 'issue-not-found')
    assert.match(error.message, /^issue-not-found: /u)
    return true
  })

  await bind.execute({ ref: 'acme/web#240' }, TOOL_EXEC)
  // Session 2 is untouched, and its own tools address only its own id.
  assert.equal(expectJson(await app.get('/config?sessionId=sess-tool-2')).session.issue, null)
  const switchTool = toolOf(app, 'github_issue_switch')
  await assert.rejects(switchTool.execute({ ref: 'acme/web#240' }, OTHER_TOOL_EXEC), /not bound/u)
})

/* ------------------------------------------------------------------ */
/* v1.1.0 github_project_item_status (write tool, allowWrites only)    */
/* ------------------------------------------------------------------ */

const ITEM_STATUS_TOOL = 'github_project_item_status'

/** Apply the plugin with writes enabled (and, when given, a custom runner). */
function writableApp(t, options = {}) {
  return useApp(t, { ...options, config: { allowWrites: true, ...options.config } })
}

/** Bind `ws-1` → PROJECT and the session → an Issue in that workspace. */
async function bindToolSession(app, { sessionId = 'sess-tool-1', workspaceId = 'ws-1' } = {}) {
  expectJson(await app.post('/bind-workspace', { workspaceId, project: PROJECT }))
  expectJson(await app.post('/bind-issue', { sessionId, workspaceId, issue: ISSUE_SUMMARY }))
}

test('the write tool is registered only when allowWrites is true', (t) => {
  const readOnly = useApp(t)
  assert.deepEqual(readOnly.tools.map(definition => definition.name), [
    'github_issue_bind',
    'github_issue_switch',
    'github_issue_unbind',
  ])
  assert.equal(readOnly.tools.some(definition => definition.name === ITEM_STATUS_TOOL), false)

  const writable = writableApp(t)
  assert.deepEqual(writable.tools.map(definition => definition.name), [
    'github_issue_bind',
    'github_issue_switch',
    'github_issue_unbind',
    ITEM_STATUS_TOOL,
  ])
  const definition = toolOf(writable, ITEM_STATUS_TOOL)
  assert.equal(typeof definition.description, 'string')
  assert.match(definition.description, /Status/u)
  assert.equal(definition.parameters.type, 'object')
  assert.deepEqual(definition.parameters.required, ['status'])
  assert.deepEqual(Object.keys(definition.parameters.properties).sort(), ['itemId', 'number', 'repo', 'status'])
  assert.equal(typeof definition.output.schema, 'object')
  assert.equal(typeof definition.output.render, 'function')
  assert.equal(typeof definition.execute, 'function')
})

test('tool github_project_item_status moves an item resolved from a content reference', async (t) => {
  const app = writableApp(t)
  await bindToolSession(app)
  const tool = toolOf(app, ITEM_STATUS_TOOL)
  const expectedTitle = fixture.graphqlItemsPage1.data.repositoryOwner.projectV2.items.nodes[0].content.title

  const value = await tool.execute({ repo: 'acme/web', number: 240, status: 'in review' }, TOOL_EXEC)
  assert.deepEqual(value, {
    moved: true,
    item: {
      id: ITEM_240_ID,
      repo: 'acme/web',
      number: 240,
      title: expectedTitle,
    },
    previous: { optionId: PROJECT_META_IDS.options['In Progress'], name: 'In Progress' },
    status: { optionId: PROJECT_META_IDS.options['In Review'], name: 'In Review' },
  })
  assert.deepEqual(tool.output.render({}, value), [{ type: 'text', text: '已把 #240 移到 In Review' }])

  const calls = mutationCalls(app)
  assert.equal(calls.length, 1)
  const command = calls[0].join(' ')
  assert.match(command, /updateProjectV2ItemFieldValue/u)
  assert.ok(command.includes(`-f projectId=${PROJECT_META_IDS.projectId}`))
  assert.ok(command.includes(`-f itemId=${ITEM_240_ID}`))
  assert.ok(command.includes(`-f fieldId=${PROJECT_META_IDS.statusFieldId}`))
  assert.ok(command.includes(`-f optionId=${PROJECT_META_IDS.options['In Review']}`))
  // The content reference is resolved by paging the items read (one page hit).
  assert.equal(itemPageCalls(app).length, 1)
})

test('tool github_project_item_status accepts an itemId locator and clears with status:null', async (t) => {
  const app = writableApp(t)
  await bindToolSession(app)
  const tool = toolOf(app, ITEM_STATUS_TOOL)

  const value = await tool.execute({ itemId: ITEM_240_ID, status: null }, TOOL_EXEC)
  assert.deepEqual(value.status, { optionId: null, name: null })
  assert.deepEqual(value.previous, { optionId: PROJECT_META_IDS.options['In Progress'], name: 'In Progress' })
  assert.equal(value.item.id, ITEM_240_ID)
  assert.equal(value.item.number, 240)
  assert.match(tool.output.render({}, value)[0].text, /已把 #240 的状态清除/u)

  const calls = mutationCalls(app)
  assert.equal(calls.length, 1)
  const command = calls[0].join(' ')
  assert.match(command, /clearProjectV2ItemFieldValue/u)
  assert.ok(!command.includes('optionId='))
  assert.ok(command.includes(`-f itemId=${ITEM_240_ID}`))
})

test('tool github_project_item_status rejects an unknown status and lists the valid names', async (t) => {
  const app = writableApp(t)
  await bindToolSession(app)
  const tool = toolOf(app, ITEM_STATUS_TOOL)
  await assert.rejects(tool.execute({ repo: 'acme/web', number: 240, status: 'Blocked' }, TOOL_EXEC), (error) => {
    assert.equal(error.code, 'bad-request')
    assert.match(error.message, /^bad-request: /u)
    assert.match(error.message, /unknown status/u)
    for (const name of ['TODO', 'In Progress', 'In Review', 'Done']) {
      assert.ok(error.message.includes(name), `valid status ${name} missing from: ${error.message}`)
    }
    return true
  })
  assert.deepEqual(mutationCalls(app), [])
})

test('tool github_project_item_status requires exactly one item locator', async (t) => {
  const app = writableApp(t)
  await bindToolSession(app)
  const tool = toolOf(app, ITEM_STATUS_TOOL)
  const cases = [
    { status: 'TODO' },
    { itemId: ITEM_240_ID, repo: 'acme/web', number: 240, status: 'TODO' },
    { repo: 'acme/web', status: 'TODO' },
    { number: 240, status: 'TODO' },
    { repo: 'acme/web', number: 240 },
    { repo: 'bad repo', number: 240, status: 'TODO' },
    { repo: 'acme/web', number: 0, status: 'TODO' },
    { itemId: ITEM_240_ID, status: '  ' },
    { itemId: ITEM_240_ID },
    null,
    'nope',
  ]
  for (const args of cases) {
    await assert.rejects(tool.execute(args, TOOL_EXEC), (error) => {
      assert.equal(error.code, 'bad-request', `args: ${JSON.stringify(args)}`)
      assert.match(error.message, /^bad-request: /u)
      return true
    })
  }
  assert.deepEqual(mutationCalls(app), [])
})

test('tool github_project_item_status requires the session workspace-bound Project', async (t) => {
  const app = writableApp(t)
  const tool = toolOf(app, ITEM_STATUS_TOOL)

  // The calling session has no binding at all.
  await assert.rejects(tool.execute({ repo: 'acme/web', number: 240, status: 'TODO' }, TOOL_EXEC), (error) => {
    assert.equal(error.code, 'project-not-found')
    assert.match(error.message, /bind a Project first/u)
    return true
  })

  // The session knows a workspace, but that workspace has no Project.
  expectJson(await app.post('/bind-issue', {
    sessionId: 'sess-tool-1',
    workspaceId: 'ws-unbound',
    issue: ISSUE_SUMMARY,
  }))
  await assert.rejects(tool.execute({ itemId: ITEM_240_ID, status: 'TODO' }, TOOL_EXEC), (error) => {
    assert.equal(error.code, 'project-not-found')
    assert.match(error.message, /bind a Project first/u)
    return true
  })
  assert.deepEqual(mutationCalls(app), [])
})

test('tool github_project_item_status requires a current session', async (t) => {
  const app = writableApp(t)
  const tool = toolOf(app, ITEM_STATUS_TOOL)
  for (const exec of [undefined, {}, { agent: {} }, { agent: { session: {} } }]) {
    await assert.rejects(tool.execute({ itemId: ITEM_240_ID, status: 'TODO' }, exec), /no current session/u)
  }
})

test('tool github_project_item_status maps a missing content reference to item-not-found', async (t) => {
  const app = writableApp(t)
  await bindToolSession(app)
  const tool = toolOf(app, ITEM_STATUS_TOOL)
  await assert.rejects(tool.execute({ repo: 'acme/web', number: 999999, status: 'Done' }, TOOL_EXEC), (error) => {
    assert.equal(error.code, 'item-not-found')
    assert.match(error.message, /^item-not-found: /u)
    return true
  })
  assert.deepEqual(mutationCalls(app), [])
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
  expectErrorJson(await app.get('/issue?repo=acme/web&number=240'), 503, 'gh-missing')
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

/* ------------------------------------------------------------------ */
/* GET /branches (v1.2.0, contract §3.6)                               */
/* ------------------------------------------------------------------ */

/** Register the fake ctx services the branch index resolves lazily. */
function startAppWithWorkspaces(t, entries, options = {}) {
  const app = useApp(t, options)
  return app
}

test('/branches answers an empty map without a workspace registry', async (t) => {
  const app = useApp(t)
  const payload = expectJson(await app.get('/branches'))
  assert.deepEqual(payload.workspaces, {})
  assert.equal(payload.revision, 0)
  assert.equal(payload.git.available, null)
})

test('/branches answers one entry per registered workspace against real git', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ghp-branch-route-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'init', '-q', '-b', 'main', '.'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'checkout', '-q', '-b', 'feat/sidebar-branch'], { cwd: repo })

  const app = useApp(t, { registry: [{ id: 'wa', path: repo, sessionIds: [] }] })
  const payload = expectJson(await app.get('/branches'))
  assert.equal(payload.git.available, true)
  assert.equal(payload.workspaces.wa.branch, 'feat/sidebar-branch')
  assert.equal(payload.workspaces.wa.repo, true)
  assert.equal(payload.workspaces.wa.path, repo)
  assert.equal(payload.workspaces.wa.detached, false)
})

test('a user prompt refreshes only that workspace, and revises only on change', async (t) => {
  const app = useApp(t, {
    registry: [
      { id: 'wa', path: '/ws/a', sessionIds: ['s1'] },
      { id: 'wb', path: '/ws/b', sessionIds: ['s2'] },
    ],
    branches: { '/ws/a': 'main', '/ws/b': 'dev' },
  })

  const first = expectJson(await app.get('/branches'))
  assert.equal(first.workspaces.wa.branch, 'main')
  // Only the first read's own staleness pass has run so far.
  const readsAfterFirstPaint = app.branchReads.length

  // A synthetic injected message is not a human prompt: no refresh happens.
  app.emitSessionEvent({ id: 's1', header: { cwd: '/ws/a' } }, {
    type: 'user/message',
    data: { source: { kind: 'system-prompt' } },
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(app.branchReads.length, readsAfterFirstPaint)

  // A real prompt refreshes the workspace that session belongs to.
  app.setBranch('/ws/a', 'feat/next')
  app.emitSessionEvent({ id: 's1', header: { cwd: '/ws/a' } }, {
    type: 'user/message',
    data: { source: { kind: 'user' } },
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(app.branchReads.at(-1), ['/ws/a'])

  const second = expectJson(await app.get('/branches'))
  assert.equal(second.workspaces.wa.branch, 'feat/next')
  assert.equal(second.workspaces.wb.branch, 'dev')
  assert.equal(second.revision, first.revision + 1)
})
