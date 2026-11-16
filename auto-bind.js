/**
 * Workspace auto-bind for the `github-projects` host plugin (v1.3.0, contract
 * §3.7).
 *
 * Today a user has to open a workspace, click the board icon, and pick a
 * Project. Most workspaces are a checkout of exactly one GitHub repository, and
 * that repository already says which Project it belongs to, so that click is
 * usually answering a question GitHub could answer:
 *
 * - a workspace directory has an `origin` remote (`git-remote.js`);
 * - the repository links its Projects (`gh` → `listRepoProjects`);
 * - one of them is the repository's intended Project — GitHub marks it with its
 *   own "Auto-add to project" workflow, otherwise the most recently updated
 *   open one wins (`selectRepoProject`).
 *
 * **Auto-bind only fills a gap.** A workspace the user bound is never touched:
 * an automatic answer must never overwrite a deliberate one. Successes are
 * remembered per workspace so a restart does not re-ask GitHub, and successes
 * *and* negative answers are remembered so a repository with no usable Project
 * is not queried on every poll.
 *
 * Plain ESM, `node:*` builtins only.
 */

import { selectRepoProject } from './github.js'
import { readRemoteState } from './git-remote.js'

/**
 * How long a resolved answer is trusted before it is re-checked. A new Project
 * being linked should be picked up on a later start, but not on every request.
 */
export const DEFAULT_AUTOBIND_TTL_MS = 10 * 60 * 1000

/** Bound on remembered workspaces; the store itself is the durable record. */
const MAX_REMEMBERED = 512

/**
 * Create the workspace auto-binder.
 *
 * @param {object} options
 * @param {object} options.store - the durable binding store (`state.js`).
 * @param {object} options.gh - the `gh` adapter (`github.js`).
 * @param {boolean} [options.enabled] - the `autoBind` config flag.
 * @param {number} [options.ttlMs] - how long one resolved answer is trusted.
 * @param {string} [options.gitCommand] - `git` executable for the remote read.
 * @param {number} [options.timeoutMs] - one `git config` deadline.
 * @param {Function} [options.readRemote] - injected remote reader (tests).
 * @param {(error: unknown) => void} [options.logFault] - fault reporter.
 */
export function createWorkspaceAutoBinder(options = {}) {
  const store = options.store
  const gh = options.gh
  const enabled = options.enabled === true
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs >= 0
    ? options.ttlMs
    : DEFAULT_AUTOBIND_TTL_MS
  const gitCommand = typeof options.gitCommand === 'string' && options.gitCommand.trim() !== ''
    ? options.gitCommand.trim()
    : 'git'
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : undefined
  const logFault = typeof options.logFault === 'function' ? options.logFault : () => {}
  const readRemote = typeof options.readRemote === 'function'
    ? options.readRemote
    : (directory) => readRemoteState(directory, { gitCommand, timeoutMs })

  /** workspaceId → { outcome, at } with `outcome` a resolved answer. */
  const remembered = new Map()
  /** Workspaces currently being resolved, so a burst shares one answer. */
  const inflight = new Map()
  /** Durability queue: one write at a time, failures logged not thrown. */
  let writing = Promise.resolve()

  function remember(workspaceId, outcome) {
    remembered.set(workspaceId, { outcome, at: Date.now() })
    if (remembered.size > MAX_REMEMBERED) {
      const oldest = remembered.keys().next()
      if (oldest.done !== true) remembered.delete(oldest.value)
    }
  }

  function fresh(workspaceId) {
    const entry = remembered.get(workspaceId)
    if (entry === undefined) return null
    return Date.now() - entry.at < ttlMs ? entry.outcome : null
  }

  /**
   * Persist one workspace binding, serialized and fault-logged. The provenance
   * (which repository it came from, whether the pick was one of several) rides
   * along so the board can explain an automatic choice after a reload.
   */
  function persistBinding(workspaceId, project, provenance) {
    const write = writing.then(() => store.bindWorkspace(workspaceId, project, provenance))
    writing = write.then(() => undefined, (error) => { logFault(error) })
    return write
  }

  /**
   * Resolve one workspace: remote → repository → the Project it should use.
   *
   * @param {string} workspaceId
   * @param {string} path - the workspace directory.
   * @returns {Promise<{
   *   workspaceId: string, path: string, applied: boolean,
   *   reason: string, repository: string|null, project: object|null,
   *   ambiguous: boolean, considered: number,
   * }>}
   */
  async function resolveOne(workspaceId, path) {
    const base = {
      workspaceId,
      path,
      applied: false,
      reason: 'not-attempted',
      repository: null,
      project: null,
      ambiguous: false,
      considered: 0,
    }
    if (enabled !== true) return { ...base, reason: 'disabled' }
    // Never replace a binding the user made (or one already applied here).
    const existing = store.getWorkspace(workspaceId)
    if (existing !== null && existing !== undefined && existing.project !== null) {
      return { ...base, reason: 'already-bound' }
    }

    const cached = fresh(workspaceId)
    if (cached !== null) {
      // A remembered success still needs applying if the store lost it.
      if (cached.reason === 'bound' || cached.reason === 'bound-ambiguous') {
        const applied = await apply(workspaceId, cached.project, {
          repository: cached.repository,
          ambiguous: cached.ambiguous === true,
          considered: cached.considered,
        })
        return { ...cached, applied }
      }
      return cached
    }

    const remote = await readRemote(path)
    if (remote === null || remote === undefined || remote.github !== true || typeof remote.repository !== 'string') {
      const outcome = { ...base, reason: remote?.remoteUrl === null || remote?.remoteUrl === undefined
        ? 'no-remote'
        : 'not-github' }
      remember(workspaceId, outcome)
      return outcome
    }

    const wanted = remote.repository
    let result
    try {
      result = await gh.listRepoProjects(wanted)
    } catch (error) {
      // A GitHub read failure is not a fact about the repository: never
      // remember it, so the next attempt can still succeed.
      logFault(error)
      return { ...base, reason: 'gh-failed', repository: wanted }
    }

    const selection = selectRepoProject(result.projects)
    if (selection.project === null) {
      const outcome = {
        ...base,
        reason: result.projects.length === 0 ? 'no-project' : 'no-open-project',
        repository: wanted,
        considered: selection.considered,
      }
      remember(workspaceId, outcome)
      return outcome
    }

    const project = {
      owner: selection.project.owner,
      ownerType: selection.project.ownerType,
      number: selection.project.number,
      title: selection.project.title,
      url: selection.project.url,
      itemCount: selection.project.itemCount,
      closed: false,
      description: selection.project.description,
    }
    const outcome = {
      ...base,
      reason: selection.ambiguous ? 'bound-ambiguous' : 'bound',
      repository: wanted,
      project,
      ambiguous: selection.ambiguous,
      considered: selection.considered,
    }
    const applied = await apply(workspaceId, project, {
      repository: wanted,
      ambiguous: selection.ambiguous,
      considered: selection.considered,
    })
    remember(workspaceId, outcome)
    return { ...outcome, applied }
  }

  /** Write the binding, reporting whether it landed. */
  async function apply(workspaceId, project, provenance = null) {
    if (project === null || project === undefined) return false
    try {
      await persistBinding(workspaceId, project, provenance)
      return true
    } catch {
      // `persistBinding` already logged; the in-memory answer stays useful.
      return false
    }
  }

  /** Share one in-flight resolution per workspace. */
  function resolveShared(workspaceId, path) {
    const running = inflight.get(workspaceId)
    if (running !== undefined) return running
    const promise = resolveOne(workspaceId, path).finally(() => { inflight.delete(workspaceId) })
    inflight.set(workspaceId, promise)
    return promise
  }

  return {
    /** Whether the `autoBind` config flag is on. */
    get enabled() { return enabled },

    /**
     * Ensure a binding for one workspace, without ever touching a user's own.
     * Safe to call repeatedly: a resolved answer is remembered for `ttlMs`.
     *
     * @param {string} workspaceId
     * @param {string} path - absolute workspace directory.
     */
    ensure(workspaceId, path) {
      if (enabled !== true) return Promise.resolve({ workspaceId, path, applied: false, reason: 'disabled' })
      if (typeof workspaceId !== 'string' || workspaceId === '') {
        return Promise.resolve({ workspaceId: '', path, applied: false, reason: 'no-workspace' })
      }
      if (typeof path !== 'string' || path === '') {
        return Promise.resolve({ workspaceId, path, applied: false, reason: 'no-path' })
      }
      return resolveShared(workspaceId, path)
    },

    /**
     * Ensure a binding for every registered workspace (startup pass).
     * Resolved sequentially: `gh` calls are the expensive step and a profile
     * rarely has more than a handful of repositories.
     *
     * @param {readonly {id: string, path: string}[]} workspaces
     * @returns {Promise<{bound: number, considered: number, skipped: number}>}
     */
    async ensureAll(workspaces) {
      const summary = { bound: 0, considered: 0, skipped: 0 }
      if (enabled !== true) return summary
      for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
        if (workspace === null || typeof workspace !== 'object') continue
        // Empty strings are not identifiers: binding under '' would create a
        // phantom workspace record and never show up on any row.
        if (typeof workspace.id !== 'string' || workspace.id === '') continue
        if (typeof workspace.path !== 'string' || workspace.path === '') continue
        summary.considered += 1
        const result = await resolveShared(workspace.id, workspace.path)
        if (result.applied === true) summary.bound += 1
        else summary.skipped += 1
      }
      return summary
    },

    /** Last remembered answer for one workspace (diagnostics/tests). */
    lastAnswer(workspaceId) {
      return remembered.get(workspaceId)?.outcome ?? null
    },

    /** Forget everything (tests, or a repository relinked to a new Project). */
    reset() {
      remembered.clear()
      inflight.clear()
    },
  }
}
