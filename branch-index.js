/**
 * Workspace-id branch index for the `github-projects` host plugin (v1.2.0,
 * contract §3.6).
 *
 * The sidebar knows workspace ids, so this index resolves each id to its
 * workspace directory through the optional `ctx.workspaceRegistry` service and
 * keeps one cached branch state per workspace. It owns *when* a branch is
 * re-read (startup, a human prompt, staleness) and the `/branches` payload; the
 * `git` invocation itself belongs to `branches.js`.
 *
 * Plain ESM, `node:*` builtins only.
 */

import { createBranchReader } from './branches.js'

/* ------------------------------------------------------------------ */
/* 2. Workspace-id index behind `GET /branches`.                       */
/* ------------------------------------------------------------------ */

/** Normalize a path for equality only (trailing separators, no case folding). */
function comparablePath(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim().replace(/[\\/]+$/u, '')
  return trimmed === '' ? '' : trimmed
}

/**
 * The workspace→branch view served to the sidebar (contract §3.6).
 *
 * The client only knows workspace ids (that is what its rows carry), so this
 * index resolves each id to the workspace directory through the optional
 * `workspaceRegistry` service and reads that directory's branch:
 *
 * - a **startup** refresh answers every registered workspace once;
 * - **every human user message** force-refreshes the workspace that session
 *   belongs to, so sending a prompt in a workspace updates its branch;
 * - a **staleness** refresh (`ttlMs`, default 30 s) covers an external
 *   `git checkout` in between.
 *
 * Because the browser polls, every answer carries a monotonic `revision`; the
 * client skips repainting when it did not change.
 *
 * @param {object} [options]
 * @param {() => object|undefined|null} [options.getRegistry] - resolves
 *   `ctx.workspaceRegistry` lazily (it may mount after this plugin).
 * @param {string} [options.gitCommand] - `git` executable.
 * @param {number} [options.timeoutMs] - one `git` invocation deadline.
 * @param {number} [options.ttlMs] - how long one directory's branch stays fresh.
 * @param {(directories: readonly string[], options?: object) => Promise<object>} [options.reader] -
 *   injected directory reader (tests bypass git entirely).
 */
export function createWorkspaceBranchIndex(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs >= 0 ? options.ttlMs : 30_000
  const injected = options.reader !== null && typeof options.reader === 'object' ? options.reader : null
  const reader = injected ?? createBranchReader({
    ttlMs: 0,
    gitCommand: options.gitCommand,
    timeoutMs: options.timeoutMs,
  })
  const readDirectories = (directories) => reader.read(directories, { force: true })
  const getRegistry = typeof options.getRegistry === 'function' ? options.getRegistry : () => undefined

  /** workspace id → last known branch state. */
  const states = new Map()
  /** workspace id → epoch ms of the last successful read. */
  const readAt = new Map()
  /** Force-refresh requests that arrived while a refresh was running. */
  let pending = Promise.resolve()
  let queued = null
  let revision = 0
  let updatedAt = null
  let gitAvailable = null
  let lastError = null

  /** Workspace id → directory, in registry order; empty without a registry. */
  function workspacesNow() {
    const registry = getRegistry()
    if (registry === null || registry === undefined || typeof registry.list !== 'function') return []
    let list
    try {
      list = registry.list()
    } catch {
      return []
    }
    const result = []
    for (const entity of Array.isArray(list) ? list : []) {
      const id = typeof entity?.id === 'string' ? entity.id : ''
      const path = typeof entity?.path === 'string' ? entity.path : ''
      if (id === '' || path === '') continue
      result.push({ id, path })
    }
    return result
  }

  /** Refresh the given workspace ids through the directory reader. */
  async function refreshEntries(entries) {
    if (entries.length === 0) return false
    let values
    try {
      values = await readDirectories(entries.map((entry) => entry.path))
    } catch (error) {
      // A missing `git` executable (or a provider failure) is reported once in
      // the payload; the sidebar then renders nothing instead of guessing.
      gitAvailable = error?.code === 'ENOENT' ? false : gitAvailable
      lastError = error instanceof Error ? error.message : String(error)
      return false
    }
    gitAvailable = true
    lastError = null
    let changed = false
    const at = Date.now()
    for (const entry of entries) {
      const next = values?.[entry.path]
      if (next === undefined || next === null) continue
      const previous = states.get(entry.id)
      states.set(entry.id, { ...next, workspaceId: entry.id })
      readAt.set(entry.id, at)
      if (previous === undefined
        || previous.branch !== next.branch
        || previous.detached !== next.detached
        || previous.commit !== next.commit
        || previous.repo !== next.repo
        || previous.path !== next.path) {
        changed = true
      }
    }
    return changed
  }

  /**
   * Run one refresh pass, serialized so concurrent callers cannot interleave.
   * @param {'all'|Set<string>} which - every registered workspace, or one exact
   *   id set (a startup pass, one prompt's workspace, or the stale ids).
   */
  function refresh(which) {
    const run = pending.then(async () => {
      const all = workspacesNow()
      const targets = which === 'all'
        ? all
        : all.filter((entry) => which.has(entry.id))
      // Forget workspaces that no longer exist so the payload stays small.
      const alive = new Set(all.map((entry) => entry.id))
      for (const id of [...states.keys()]) {
        if (!alive.has(id)) {
          states.delete(id)
          readAt.delete(id)
        }
      }
      if (await refreshEntries(targets)) {
        revision += 1
        updatedAt = new Date().toISOString()
      }
      return true
    })
    pending = run.then(() => undefined, () => undefined)
    return run
  }

  /** Refresh every registered workspace once (startup). */
  async function refreshAll() {
    const registry = getRegistry()
    if (registry === null || registry === undefined) return false
    return refresh('all')
  }

  /** Workspace id owning one live session, from the registry's session accounts. */
  function workspaceIdOfSession(session) {
    const id = typeof session?.id === 'string' ? session.id : ''
    if (id !== '') {
      const registry = getRegistry()
      if (registry !== null && registry !== undefined && typeof registry.list === 'function') {
        let list
        try {
          list = registry.list()
        } catch {
          list = null
        }
        for (const candidate of Array.isArray(list) ? list : []) {
          if (Array.isArray(candidate?.sessionIds) && candidate.sessionIds.includes(id) && typeof candidate.id === 'string') {
            return candidate.id
          }
        }
      }
    }
    const cwd = comparablePath(session?.header?.cwd ?? session?.cwd)
    if (cwd === '') return null
    return workspacesNow().find((entry) => comparablePath(entry.path) === cwd)?.id ?? null
  }

  /** Refresh the workspace that owns one session (a human prompt arrived). */
  async function refreshForSession(session) {
    const workspaceId = workspaceIdOfSession(session)
    if (workspaceId === null) return false
    return refresh(new Set([workspaceId]))
  }

  /** Only the workspaces whose last read is older than the staleness window. */
  function staleIds(all) {
    const now = Date.now()
    return new Set(all
      .filter((entry) => now - (readAt.get(entry.id) ?? 0) >= ttlMs)
      .map((entry) => entry.id))
  }

  /** Coalesce concurrent staleness refreshes into one queued pass. */
  function scheduleStale(ids) {
    if (queued !== null) return queued
    queued = refresh(ids).finally(() => { queued = null })
    return queued
  }

  return {
    /** Resolve the id of the workspace owning a session, or `null`. */
    workspaceIdOf: workspaceIdOfSession,

    /** Startup pass: read every registered workspace once. */
    refreshAll,

    /** Human prompt pass: re-read the prompt's workspace. */
    refreshForSession,

    /**
     * The `/branches` payload. Refreshes stale entries first (bounded wait by
     * the caller), then answers the whole map.
     *
     * @returns {Promise<{
     *   revision: number,
     *   updatedAt: string|null,
     *   git: {available: boolean|null},
     *   workspaces: Record<string, {workspaceId: string, path: string, repo: boolean,
     *     branch: string|null, detached: boolean, commit: string|null, readAt: string|null}>,
     * }>}
     */
    async read() {
      const all = workspacesNow()
      const stale = staleIds(all)
      if (stale.size > 0) {
        // Await the pass so a first request already answers real data.
        await scheduleStale(stale)
      }
      const workspaces = {}
      for (const entry of workspacesNow()) {
        const state = states.get(entry.id)
        if (state === undefined) continue
        workspaces[entry.id] = {
          workspaceId: entry.id,
          path: state.path,
          repo: state.repo === true,
          branch: typeof state.branch === 'string' ? state.branch : null,
          detached: state.detached === true,
          commit: typeof state.commit === 'string' ? state.commit : null,
          readAt: typeof state.readAt === 'string' ? state.readAt : null,
        }
      }
      return {
        revision,
        updatedAt,
        git: { available: gitAvailable, error: lastError },
        workspaces,
      }
    },
  }
}
