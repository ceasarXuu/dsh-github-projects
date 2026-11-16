/**
 * Git branch reader for the `github-projects` host plugin (v1.2.0, contract
 * §3.6).
 *
 * The left sidebar shows the branch every workspace is currently on. That fact
 * lives in the workspace directory's own repository, so this module reads it
 * with `git` (never `gh` — it is local, needs no auth, and works offline):
 *
 * - one `git symbolic-ref --short -q HEAD` answers the branch name, including
 *   an unborn branch that has no commit yet;
 * - a detached HEAD exits 1 with empty output, and is reported as
 *   `{ detached: true, branch: <short sha> }` after one
 *   `git rev-parse --short HEAD`;
 * - "not a repository" (`exit 128`) and a missing directory are not errors:
 *   they answer `{ ok: true, repo: false }` so the sidebar simply shows nothing.
 *
 * Every answer is cached per workspace directory for `ttlMs`, and concurrent
 * reads of one directory share a single in-flight `git` process, so a browser
 * that polls `/branches` never spawns a `git` per request.
 *
 * Plain ESM, `node:*` builtins only.
 */

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Default branch-cache lifetime: the client polls every ~15 s. */
export const DEFAULT_BRANCH_TTL_MS = 10_000

/** One `git` invocation deadline; a hung git must never wedge the HTTP route. */
export const DEFAULT_BRANCH_TIMEOUT_MS = 4_000

/** Bound of the captured `git` output; branch names are short. */
const MAX_BUFFER_BYTES = 1024 * 1024

/** Bound of one tracked workspace directory count (defensive config bound). */
export const MAX_TRACKED_DIRECTORIES = 512

/**
 * Cache entry of one workspace directory.
 * @typedef {{
 *   value: BranchState,
 *   at: number,
 *   inflight: Promise<BranchState> | null,
 * }} BranchCacheEntry
 */

/**
 * Public state of one workspace directory (the `/branches` wire shape).
 * @typedef {{
 *   path: string,
 *   repo: boolean,
 *   branch: string|null,
 *   detached: boolean,
 *   commit: string|null,
 *   readAt: string|null,
 * }} BranchState
 */

function emptyState(path) {
  return { path, repo: false, branch: null, detached: false, commit: null, readAt: null }
}

/** Absolute, normalized directory key; `null` for anything unusable. */
function directoryKey(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > 4096) return null
  // Only absolute POSIX or Windows-drive paths address a workspace.
  const absolute = trimmed.startsWith('/') || /^[A-Za-z]:[/\\]/u.test(trimmed) || trimmed.startsWith('\\\\')
  return absolute ? trimmed : null
}

/** First non-empty trimmed line of `git` output, or `null`. */
function firstLine(text) {
  if (typeof text !== 'string') return null
  const line = text.split(/\r?\n/u).find((part) => part.trim() !== '')
  return line === undefined ? null : line.trim()
}

/** `execFile` rejection is normal for a non-repository; keep its exit facts. */
function exitCodeOf(error) {
  const code = error?.code
  return typeof code === 'number' ? code : null
}

/** Spawn or provider failures that are not "this directory is not a repo". */
function isEnvironmentFailure(error) {
  const code = error?.code
  // ENOENT (git missing), EACCES, E2BIG, ENOEXEC: the command could not run.
  return code === 'ENOENT' || code === 'EACCES' || code === 'EPERM'
}

/**
 * Run one `git` invocation in `cwd`.
 * @returns {Promise<{exitCode: number|null, stdout: string, stderr: string}>}
 */
function runGit(gitCommand, args, cwd, timeoutMs) {
  return execFileAsync(gitCommand, args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER_BYTES,
    windowsHide: true,
    // No prompts, no mail-map lookups, no locale-dependent messages.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
  })
    .then(({ stdout, stderr }) => ({ exitCode: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }))
    .catch((error) => {
      if (isEnvironmentFailure(error)) throw error
      return {
        exitCode: exitCodeOf(error),
        stdout: typeof error?.stdout === 'string' ? error.stdout : '',
        stderr: typeof error?.stderr === 'string' ? error.stderr : String(error?.message ?? ''),
      }
    })
}

/**
 * Read the branch state of one directory. Never throws for a non-repository,
 * a detached HEAD, or a missing directory; a missing `git` executable is the
 * one failure worth reporting to the caller.
 *
 * @param {string} directory - absolute workspace directory.
 * @returns {Promise<BranchState>}
 */
export async function readBranchState(directory, options = {}) {
  const gitCommand = typeof options.gitCommand === 'string' && options.gitCommand.trim() !== ''
    ? options.gitCommand.trim()
    : 'git'
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : DEFAULT_BRANCH_TIMEOUT_MS
  const state = emptyState(directory)

  try {
    const stats = await fs.stat(directory)
    if (!stats.isDirectory()) return state
  } catch {
    // Removed or unreadable directory: no repository, no error.
    return state
  }

  const head = await runGit(gitCommand, ['symbolic-ref', '--short', '-q', 'HEAD'], directory, timeoutMs)
  if (head.exitCode === 0) {
    const branch = firstLine(head.stdout)
    if (branch !== null) {
      return { ...state, repo: true, branch, detached: false, readAt: new Date().toISOString() }
    }
    return { ...state, repo: true, readAt: new Date().toISOString() }
  }
  // 128 = not a repository (or git refused the directory); 1 = detached HEAD.
  if (head.exitCode !== 1) return state

  const sha = await runGit(gitCommand, ['rev-parse', '--short', 'HEAD'], directory, timeoutMs)
  return {
    ...state,
    repo: true,
    branch: null,
    detached: true,
    commit: sha.exitCode === 0 ? firstLine(sha.stdout) : null,
    readAt: new Date().toISOString(),
  }
}

/**
 * Create the per-directory branch cache used by `GET /branches`.
 *
 * @param {object} [options]
 * @param {number} [options.ttlMs] - how long one directory's answer stays fresh.
 * @param {string} [options.gitCommand] - `git` executable (absolute path allowed).
 * @param {number} [options.timeoutMs] - one `git` invocation deadline.
 * @param {(directory: string, options: object) => Promise<BranchState>} [options.read] -
 *   injected reader for tests (must not spawn a process).
 */
export function createBranchReader(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs >= 0 ? options.ttlMs : DEFAULT_BRANCH_TTL_MS
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_BRANCH_TIMEOUT_MS
  const gitCommand = typeof options.gitCommand === 'string' && options.gitCommand.trim() !== ''
    ? options.gitCommand.trim()
    : 'git'
  const read = typeof options.read === 'function'
    ? options.read
    : (directory) => readBranchState(directory, { gitCommand, timeoutMs })

  /** @type {Map<string, BranchCacheEntry>} */
  const entries = new Map()

  /** Read one directory through the cache; never rejects for a read failure. */
  function load(directory, force) {
    const now = Date.now()
    const existing = entries.get(directory)
    if (force !== true && existing !== undefined) {
      if (existing.inflight !== null) return existing.inflight
      if (now - existing.at < ttlMs) return Promise.resolve(existing.value)
    }
    const inflight = read(directory)
      .catch(() => emptyState(directory))
      .then((value) => {
        const entry = entries.get(directory)
        if (entry !== undefined && entry.inflight === inflight) {
          entries.set(directory, { value, at: Date.now(), inflight: null })
        }
        return value
      })
    entries.set(directory, {
      value: existing === undefined ? emptyState(directory) : existing.value,
      at: existing === undefined ? 0 : existing.at,
      inflight,
    })
    if (entries.size > MAX_TRACKED_DIRECTORIES) prune()
    return inflight
  }

  /** Drop entries no caller asked about recently; the cache is a hint only. */
  function prune() {
    const now = Date.now()
    for (const [directory, entry] of entries) {
      if (entry.inflight === null && now - entry.at > ttlMs * 10) entries.delete(directory)
    }
    // A burst of distinct workspaces must still stay bounded.
    while (entries.size > MAX_TRACKED_DIRECTORIES) {
      const oldest = entries.keys().next()
      if (oldest.done === true) break
      entries.delete(oldest.value)
    }
  }

  return {
    /**
     * Branch states of several workspace directories, in the order the caller
     * asked. Duplicates collapse, unusable paths are dropped.
     *
     * @param {readonly string[]} directories - absolute workspace directories.
     * @param {{force?: boolean}} [readOptions] - `force` bypasses the fresh window.
     * @returns {Promise<Record<string, BranchState>>} keyed by the asked path.
     */
    async read(directories, readOptions = {}) {
      const asked = []
      for (const value of Array.isArray(directories) ? directories : []) {
        const directory = directoryKey(value)
        if (directory !== null && !asked.includes(directory)) asked.push(directory)
      }
      const states = await Promise.all(asked.map((directory) => load(directory, readOptions.force === true)))
      const result = {}
      for (let index = 0; index < asked.length; index += 1) result[asked[index]] = states[index]
      return result
    },
  }
}

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
