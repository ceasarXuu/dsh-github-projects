/**
 * Tests for `dev/mock-host.js` (the fixture-mode host the e2e harness mounts).
 *
 * v1.1.0 adds the write surface the e2e write/read-only stages depend on:
 * `/config.writes`, `GET /project-meta`, `POST /item-status` (gated by
 * `allowWrites`, in-memory status updates), the deterministic failure item and
 * the mock-only `/mock-state` assertion aid. These tests pin that mock contract
 * so the client/e2e halves cannot silently drift from the fixtures.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { apply, __resetMockState } from '../../dev/mock-host.js'

const PREFIX = '/plugin/github-projects'
const TODO_ID = '8fc1d6c9'
const IN_PROGRESS_ID = '47fc9ee4'
const IN_REVIEW_ID = 'edd18149'

/** Mount the mock host on a real loopback HTTP server. */
async function startMock(t, config = {}) {
  // The mock keeps its bindings at module scope; each case starts empty.
  __resetMockState()
  const routes = []
  const ctx = {
    get(name) {
      if (name !== 'webServer') return undefined
      return {
        register(route) {
          routes.push(route)
          return () => {
            const index = routes.indexOf(route)
            if (index !== -1) routes.splice(index, 1)
          }
        },
      }
    },
    effect(callback) {
      const dispose = callback()
      return () => { if (typeof dispose === 'function') dispose() }
    },
  }
  apply(ctx, config)
  assert.equal(routes.length, 1, 'mock host must register exactly one prefix route')
  const server = createServer((req, res) => routes[0].handler(req, res))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => { server.close() })
  const base = `http://127.0.0.1:${String(server.address().port)}${PREFIX}`
  const request = async (path, options = {}) => {
    const response = await fetch(`${base}${path}`, options)
    return { status: response.status, body: await response.json() }
  }
  const postJson = (path, payload) => request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { request, postJson }
}

test('mock /config mirrors writes.allowed from the overlay allowWrites flag', async (t) => {
  const readOnly = await startMock(t)
  assert.deepEqual((await readOnly.request('/config')).body.writes, { allowed: false })

  const writable = await startMock(t, { allowWrites: true })
  assert.deepEqual((await writable.request('/config')).body.writes, { allowed: true })
})

test('mock /project-meta serves the captured Project node/Status field ids', async (t) => {
  const mock = await startMock(t)
  const body = (await mock.request('/project-meta?owner=acme&number=9')).body
  assert.deepEqual(body.project, {
    id: 'PVT_kwHOAwDbXM4Bocj3',
    owner: 'acme',
    number: 9,
    title: 'web-issues',
  })
  assert.equal(body.statusField.id, 'PVTSSF_lAHOAwDbXM4Bocj3zhm8pxg')
  assert.equal(body.statusField.name, 'Status')
  assert.deepEqual(body.statusField.options, [
    { id: TODO_ID, name: 'TODO' },
    { id: IN_PROGRESS_ID, name: 'In Progress' },
    { id: IN_REVIEW_ID, name: 'In Review' },
    { id: '98236657', name: 'Done' },
  ])
  assert.equal(body.stale, false)
  assert.equal((await mock.request('/project-meta?owner=acme&number=99999')).status, 404)
})

test('mock POST /item-status is 403 writes-disabled unless allowWrites is true', async (t) => {
  const mock = await startMock(t)
  const response = await mock.postJson('/item-status', {
    owner: 'acme',
    number: 9,
    itemId: 'PVTI_lAHOAwDbXM4Bocj3zhDFfBs',
    optionId: null,
  })
  assert.equal(response.status, 403)
  assert.equal(response.body.error.code, 'writes-disabled')
})

test('mock POST /item-status updates the in-memory status and logs the write', async (t) => {
  const mock = await startMock(t, { allowWrites: true })
  const itemId = 'PVTI_lAHOAwDbXM4Bocj3zhDFfBs' // fixture item #240, In Progress

  const moved = await mock.postJson('/item-status', {
    owner: 'acme',
    number: 9,
    itemId,
    optionId: IN_REVIEW_ID,
  })
  assert.equal(moved.status, 200)
  assert.deepEqual(moved.body.item, { id: itemId })
  assert.deepEqual(moved.body.status, { optionId: IN_REVIEW_ID, name: 'In Review' })

  // GET /items reflects the in-memory move (the e2e reload assertion).
  const items = (await mock.request('/items?owner=acme&number=9')).body.items
  assert.equal(items.find(item => item.id === itemId).status, 'In Review')

  const cleared = await mock.postJson('/item-status', {
    owner: 'acme',
    number: 9,
    itemId,
    optionId: null,
  })
  assert.deepEqual(cleared.body.status, { optionId: null, name: null })
  assert.equal((await mock.request('/items?owner=acme&number=9')).body.items.find(item => item.id === itemId).status, null)

  const state = (await mock.request('/mock-state')).body
  assert.equal(state.allowWrites, true)
  assert.equal(state.writes.length, 2)
  assert.deepEqual(state.writes[0], {
    at: state.writes[0].at,
    owner: 'acme',
    number: 9,
    itemId,
    optionId: IN_REVIEW_ID,
    name: 'In Review',
    ok: true,
  })
  assert.equal(state.writes[1].optionId, null)
})

test('mock POST /item-status validates option/item/project ids', async (t) => {
  const mock = await startMock(t, { allowWrites: true })
  const valid = { owner: 'acme', number: 9, itemId: 'PVTI_lAHOAwDbXM4Bocj3zhDFfBs', optionId: null }
  assert.equal((await mock.postJson('/item-status', { ...valid, optionId: 'f0000000' })).status, 400)
  assert.equal((await mock.postJson('/item-status', { ...valid, itemId: 'PVTI_missing' })).status, 404)
  assert.equal((await mock.postJson('/item-status', { ...valid, number: 99999 })).status, 404)
  assert.equal((await mock.postJson('/item-status', { ...valid, itemId: '' })).status, 400)
  const missingOption = await mock.postJson('/item-status', { owner: 'acme', number: 9, itemId: valid.itemId })
  assert.equal(missingOption.status, 400)
})

test('mock failure item always answers 502 and is visible to the e2e harness', async (t) => {
  const mock = await startMock(t, { allowWrites: true })
  const state = (await mock.request('/mock-state')).body
  assert.deepEqual(state.failureItem, {
    id: 'PVTI_mock_write_failure',
    title: '[mock] 写入失败条目（e2e 回滚验证）',
    number: 9005,
  })

  const items = (await mock.request('/items?owner=acme&number=9')).body.items
  const failureItem = items.find(item => item.id === 'PVTI_mock_write_failure')
  assert.ok(failureItem, 'the failure item must be on the board')
  assert.equal(failureItem.title, state.failureItem.title)
  assert.equal(failureItem.status, 'TODO')

  const response = await mock.postJson('/item-status', {
    owner: 'acme',
    number: 9,
    itemId: 'PVTI_mock_write_failure',
    optionId: IN_PROGRESS_ID,
  })
  assert.equal(response.status, 502)
  assert.equal(response.body.error.code, 'gh-failed')

  const after = (await mock.request('/mock-state')).body
  assert.equal(after.writes.at(-1).ok, false)
  assert.equal(after.writes.at(-1).code, 'gh-failed')
  // The failed write must not change the item's status.
  assert.equal((await mock.request('/items?owner=acme&number=9')).body.items.find(item => item.id === 'PVTI_mock_write_failure').status, 'TODO')
})

/* ------------------------------------------------------------------ */
/* v1.2.0: GET /branches                                               */
/* ------------------------------------------------------------------ */

test('mock /branches answers one entry per bound workspace, cycling presentations', async (t) => {
  const mock = await startMock(t)
  // The mock has no workspace registry: entries follow the workspace bindings.
  const project = { owner: 'acme', ownerType: 'user', number: 9, title: 'web-issues', url: null, itemCount: 195, closed: false, description: null }
  for (const workspaceId of ['ws-alpha', 'ws-beta', 'ws-gamma']) {
    const response = await mock.postJson('/bind-workspace', { workspaceId, project })
    assert.equal(response.status, 200)
  }

  const body = (await mock.request('/branches')).body
  assert.equal(body.git.available, true)
  assert.deepEqual(Object.keys(body.workspaces).sort(), ['ws-alpha', 'ws-beta', 'ws-gamma'])
  const entries = Object.values(body.workspaces)
  assert.equal(entries[0].branch, 'main')
  assert.equal(entries[0].detached, false)
  assert.equal(entries[1].branch, 'feat/left-sidebar-branch')
  assert.equal(entries[2].detached, true)
  assert.equal(entries[2].branch, null)
  assert.match(entries[2].commit ?? '', /^[0-9a-f]+$/u)
  for (const entry of entries) {
    assert.equal(entry.repo, true)
    assert.equal(entry.workspaceId, entry.workspaceId)
    assert.equal(typeof entry.path, 'string')
  }
})

test('mock /branches is empty before any workspace is bound', async (t) => {
  const mock = await startMock(t)
  const body = (await mock.request('/branches')).body
  assert.deepEqual(body.workspaces, {})
  assert.equal(body.revision, 1)
})

test('mock /branches honors MOCK_BRANCHES overrides, including a non-repository', async (t) => {
  process.env.MOCK_BRANCHES = 'ws-alpha=release/2.0,ws-beta=!not-a-repo,ws-gamma=detached'
  try {
    // The override table is read at module load; re-import to apply it.
    const moduleUrl = new URL('../../dev/mock-host.js', import.meta.url)
    const fresh = await import(`${moduleUrl.href}?override=1`)
    const routes = []
    fresh.apply({
      get: name => name === 'webServer'
        ? { register: route => { routes.push(route); return () => {} } }
        : undefined,
      effect: callback => { callback(); return () => {} },
    })
    const server = createServer((req, res) => routes[0].handler(req, res))
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    t.after(() => { server.close() })
    const base = `http://127.0.0.1:${String(server.address().port)}${PREFIX}`
    const request = async (path, options = {}) => {
      const response = await fetch(`${base}${path}`, options)
      return { status: response.status, body: await response.json() }
    }
    for (const workspaceId of ['ws-alpha', 'ws-beta', 'ws-gamma']) {
      await request('/bind-workspace', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, project: { owner: 'acme', number: 9, title: 'web-issues' } }),
      })
    }
    const body = (await request('/branches')).body
    assert.equal(body.workspaces['ws-alpha'].branch, 'release/2.0')
    // A non-repository workspace answers no entry at all.
    assert.equal(Object.hasOwn(body.workspaces, 'ws-beta'), false)
    assert.equal(body.workspaces['ws-gamma'].detached, true)
  } finally {
    delete process.env.MOCK_BRANCHES
  }
})

/* ------------------------------------------------------------------ */
/* v1.3.0: GET /auto-bind                                              */
/* ------------------------------------------------------------------ */

test('mock /auto-bind binds the fixture Project and reports its provenance', async (t) => {
  const mock = await startMock(t)
  const body = (await mock.request('/auto-bind?workspaceId=ws-auto')).body
  assert.equal(body.enabled, true)
  assert.equal(body.applied, true)
  assert.equal(body.reason, 'bound')
  assert.equal(body.repository, 'acme/web')
  assert.equal(body.project.number, 9)
  assert.equal(body.ambiguous, false)

  // The binding is visible in /bindings with the provenance beside it.
  const bindings = (await mock.request('/bindings')).body
  assert.equal(bindings.workspaces['ws-auto'].number, 9)
  assert.equal(bindings.workspaces['ws-auto'].autoBind.repository, 'acme/web')
  assert.equal(bindings.workspaces['ws-auto'].autoBind.ambiguous, false)
})

test('mock /auto-bind reaches every reason through MOCK_AUTOBIND', async (t) => {
  const previous = process.env.MOCK_AUTOBIND
  t.after(() => {
    if (previous === undefined) delete process.env.MOCK_AUTOBIND
    else process.env.MOCK_AUTOBIND = previous
  })
  const mock = await startMock(t)

  process.env.MOCK_AUTOBIND = 'disabled'
  assert.deepEqual((await mock.request('/auto-bind?workspaceId=w')).body, { enabled: false, applied: false, reason: 'disabled' })

  process.env.MOCK_AUTOBIND = 'already-bound'
  assert.equal((await mock.request('/auto-bind?workspaceId=w')).body.reason, 'already-bound')

  process.env.MOCK_AUTOBIND = 'no-project'
  assert.equal((await mock.request('/auto-bind?workspaceId=w')).body.reason, 'no-project')

  process.env.MOCK_AUTOBIND = 'ambiguous'
  const ambiguous = (await mock.request('/auto-bind?workspaceId=w2')).body
  assert.equal(ambiguous.reason, 'bound-ambiguous')
  assert.equal(ambiguous.ambiguous, true)
  assert.equal(ambiguous.considered, 2)
  const bindings = (await mock.request('/bindings')).body
  assert.equal(bindings.workspaces.w2.autoBind.ambiguous, true)
  assert.equal(bindings.workspaces.w2.autoBind.considered, 2)
})

test('mock /auto-bind rejects a missing workspace id', async (t) => {
  const mock = await startMock(t)
  assert.equal((await mock.request('/auto-bind')).body.reason, 'no-workspace')
})
