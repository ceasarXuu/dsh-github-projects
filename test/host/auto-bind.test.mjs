/**
 * v1.3.0 workspace auto-bind (contract §3.7).
 *
 * Three layers, tested where each is most decisive:
 * - `parseGitHubRemote` / `readRemoteState`: every remote URL shape git accepts,
 *   plus directories that are not repositories (real throw-away repos);
 * - `normalizeRepoProject` / `selectRepoProject`: the ranking rule, driven by
 *   payloads shaped like the real GraphQL answer (fixtures);
 * - `createWorkspaceAutoBinder`: the orchestration — never overwrite a user's
 *   binding, remember answers, never remember a `gh` failure.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createWorkspaceAutoBinder } from '../../auto-bind.js'
import { parseGitHubRemote, readRemoteState } from '../../git-remote.js'
import { normalizeRepoProject, selectRepoProject } from '../../github.js'

/* ------------------------------------------------------------------ */
/* Remote URL parsing                                                  */
/* ------------------------------------------------------------------ */

test('parseGitHubRemote accepts every shape git config can return', () => {
  const cases = [
    ['git@github.com:acme/web.git', 'acme/web'],
    ['git@github.com:acme/web', 'acme/web'],
    ['https://github.com/acme/web.git', 'acme/web'],
    ['https://github.com/acme/web', 'acme/web'],
    ['https://github.com/acme/web/', 'acme/web'],
    ['ssh://git@github.com/acme/web.git', 'acme/web'],
    ['ssh://git@github.com:22/acme/web.git', 'acme/web'],
    ['git://github.com/acme/web', 'acme/web'],
    ['https://user:token@github.com/acme/web.git', 'acme/web'],
    ['https://GitHub.com/CeasarXuu/web.git', 'CeasarXuu/web'],
    ['  git@github.com:owner/repo.git  ', 'owner/repo'],
  ]
  for (const [input, expected] of cases) {
    assert.equal(parseGitHubRemote(input), expected, `failed for ${JSON.stringify(input)}`)
  }
})

test('parseGitHubRemote rejects everything that is not a GitHub repository', () => {
  const rejected = [
    '',
    '   ',
    '/Users/x/mirror.git',
    '../sibling/repo',
    'github.com/owner/repo',
    'git@gitlab.com:owner/repo.git',
    'https://bitbucket.org/owner/repo.git',
    'https://github.com/owner',                    // no repository segment
    'https://github.com/owner/repo/tree/main',     // a path inside a repository
    'git@github.com:owner/repo.git/sub',
    'https://github.com//repo',
    null,
    42,
  ]
  for (const input of rejected) {
    assert.equal(parseGitHubRemote(input), null, `expected null for ${JSON.stringify(input)}`)
  }
})

/* ------------------------------------------------------------------ */
/* readRemoteState against real repositories                           */
/* ------------------------------------------------------------------ */

function withTempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'ghp-autobind-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

const GIT_IDENTITY = ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', '-c', 'init.defaultBranch=main']

function git(cwd, args) {
  return execFileSync('git', [...GIT_IDENTITY, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' })
}

test('readRemoteState reads and normalizes a real origin remote', async (t) => {
  const root = withTempRoot(t)
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-q'])
  git(repo, ['remote', 'add', 'origin', 'git@github.com:acme/web.git'])

  const state = await readRemoteState(repo)
  assert.equal(state.github, true)
  assert.equal(state.repository, 'acme/web')
  assert.equal(state.remoteUrl, 'git@github.com:acme/web.git')
  assert.equal(typeof state.readAt, 'string')
})

test('readRemoteState reads the remote from a subdirectory of a checkout', async (t) => {
  const root = withTempRoot(t)
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-q'])
  git(repo, ['remote', 'add', 'origin', 'https://github.com/acme/web.git'])
  const nested = join(repo, 'packages', 'app')
  mkdirSync(nested, { recursive: true })

  // `git config` walks up to the enclosing repository: a workspace pointing at
  // a subdirectory must still report the checkout's repository.
  const state = await readRemoteState(nested)
  assert.equal(state.repository, 'acme/web')
})

test('readRemoteState answers non-GitHub and non-repository directories plainly', async (t) => {
  const root = withTempRoot(t)

  const plain = join(root, 'plain')
  mkdirSync(plain, { recursive: true })
  const noRepo = await readRemoteState(plain)
  assert.equal(noRepo.github, false)
  assert.equal(noRepo.repository, null)
  assert.equal(noRepo.remoteUrl, null)

  const local = join(root, 'local')
  mkdirSync(local, { recursive: true })
  git(local, ['init', '-q'])
  git(local, ['remote', 'add', 'origin', '/srv/mirrors/repo.git'])
  const notGithub = await readRemoteState(local)
  assert.equal(notGithub.github, false)
  assert.equal(notGithub.repository, null)
  assert.equal(notGithub.remoteUrl, '/srv/mirrors/repo.git')

  const missing = await readRemoteState(join(root, 'gone'))
  assert.equal(missing.github, false)
})

/* ------------------------------------------------------------------ */
/* Ranking rule                                                        */
/* ------------------------------------------------------------------ */

/** Shaped like `Repository.projectsV2.nodes[]` in the real GraphQL answer. */
function node({ number, title, login = 'ceasarXuu', type = 'User', closed = false, autoAdd = false, updatedAt }) {
  return {
    number,
    title,
    url: `https://github.com/users/${login}/projects/${String(number)}`,
    closed,
    shortDescription: `${title} board`,
    updatedAt,
    createdAt: '2026-10-01T00:00:00Z',
    items: { totalCount: 12 },
    owner: { __typename: type, login },
    workflows: {
      nodes: [
        { name: 'Item added to project', enabled: true },
        { name: 'Auto-add to project', enabled: autoAdd },
      ],
    },
  }
}

test('normalizeRepoProject maps one linked Project', () => {
  const candidate = normalizeRepoProject(node({
    number: 9, title: 'web-issues', autoAdd: true, updatedAt: '2026-11-09T16:30:47Z',
  }), { nameWithOwner: 'acme/web' })
  assert.equal(candidate.owner, 'ceasarXuu')
  assert.equal(candidate.ownerType, 'user')
  assert.equal(candidate.number, 9)
  assert.equal(candidate.title, 'web-issues')
  assert.equal(candidate.closed, false)
  assert.equal(candidate.autoAdd, true)
  assert.equal(candidate.repository, 'acme/web')
  assert.equal(candidate.itemCount, 12)
  assert.equal(normalizeRepoProject({}, {}), null)
})

test('normalizeRepoProject reads an organization-owned Project', () => {
  const candidate = normalizeRepoProject(node({
    number: 3, title: 'Org board', login: 'acme-labs', type: 'Organization', updatedAt: '2026-11-01T00:00:00Z',
  }), { nameWithOwner: 'acme-labs/app' })
  assert.equal(candidate.ownerType, 'organization')
  assert.equal(candidate.owner, 'acme-labs')
})

test('selectRepoProject prefers the Auto-add workflow, then the newest', () => {
  const autoAdd = normalizeRepoProject(node({
    number: 9, title: 'issues', autoAdd: true, updatedAt: '2026-11-09T00:00:00Z',
  }))
  const newer = normalizeRepoProject(node({
    number: 4, title: 'kanban', autoAdd: false, updatedAt: '2026-11-10T00:00:00Z',
  }))
  const chosen = selectRepoProject([newer, autoAdd])
  assert.equal(chosen.project.number, 9)
  assert.equal(chosen.reason, 'auto-add-workflow')
  assert.equal(chosen.ambiguous, true)
  assert.equal(chosen.considered, 2)

  // Without an auto-add Project the most recently updated one wins.
  const onlyNewer = selectRepoProject([autoAdd, newer].map(candidate => ({ ...candidate, autoAdd: false })))
  assert.equal(onlyNewer.project.number, 4)
  assert.equal(onlyNewer.reason, 'most-recently-updated')
})

test('selectRepoProject never picks a closed Project', () => {
  const closed = normalizeRepoProject(node({ number: 4, title: 'kanban', closed: true, updatedAt: '2026-11-10T00:00:00Z' }))
  assert.equal(selectRepoProject([closed]).project, null)
  assert.equal(selectRepoProject([closed]).reason, 'no-open-project')
  assert.equal(selectRepoProject([]).reason, 'no-open-project')
  assert.equal(selectRepoProject(null).project, null)
})

test('selectRepoProject is not ambiguous for a single candidate', () => {
  const one = normalizeRepoProject(node({ number: 9, title: 'issues', autoAdd: true, updatedAt: '2026-11-09T00:00:00Z' }))
  const chosen = selectRepoProject([one])
  assert.equal(chosen.project.number, 9)
  assert.equal(chosen.ambiguous, false)
})

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

/** In-memory binding store with the subset the binder uses. */
function fakeStore(initial = {}) {
  const bindings = new Map(Object.entries(initial))
  return {
    bindings,
    getWorkspace(workspaceId) {
      return { workspaceId, project: bindings.get(workspaceId) ?? null }
    },
    /** Record the provenance too, so tests can assert it reaches the wire. */
    provenance: new Map(),
    async bindWorkspace(workspaceId, project, autoBind = null) {
      bindings.set(workspaceId, project)
      if (autoBind !== null) this.provenance.set(workspaceId, autoBind)
      else this.provenance.delete(workspaceId)
      return { workspaceId, project }
    },
  }
}

function fakeGh(handler) {
  const calls = []
  return {
    calls,
    async listRepoProjects(repo) {
      calls.push(repo)
      return handler(repo)
    },
  }
}

/** The real acme/web#9 answer, as the binder would store it. */
const USER_PROJECT = normalizeRepoProject(node({
  number: 9, title: 'web-issues', autoAdd: true, updatedAt: '2026-11-09T16:30:47Z',
}))

function binder(overrides = {}) {
  return createWorkspaceAutoBinder({
    store: overrides.store ?? fakeStore(),
    gh: overrides.gh ?? fakeGh(() => ({ repository: 'acme/web', hasProjectsEnabled: true, projects: [USER_PROJECT] })),
    enabled: overrides.enabled !== false,
    ttlMs: overrides.ttlMs ?? 60_000,
    readRemote: overrides.readRemote ?? (async (directory) => ({
      dir: directory, repository: 'acme/web', github: true, remoteUrl: 'git@github.com:acme/web.git', readAt: null,
    })),
    logFault: overrides.logFault ?? (() => {}),
  })
}

test('auto-bind fills an unbound workspace from its git remote', async () => {
  const store = fakeStore()
  const gh = fakeGh(() => ({ repository: 'acme/web', hasProjectsEnabled: true, projects: [USER_PROJECT] }))
  const bind = binder({ store, gh })

  const result = await bind.ensure('wa', '/ws/a')
  assert.equal(result.applied, true)
  assert.equal(result.reason, 'bound')
  assert.equal(result.repository, 'acme/web')
  assert.equal(result.project.number, 9)
  assert.deepEqual(gh.calls, ['acme/web'])
  assert.equal(store.bindings.get('wa').number, 9)
  assert.equal(store.bindings.get('wa').owner, 'ceasarXuu')
  // The provenance travels with the binding, so the board can explain the pick.
  assert.deepEqual(store.provenance.get('wa'), {
    repository: 'acme/web', ambiguous: false, considered: 1,
  })
})

test("auto-bind never replaces a binding the user made", async () => {
  const mine = { owner: 'acme-labs', ownerType: 'organization', number: 2, title: 'my choice', url: null, itemCount: 3, closed: false, description: null }
  const store = fakeStore({ wa: mine })
  const gh = fakeGh(() => { throw new Error('must not be called') })
  const bind = binder({ store, gh })

  const result = await bind.ensure('wa', '/ws/a')
  assert.equal(result.applied, false)
  assert.equal(result.reason, 'already-bound')
  assert.deepEqual(gh.calls, [])
  assert.equal(store.bindings.get('wa').number, 2, 'the user binding must survive untouched')
})

test('auto-bind reports why it did not bind, and remembers the answer', async () => {
  const store = fakeStore()
  const gh = fakeGh(() => ({ repository: 'acme/web', hasProjectsEnabled: true, projects: [] }))
  const bind = binder({ store, gh })

  assert.equal((await bind.ensure('wa', '/ws/a')).reason, 'no-project')
  assert.equal((await bind.ensure('wa', '/ws/a')).reason, 'no-project')
  assert.equal(gh.calls.length, 1, 'a remembered negative answer must not re-query GitHub')
  assert.equal(store.bindings.size, 0)
})

test('auto-bind distinguishes "not a repository" from "not GitHub"', async () => {
  const store = fakeStore()
  const noRepo = binder({ store, readRemote: async () => ({ dir: '/ws', repository: null, github: false, remoteUrl: null }) })
  assert.equal((await noRepo.ensure('wa', '/ws/a')).reason, 'no-remote')

  const notGithub = binder({ store, readRemote: async () => ({ dir: '/ws', repository: null, github: false, remoteUrl: '/srv/mirror.git' }) })
  assert.equal((await notGithub.ensure('wa', '/ws/a')).reason, 'not-github')
})

test('auto-bind does not remember a gh failure, so a retry can succeed', async () => {
  const store = fakeStore()
  let attempt = 0
  const gh = fakeGh(() => {
    attempt += 1
    if (attempt === 1) throw new Error('gh blew up')
    return { repository: 'acme/web', hasProjectsEnabled: true, projects: [USER_PROJECT] }
  })
  const faults = []
  const bind = binder({ store, gh, logFault: (error) => faults.push(String(error)) })

  assert.equal((await bind.ensure('wa', '/ws/a')).reason, 'gh-failed')
  assert.equal(faults.length, 1, 'the failure is reported once')
  const second = await bind.ensure('wa', '/ws/a')
  assert.equal(second.reason, 'bound')
  assert.equal(second.applied, true)
})

test('auto-bind shares one resolution per workspace and honours the TTL', async () => {
  const store = fakeStore()
  let resolutions = 0
  const bind = binder({
    store,
    ttlMs: 5,
    // A repository with no usable Project: the remembered answer is negative,
    // so the store stays empty and re-resolution is observable.
    gh: fakeGh(() => ({ repository: 'acme/web', hasProjectsEnabled: true, projects: [] })),
    readRemote: async (directory) => {
      resolutions += 1
      return { dir: directory, repository: 'acme/web', github: true, remoteUrl: 'x', readAt: null }
    },
  })

  await Promise.all([bind.ensure('wa', '/ws/a'), bind.ensure('wa', '/ws/a'), bind.ensure('wa', '/ws/a')])
  assert.equal(resolutions, 1, 'concurrent calls must share one resolution')

  // Inside the fresh window the remembered answer is reused.
  await bind.ensure('wa', '/ws/a')
  assert.equal(resolutions, 1)

  await new Promise((resolve) => setTimeout(resolve, 15))
  await bind.ensure('wa', '/ws/a')
  assert.equal(resolutions, 2, 'an expired answer is re-resolved')
})

test('a bound workspace answers already-bound without re-reading git', async () => {
  const store = fakeStore()
  let resolutions = 0
  const bind = binder({
    store,
    ttlMs: 5,
    readRemote: async (directory) => {
      resolutions += 1
      return { dir: directory, repository: 'acme/web', github: true, remoteUrl: 'x', readAt: null }
    },
  })

  assert.equal((await bind.ensure('wa', '/ws/a')).reason, 'bound')
  await new Promise((resolve) => setTimeout(resolve, 15))
  // Even after the TTL the durable binding wins: auto-bind fills, never rewrites.
  assert.equal((await bind.ensure('wa', '/ws/a')).reason, 'already-bound')
  assert.equal(resolutions, 1)
})

test('auto-bind is inert when disabled or unaddressable', async () => {
  const store = fakeStore()
  const disabled = binder({ store, enabled: false })
  assert.equal((await disabled.ensure('wa', '/ws/a')).reason, 'disabled')
  assert.equal(store.bindings.size, 0)

  const enabled = binder({ store })
  assert.equal((await enabled.ensure('', '/ws/a')).reason, 'no-workspace')
  assert.equal((await enabled.ensure('wa', '')).reason, 'no-path')
})

test('ensureAll binds every eligible workspace and counts the rest', async () => {
  const store = fakeStore({ already: { owner: 'o', ownerType: 'user', number: 1, title: 't', url: null, itemCount: null, closed: false, description: null } })
  let resolutions = 0
  const bind = binder({
    store,
    readRemote: async (directory) => {
      resolutions += 1
      return directory.includes('norepo')
        ? { dir: directory, repository: null, github: false, remoteUrl: null }
        : { dir: directory, repository: 'acme/web', github: true, remoteUrl: 'x', readAt: null }
    },
  })

  const summary = await bind.ensureAll([
    { id: 'wa', path: '/ws/a' },
    { id: 'already', path: '/ws/b' },
    { id: 'nc', path: '/ws/norepo' },
    { id: '', path: '/ws/invalid' },
  ])
  assert.deepEqual(summary, { bound: 1, considered: 3, skipped: 2 })
  assert.equal(resolutions, 2, 'the user-bound and invalid workspaces are never resolved')
})

test('ensureAll answers a disabled binder without touching anything', async () => {
  const store = fakeStore()
  const bind = binder({ store, enabled: false })
  assert.deepEqual(await bind.ensureAll([{ id: 'wa', path: '/ws/a' }]), { bound: 0, considered: 0, skipped: 0 })
  assert.equal(store.bindings.size, 0)
})

test('a failed store write is reported but keeps the resolved answer usable', async () => {
  const store = {
    bindings: new Map(),
    getWorkspace: () => ({ workspaceId: 'wa', project: null }),
    bindWorkspace: async () => { throw new Error('disk full') },
  }
  const faults = []
  const bind = binder({ store, logFault: (error) => faults.push(String(error)) })

  const result = await bind.ensure('wa', '/ws/a')
  assert.equal(result.applied, false, 'the write did not land')
  assert.equal(result.project.number, 9, 'the resolved Project is still reported')
  assert.equal(faults.length, 1)
})
