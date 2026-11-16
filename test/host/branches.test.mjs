/**
 * `branches.js` — the v1.2.0 git branch reader behind `GET /branches`.
 *
 * Two layers are covered independently:
 * - `readBranchState` against real throw-away repositories in a temp directory
 *   (git is what actually answers the question), and against directories that
 *   are not repositories, do not exist, or are detached/unborn;
 * - `createBranchReader`'s cache and single-flight, driven through the injected
 *   reader so no process is spawned for the cache assertions.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createBranchReader, createWorkspaceBranchIndex, readBranchState, DEFAULT_BRANCH_TTL_MS } from '../../branches.js'

/** Isolate one repo/directory fixture; every test owns and removes its root. */
function withTempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'ghp-branches-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

const GIT_IDENTITY = Object.freeze([
  '-c', 'user.email=t@example.com',
  '-c', 'user.name=Test',
  '-c', 'init.defaultBranch=main',
])

function git(cwd, args) {
  return execFileSync('git', [...GIT_IDENTITY, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' })
}

/** A repository with one commit on `main`. */
function makeRepo(root, name = 'repo') {
  const directory = join(root, name)
  mkdirSync(directory, { recursive: true })
  git(directory, ['init', '-q'])
  git(directory, ['commit', '-q', '--allow-empty', '-m', 'init'])
  return directory
}

test('readBranchState reports the current branch of a repository', async (t) => {
  const root = withTempRoot(t)
  const directory = makeRepo(root)
  git(directory, ['checkout', '-q', '-b', 'feat/left-sidebar-branch'])

  const state = await readBranchState(directory)
  assert.equal(state.path, directory)
  assert.equal(state.repo, true)
  assert.equal(state.branch, 'feat/left-sidebar-branch')
  assert.equal(state.detached, false)
  assert.equal(state.commit, null)
  assert.equal(typeof state.readAt, 'string')
  assert.ok(Number.isFinite(Date.parse(state.readAt)))
})

test('readBranchState answers an unborn branch that has no commit yet', async (t) => {
  const root = withTempRoot(t)
  const directory = join(root, 'empty')
  mkdirSync(directory, { recursive: true })
  git(directory, ['init', '-q', '-b', 'trunk'])

  const state = await readBranchState(directory)
  assert.equal(state.repo, true)
  assert.equal(state.branch, 'trunk')
  assert.equal(state.detached, false)
})

test('readBranchState reports a detached HEAD with its short sha', async (t) => {
  const root = withTempRoot(t)
  const directory = makeRepo(root)
  git(directory, ['checkout', '-q', '--detach'])

  const state = await readBranchState(directory)
  assert.equal(state.repo, true)
  assert.equal(state.branch, null)
  assert.equal(state.detached, true)
  assert.match(state.commit ?? '', /^[0-9a-f]{7,}$/u)
})

test('readBranchState treats "not a repository" as no repository, not a failure', async (t) => {
  const root = withTempRoot(t)
  const plain = join(root, 'plain')
  mkdirSync(plain, { recursive: true })

  const state = await readBranchState(plain)
  assert.deepEqual(state, {
    path: plain,
    repo: false,
    branch: null,
    detached: false,
    commit: null,
    readAt: null,
  })
})

test('readBranchState treats a missing directory as no repository', async (t) => {
  const root = withTempRoot(t)
  const gone = join(root, 'gone')
  const state = await readBranchState(gone)
  assert.equal(state.repo, false)
  assert.equal(state.branch, null)
})

test('readBranchState reads a repository nested inside the workspace directory', async (t) => {
  const root = withTempRoot(t)
  const outer = join(root, 'outer')
  mkdirSync(outer, { recursive: true })
  const repo = makeRepo(outer, 'inner')
  git(repo, ['checkout', '-q', '-b', 'nested'])

  // The workspace directory above the repository has no .git of its own.
  const state = await readBranchState(outer)
  assert.equal(state.repo, false)

  const nested = await readBranchState(repo)
  assert.equal(nested.branch, 'nested')
})

test('a missing git executable rejects so the caller can report it once', async (t) => {
  const root = withTempRoot(t)
  const directory = makeRepo(root)
  await assert.rejects(
    () => readBranchState(directory, { gitCommand: join(root, 'no-such-git') }),
    (error) => error?.code === 'ENOENT',
  )
})

test('createBranchReader caches one directory inside its fresh window', async () => {
  const calls = []
  const reader = createBranchReader({
    ttlMs: 60_000,
    read: async (directory) => {
      calls.push(directory)
      return { path: directory, repo: true, branch: 'cached', detached: false, commit: null, readAt: null }
    },
  })

  const first = await reader.read(['/tmp/a'])
  const second = await reader.read(['/tmp/a'])
  assert.equal(calls.length, 1)
  assert.equal(first['/tmp/a'].branch, 'cached')
  assert.deepEqual(second, first)
})

test('createBranchReader shares one in-flight read per directory', async () => {
  let calls = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const reader = createBranchReader({
    ttlMs: 60_000,
    read: async (directory) => {
      calls += 1
      await gate
      return { path: directory, repo: true, branch: 'gated', detached: false, commit: null, readAt: null }
    },
  })

  const pending = [reader.read(['/tmp/b']), reader.read(['/tmp/b']), reader.read(['/tmp/b'])]
  release()
  const answers = await Promise.all(pending)
  assert.equal(calls, 1)
  for (const answer of answers) assert.equal(answer['/tmp/b'].branch, 'gated')
})

test('createBranchReader refreshes after the TTL and on force', async () => {
  let calls = 0
  const reader = createBranchReader({
    ttlMs: 5,
    read: async (directory) => {
      calls += 1
      return { path: directory, repo: true, branch: `v${calls}`, detached: false, commit: null, readAt: null }
    },
  })

  assert.equal((await reader.read(['/tmp/c']))['/tmp/c'].branch, 'v1')
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal((await reader.read(['/tmp/c']))['/tmp/c'].branch, 'v2')
  assert.equal((await reader.read(['/tmp/c'], { force: true }))['/tmp/c'].branch, 'v3')
})

test('createBranchReader drops duplicates and unusable paths', async () => {
  const asked = []
  const reader = createBranchReader({
    ttlMs: 60_000,
    read: async (directory) => {
      asked.push(directory)
      return { path: directory, repo: false, branch: null, detached: false, commit: null, readAt: null }
    },
  })

  const answer = await reader.read(['/tmp/d', '/tmp/d', 'relative/path', '', null, 42])
  assert.deepEqual(asked, ['/tmp/d'])
  assert.deepEqual(Object.keys(answer), ['/tmp/d'])
})

test('createBranchReader answers a failed read as "no repository" instead of rejecting', async () => {
  const reader = createBranchReader({
    ttlMs: 60_000,
    read: async () => { throw new Error('boom') },
  })
  const answer = await reader.read(['/tmp/e'])
  assert.equal(answer['/tmp/e'].repo, false)
  assert.equal(answer['/tmp/e'].branch, null)
})

test('createBranchReader bounds its tracked directories', async () => {
  const reader = createBranchReader({
    ttlMs: DEFAULT_BRANCH_TTL_MS,
    read: async (directory) => ({ path: directory, repo: false, branch: null, detached: false, commit: null, readAt: null }),
  })
  const many = Array.from({ length: 900 }, (_, index) => `/tmp/ws-${String(index)}`)
  const answer = await reader.read(many)
  // Every asked path is answered, even when the cache had to drop older ones.
  assert.equal(Object.keys(answer).length, 900)
})

test('createBranchReader accepts a Windows drive path and a UNC path', async () => {
  const asked = []
  const reader = createBranchReader({
    ttlMs: 60_000,
    read: async (directory) => {
      asked.push(directory)
      return { path: directory, repo: false, branch: null, detached: false, commit: null, readAt: null }
    },
  })
  await reader.read(['C:\\projects\\app', '\\\\server\\share\\repo'])
  assert.deepEqual(asked, ['C:\\projects\\app', '\\\\server\\share\\repo'])
})

/* ------------------------------------------------------------------ */
/* createWorkspaceBranchIndex — the wire shape behind GET /branches.    */
/* ------------------------------------------------------------------ */

/** Fake `ctx.workspaceRegistry`: ordered entities with session accounts. */
function fakeRegistry(entries) {
  return { list: () => entries }
}

function fakeReader(byPath) {
  const calls = []
  return {
    calls,
    async read(directories) {
      calls.push([...directories])
      const answer = {}
      for (const directory of directories) {
        answer[directory] = byPath[directory] ?? {
          path: directory, repo: false, branch: null, detached: false, commit: null, readAt: null,
        }
      }
      return answer
    },
  }
}

function repoState(path, branch) {
  return { path, repo: true, branch, detached: false, commit: null, readAt: new Date().toISOString() }
}

test('the index answers every registered workspace after a startup pass', async () => {
  const reader = fakeReader({ '/ws/a': repoState('/ws/a', 'main'), '/ws/b': repoState('/ws/b', 'feat/x') })
  const index = createWorkspaceBranchIndex({
    getRegistry: () => fakeRegistry([
      { id: 'wa', path: '/ws/a', sessionIds: ['s1'] },
      { id: 'wb', path: '/ws/b', sessionIds: [] },
    ]),
    reader,
    ttlMs: 0,
  })

  await index.refreshAll()
  const payload = await index.read()
  assert.equal(payload.git.available, true)
  assert.equal(payload.workspaces.wa.branch, 'main')
  assert.equal(payload.workspaces.wb.branch, 'feat/x')
  assert.deepEqual(Object.keys(payload.workspaces).sort(), ['wa', 'wb'])
  assert.equal(reader.calls[0].length, 2)
})

test('the index refreshes exactly the workspace a prompt came from', async () => {
  const reader = fakeReader({ '/ws/a': repoState('/ws/a', 'main'), '/ws/b': repoState('/ws/b', 'dev') })
  const index = createWorkspaceBranchIndex({
    getRegistry: () => fakeRegistry([
      { id: 'wa', path: '/ws/a', sessionIds: ['s1'] },
      { id: 'wb', path: '/ws/b', sessionIds: ['s2'] },
    ]),
    reader,
    ttlMs: 0,
  })

  await index.refreshAll()
  reader.calls.length = 0
  // A prompt in session s2 refreshes only workspace wb.
  assert.equal(await index.refreshForSession({ id: 's2', header: { cwd: '/ws/b' } }), true)
  assert.deepEqual(reader.calls, [['/ws/b']])
})

test('the index falls back to the session cwd when the registry has no account', async () => {
  const reader = fakeReader({ '/ws/a': repoState('/ws/a', 'main') })
  const index = createWorkspaceBranchIndex({
    getRegistry: () => fakeRegistry([{ id: 'wa', path: '/ws/a', sessionIds: [] }]),
    reader,
    ttlMs: 0,
  })
  await index.refreshAll()
  reader.calls.length = 0
  assert.equal(await index.refreshForSession({ id: 'unknown-session', header: { cwd: '/ws/a' } }), true)
  assert.deepEqual(reader.calls, [['/ws/a']])
})

test('the index ignores a session outside every workspace', async () => {
  const reader = fakeReader({})
  const index = createWorkspaceBranchIndex({
    getRegistry: () => fakeRegistry([{ id: 'wa', path: '/ws/a', sessionIds: [] }]),
    reader,
    ttlMs: 0,
  })
  assert.equal(await index.refreshForSession({ id: 's9', header: { cwd: '/elsewhere' } }), false)
  assert.deepEqual(reader.calls, [])
})

test('the index stays inert and answerable without a workspace registry', async () => {
  const reader = fakeReader({})
  const index = createWorkspaceBranchIndex({ getRegistry: () => undefined, reader, ttlMs: 0 })
  assert.equal(await index.refreshAll(), false)
  const payload = await index.read()
  assert.deepEqual(payload.workspaces, {})
  assert.equal(payload.git.available, null)
})

test('the revision only advances when a branch actually changed', async () => {
  const byPath = { '/ws/a': repoState('/ws/a', 'main') }
  const reader = fakeReader(byPath)
  const index = createWorkspaceBranchIndex({
    getRegistry: () => fakeRegistry([{ id: 'wa', path: '/ws/a', sessionIds: [] }]),
    reader,
    ttlMs: 0,
  })

  await index.refreshAll()
  const first = await index.read()
  await index.refreshForSession({ id: 's', header: { cwd: '/ws/a' } })
  const unchanged = await index.read()
  assert.equal(unchanged.revision, first.revision)

  byPath['/ws/a'] = repoState('/ws/a', 'feat/new')
  await index.refreshForSession({ id: 's', header: { cwd: '/ws/a' } })
  const changed = await index.read()
  assert.equal(changed.revision, first.revision + 1)
  assert.equal(changed.workspaces.wa.branch, 'feat/new')
})

test('the index reports a missing git executable once and keeps answering', async () => {
  const reader = {
    async read() {
      throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })
    },
  }
  const index = createWorkspaceBranchIndex({
    getRegistry: () => fakeRegistry([{ id: 'wa', path: '/ws/a', sessionIds: [] }]),
    reader,
    ttlMs: 0,
  })
  await index.refreshAll()
  const payload = await index.read()
  assert.equal(payload.git.available, false)
  assert.match(payload.git.error ?? '', /ENOENT/u)
  assert.deepEqual(payload.workspaces, {})
})

test('the index forgets a removed workspace', async () => {
  const entries = [{ id: 'wa', path: '/ws/a', sessionIds: [] }, { id: 'wb', path: '/ws/b', sessionIds: [] }]
  const reader = fakeReader({ '/ws/a': repoState('/ws/a', 'main'), '/ws/b': repoState('/ws/b', 'dev') })
  const index = createWorkspaceBranchIndex({ getRegistry: () => fakeRegistry(entries), reader, ttlMs: 0 })

  await index.refreshAll()
  assert.deepEqual(Object.keys((await index.read()).workspaces).sort(), ['wa', 'wb'])
  entries.splice(1, 1)
  await index.refreshAll()
  assert.deepEqual(Object.keys((await index.read()).workspaces), ['wa'])
})

test('a stale read refreshes before answering', async () => {
  const reader = fakeReader({ '/ws/a': repoState('/ws/a', 'main') })
  const index = createWorkspaceBranchIndex({
    getRegistry: () => fakeRegistry([{ id: 'wa', path: '/ws/a', sessionIds: [] }]),
    reader,
    ttlMs: 0,
  })
  // No explicit startup pass: the first /branches read must still carry data.
  const payload = await index.read()
  assert.equal(payload.workspaces.wa.branch, 'main')
  assert.equal(reader.calls.length, 1)
})
