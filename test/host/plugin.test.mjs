/**
 * End-to-end-ish tests of the host HTTP API (contract §3.1): a fake
 * `webServer` service captures the single prefix route, then every endpoint is
 * driven through the real handler with a fake `gh` runner and a temp state
 * file. Also covers request gating, caching/single-flight, error envelopes,
 * and the no-`gh` degradation path.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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

test('module declares the mandatory webServer inject so Cordis waits before apply', () => {
  // Activation ordering: `--patch`/bundle rows can run before the carrier exists.
  assert.deepEqual(inject, ['webServer'])
  assert.equal(pluginName, 'github-projects')
})

test('apply registers exactly one prefix route at /plugin/github-projects', (t) => {
  const app = useApp(t)
  assert.equal(app.routes.length, 1)
  assert.equal(app.routes[0].kind, 'prefix')
  assert.equal(app.routes[0].path, ROUTE_PATH)
  assert.equal(ROUTE_PATH, '/plugin/github-projects')
  assert.equal(typeof app.routes[0].handler, 'function')
})

test('apply is inert instead of throwing when the composition has no webServer', () => {
  const ctx = {
    get: () => undefined,
    effect: () => { throw new Error('must not register a route without webServer') },
  }
  assert.doesNotThrow(() => apply(ctx, { statePath: join(tmpdir(), 'ghp-inert-state.json') }))
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

test('GET /config reads bindings only, echoing unknown ids as null bindings', async (t) => {
  const app = useApp(t)
  const body = expectJson(await app.get('/config?sessionId=session-abc&workspaceId=ws-123'))
  assert.deepEqual(Object.keys(body).sort(), ['gh', 'session', 'workspace'])
  assert.deepEqual(body.workspace, { workspaceId: 'ws-123', project: null })
  assert.deepEqual(body.session, { sessionId: 'session-abc', issue: null, workspaceId: 'ws-123' })
  assert.equal(body.gh.available, true)

  const empty = expectJson(await app.get('/config'))
  assert.deepEqual(empty.workspace, { workspaceId: '', project: null })
  assert.deepEqual(empty.session, { sessionId: '', issue: null, workspaceId: null })

  // No GitHub read was attempted for bindings (only health probes).
  assert.deepEqual(app.commands().filter(command => command.startsWith('project')), [])
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
  const app = useApp(t, { runner })

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

test('GET /config answers a pending placeholder when the very first probe is slow', async (t) => {
  const runner = createRunner(async (args) => {
    if (args[0] === '--version' || (args[0] === 'api' && args[1] === 'user')) await sleep(250)
    return fixtureRun(args)
  })
  const app = useApp(t, { runner, config: { healthFirstReadTimeoutMs: 40 } })

  const started = Date.now()
  const body = expectJson(await app.get('/config?workspaceId=w'))
  const elapsed = Date.now() - started
  assert.deepEqual(body.gh, { available: false, version: null, account: null, error: 'pending' })
  assert.ok(elapsed < 200, `config blocked ${String(elapsed)}ms on the first slow probe`)

  // The probe keeps running in the background; the next read sees the real snapshot.
  await sleep(400)
  const later = expectJson(await app.get('/config?workspaceId=w'))
  assert.equal(later.gh.available, true)
  assert.equal(later.gh.account, 'ceasarXuu')
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

test('GET /projects returns owners, normalized Projects, fetchedAt, errors', async (t) => {
  const app = useApp(t)
  const body = expectJson(await app.get('/projects'))
  assert.deepEqual(Object.keys(body).sort(), ['errors', 'fetchedAt', 'owners', 'projects'])
  assert.deepEqual(body.owners, [
    { login: 'ceasarXuu', type: 'user' },
    { login: 'XuyuTech', type: 'organization' },
    { login: 'BeanDoor', type: 'organization' },
  ])
  assert.equal(body.projects.length, 4)
  assert.deepEqual(body.errors, [])
  assert.match(body.fetchedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  assert.deepEqual(Object.keys(body.projects[0]).sort(), [
    'closed', 'description', 'itemCount', 'number', 'owner', 'ownerType', 'title', 'url',
  ])
  assert.equal(body.projects[0].number, 9)
  assert.equal(body.projects[0].ownerType, 'user')
  assert.equal(body.projects[0].itemCount, 195)
})

test('GET /projects caches for cacheTtlMs and refresh=1 bypasses the cache', async (t) => {
  const app = useApp(t, { config: { cacheTtlMs: 60_000 } })
  const listCalls = () => app.commands().filter(command => command.startsWith('project list')).length

  expectJson(await app.get('/projects'))
  assert.equal(listCalls(), 3)
  const cached = expectJson(await app.get('/projects'))
  assert.equal(listCalls(), 3)
  assert.equal(cached.fetchedAt, expectJson(await app.get('/projects')).fetchedAt)

  expectJson(await app.get('/projects?refresh=1'))
  assert.equal(listCalls(), 6)
})

/* ------------------------------------------------------------------ */
/* GET /items                                                          */
/* ------------------------------------------------------------------ */

test('GET /items returns the Project summary plus normalized items', async (t) => {
  const app = useApp(t)
  const body = expectJson(await app.get('/items?owner=ceasarXuu&number=9'))
  assert.deepEqual(Object.keys(body).sort(), ['fetchedAt', 'items', 'project', 'truncated'])
  assert.equal(body.project.number, 9)
  assert.equal(body.project.title, 'Astropath-issues')
  assert.equal(body.project.itemCount, 195)
  assert.equal(body.items.length, 3)
  assert.equal(body.items[0].type, 'issue')
  assert.equal(body.items[0].number, 240)
  assert.equal(body.items[0].repo, 'ceasarXuu/Astropath')
  assert.equal(body.items[0].status, 'In Progress')
  assert.deepEqual(body.items[0].labels, ['enhancement', 'todo'])
  assert.equal(body.items[0].milestone, 'v1.2.0')
  assert.equal(body.items[0].state, null)
  assert.equal(body.truncated, true)
})

test('GET /items maps a missing Project to 404 and bad params to 400', async (t) => {
  const app = useApp(t)
  expectErrorJson(await app.get('/items?owner=ceasarXuu&number=99999'), 404, 'project-not-found')
  expectErrorJson(await app.get('/items?owner=bad/owner&number=9'), 400, 'bad-request')
  expectErrorJson(await app.get('/items?owner=ceasarXuu&number=abc'), 400, 'bad-request')
  expectErrorJson(await app.get('/items?owner=ceasarXuu'), 400, 'bad-request')
})

test('GET /items uses the configured maxProjectItems as the gh limit', async (t) => {
  const app = useApp(t, { config: { maxProjectItems: 50 } })
  expectJson(await app.get('/items?owner=ceasarXuu&number=9'))
  assert.ok(app.commands().includes('project item-list 9 --owner ceasarXuu --format json --limit 50'))
})

/* ------------------------------------------------------------------ */
/* GET /issue                                                          */
/* ------------------------------------------------------------------ */

test('GET /issue returns a contract IssueDetail with comments', async (t) => {
  const app = useApp(t)
  const body = expectJson(await app.get('/issue?repo=ceasarXuu/Astropath&number=240'))
  assert.deepEqual(Object.keys(body).sort(), ['fetchedAt', 'issue'])
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
