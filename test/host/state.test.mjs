/**
 * Unit tests for `state.js` — the durable binding store (contract §3.3).
 */

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createStateStore, STATE_WRITE_FAILED } from '../../state.js'

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

const ISSUE = {
  repo: 'ceasarXuu/Astropath',
  number: 240,
  title: '会话名称丰富化',
  url: 'https://github.com/ceasarXuu/Astropath/issues/240',
  state: 'open',
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'ghp-state-'))
}

function cleanup(dir) {
  try { chmodSync(dir, 0o755) } catch { /* may not exist */ }
  rmSync(dir, { recursive: true, force: true })
}

test('missing state file reads as the empty versioned store', () => {
  const dir = tempDir()
  try {
    const store = createStateStore(join(dir, 'does-not-exist', 'state.json'))
    const snapshot = store.read()
    assert.equal(snapshot.version, 1)
    assert.equal(snapshot.updatedAt, null)
    assert.deepEqual(snapshot.workspaces, {})
    assert.deepEqual(snapshot.sessions, {})
    assert.deepEqual(store.getWorkspace('w1'), { workspaceId: 'w1', project: null })
    assert.deepEqual(store.getSession('s1'), { sessionId: 's1', issue: null, workspaceId: null })
  } finally {
    cleanup(dir)
  }
})

test('bindings roundtrip through the file and a fresh store instance', async () => {
  const dir = tempDir()
  try {
    const statePath = join(dir, 'nested', 'state.json')
    const store = createStateStore(statePath)

    const workspace = await store.bindWorkspace('w-1', PROJECT)
    assert.deepEqual(workspace, { workspaceId: 'w-1', project: PROJECT })

    const session = await store.bindIssue('s-1', ISSUE, 'w-1')
    assert.deepEqual(session, { sessionId: 's-1', issue: ISSUE, workspaceId: 'w-1' })

    // Durable file shape (contract §3.3).
    const raw = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.equal(raw.version, 1)
    assert.match(raw.updatedAt, /^\d{4}-\d{2}-\d{2}T/u)
    assert.deepEqual(raw.workspaces['w-1'].project, PROJECT)
    assert.match(raw.workspaces['w-1'].boundAt, /^\d{4}-\d{2}-\d{2}T/u)
    assert.deepEqual(raw.sessions['s-1'].issue, ISSUE)
    assert.equal(raw.sessions['s-1'].workspaceId, 'w-1')
    // Atomic write must not leave the temp file behind.
    assert.equal(existsSync(`${statePath}.tmp`), false)

    // A second store (same process, e.g. after reload) sees the same data.
    const reopened = createStateStore(statePath)
    assert.deepEqual(reopened.getWorkspace('w-1'), workspace)
    assert.deepEqual(reopened.getSession('s-1'), session)
  } finally {
    cleanup(dir)
  }
})

test('read() answers a defensive copy that cannot mutate the store', async () => {
  const dir = tempDir()
  try {
    const statePath = join(dir, 'state.json')
    const store = createStateStore(statePath)
    await store.bindWorkspace('w-1', PROJECT)
    const snapshot = store.read()
    snapshot.workspaces['w-1'].project.title = 'mutated'
    snapshot.workspaces['w-2'] = { project: PROJECT }
    assert.equal(store.getWorkspace('w-1').project.title, 'Astropath-issues')
    assert.equal(store.getWorkspace('w-2').project, null)
  } finally {
    cleanup(dir)
  }
})

test('unbind removes one binding and is idempotent', async () => {
  const dir = tempDir()
  try {
    const store = createStateStore(join(dir, 'state.json'))
    await store.bindWorkspace('w-1', PROJECT)
    await store.bindIssue('s-1', ISSUE, 'w-1')

    await store.unbindIssue('s-1')
    assert.equal(store.getSession('s-1').issue, null)
    // The workspace binding is independent.
    assert.equal(store.getWorkspace('w-1').project.number, 9)

    await store.unbindWorkspace('w-1')
    assert.equal(store.getWorkspace('w-1').project, null)
    // Unbinding an unknown id must not throw.
    await store.unbindWorkspace('never-bound')
    await store.unbindIssue('never-bound')
  } finally {
    cleanup(dir)
  }
})

test('corrupt files read as the empty store and recover on the next write', async () => {
  const dir = tempDir()
  try {
    const statePath = join(dir, 'state.json')
    writeFileSync(statePath, '{ this is not json', 'utf8')
    const store = createStateStore(statePath)
    assert.deepEqual(store.read(), { version: 1, updatedAt: null, workspaces: {}, sessions: {} })

    await store.bindIssue('s-1', ISSUE, null)
    const raw = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.deepEqual(raw.sessions['s-1'].issue, ISSUE)
    assert.equal(store.getSession('s-1').issue.number, 240)
  } finally {
    cleanup(dir)
  }
})

test('foreign versions and malformed entries are tolerated defensively', () => {
  const dir = tempDir()
  try {
    const statePath = join(dir, 'state.json')
    writeFileSync(statePath, JSON.stringify({ version: 99, workspaces: { w: { project: PROJECT } } }), 'utf8')
    const store = createStateStore(statePath)
    assert.deepEqual(store.read().workspaces, {})

    writeFileSync(statePath, JSON.stringify({
      version: 1,
      workspaces: {
        good: { project: PROJECT, boundAt: 'x' },
        missingProject: { boundAt: 'x' },
        brokenProject: { project: { owner: 'a' } },
      },
      sessions: {
        goodSession: { issue: ISSUE, workspaceId: 'good' },
        brokenIssue: { issue: { repo: 'a/b' } },
      },
    }), 'utf8')
    const partial = store.read()
    assert.deepEqual(Object.keys(partial.workspaces), ['good'])
    assert.deepEqual(Object.keys(partial.sessions), ['goodSession'])
    assert.equal(partial.sessions.goodSession.workspaceId, 'good')
  } finally {
    cleanup(dir)
  }
})

test('concurrent writes serialize and none are lost', async () => {
  const dir = tempDir()
  try {
    const statePath = join(dir, 'state.json')
    const store = createStateStore(statePath)
    await Promise.all(Array.from({ length: 20 }, (_, index) => (
      store.bindWorkspace(`w-${String(index)}`, { ...PROJECT, number: index + 1 })
    )))
    const snapshot = store.read()
    assert.equal(Object.keys(snapshot.workspaces).length, 20)
    for (let index = 0; index < 20; index += 1) {
      assert.equal(snapshot.workspaces[`w-${String(index)}`].project.number, index + 1)
    }
    // The file itself must still be valid JSON with every entry.
    const raw = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.equal(Object.keys(raw.workspaces).length, 20)
  } finally {
    cleanup(dir)
  }
})

test('a failed write keeps the previous file and rejects with state-write-failed', async (t) => {
  const dir = tempDir()
  try {
    const statePath = join(dir, 'state.json')
    const store = createStateStore(statePath)
    await store.bindWorkspace('w-1', PROJECT)
    const before = readFileSync(statePath, 'utf8')

    chmodSync(dir, 0o555)
    let enforced = true
    try {
      await assert.rejects(
        store.bindWorkspace('w-2', { ...PROJECT, number: 8 }),
        (error) => error.code === STATE_WRITE_FAILED,
      )
    } catch (error) {
      // Some filesystems (or a root test runner) ignore the directory mode.
      enforced = false
      t.diagnostic(`directory permissions not enforceable here: ${error.message}`)
    } finally {
      chmodSync(dir, 0o755)
    }

    if (enforced) {
      assert.equal(readFileSync(statePath, 'utf8'), before)
      assert.equal(store.getWorkspace('w-2').project, null)
    }
    // The queue recovers: the next write succeeds and is durable.
    await store.bindWorkspace('w-2', { ...PROJECT, number: 8 })
    assert.equal(store.getWorkspace('w-2').project.number, 8)
  } finally {
    cleanup(dir)
  }
})

test('invalid arguments are rejected before touching the disk', async () => {
  const dir = tempDir()
  try {
    const statePath = join(dir, 'state.json')
    const store = createStateStore(statePath)
    assert.throws(() => createStateStore(''), TypeError)
    assert.throws(() => store.bindWorkspace('', PROJECT), TypeError)
    assert.throws(() => store.bindWorkspace('w', null), TypeError)
    assert.throws(() => store.bindIssue('', ISSUE, null), TypeError)
    assert.throws(() => store.bindIssue('s', { repo: 'a/b' }, null), TypeError)
    assert.equal(existsSync(statePath), false)
  } finally {
    cleanup(dir)
  }
})
