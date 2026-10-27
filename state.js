/**
 * Durable binding store for the `github-projects` host plugin.
 *
 * One small JSON file keeps the workspace → GitHub Project and session → Issue
 * bindings shared by every session of a profile (contract §3.3). The file is
 * plain JSON, version 1, written atomically through `state.json.tmp` + rename
 * inside the same directory, with a single serialized write queue so two
 * concurrent binds can never interleave or lose each other.
 *
 * Reads tolerate a missing, unreadable, truncated, or foreign-version file by
 * answering the empty store: bindings are convenience state, never a startup
 * failure. A failed write leaves the previous file untouched and rejects with
 * a `state-write-failed` error so the HTTP layer can answer 500.
 *
 * Plain ESM, `node:*` builtins only.
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** File-format version written and accepted by this module. */
const STATE_VERSION = 1

/** Default mode of the binding file (owner read/write only). */
const FILE_MODE = 0o600

/** Error code the HTTP layer maps to 500 `state-write-failed`. */
export const STATE_WRITE_FAILED = 'state-write-failed'

/** Failure of one persisted write; the previous file is still in place. */
export class StateStoreError extends Error {
  constructor(message, options) {
    super(message)
    this.name = 'StateStoreError'
    this.code = STATE_WRITE_FAILED
    if (options?.cause !== undefined) this.cause = options.cause
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}

function emptySnapshot() {
  return { version: STATE_VERSION, updatedAt: null, workspaces: {}, sessions: {} }
}

/** Deep copy of a JSON-ish value; bindings are plain data by contract. */
function copy(value) {
  if (value === null || typeof value !== 'object') return value
  try {
    return structuredClone(value)
  } catch {
    return JSON.parse(JSON.stringify(value))
  }
}

function isStoredProject(value) {
  return isRecord(value)
    && typeof value.owner === 'string'
    && Number.isInteger(value.number)
    && value.number > 0
}

function isStoredIssue(value) {
  return isRecord(value)
    && typeof value.repo === 'string'
    && Number.isInteger(value.number)
    && value.number > 0
}

function isStoredWorkspaceEntry(value) {
  return isRecord(value) && isStoredProject(value.project)
}

function isStoredSessionEntry(value) {
  return isRecord(value) && isStoredIssue(value.issue)
}

/**
 * Normalize a parsed file into the versioned snapshot shape, dropping entries
 * this version cannot understand instead of failing the whole read.
 */
function sanitizeSnapshot(parsed) {
  if (!isRecord(parsed) || parsed.version !== STATE_VERSION) return emptySnapshot()
  const workspaces = {}
  if (isRecord(parsed.workspaces)) {
    for (const [workspaceId, entry] of Object.entries(parsed.workspaces)) {
      if (!isId(workspaceId) || !isStoredWorkspaceEntry(entry)) continue
      workspaces[workspaceId] = {
        project: copy(entry.project),
        boundAt: typeof entry.boundAt === 'string' ? entry.boundAt : null,
      }
    }
  }
  const sessions = {}
  if (isRecord(parsed.sessions)) {
    for (const [sessionId, entry] of Object.entries(parsed.sessions)) {
      if (!isId(sessionId) || !isStoredSessionEntry(entry)) continue
      sessions[sessionId] = {
        issue: copy(entry.issue),
        workspaceId: isId(entry.workspaceId) ? entry.workspaceId : null,
        boundAt: typeof entry.boundAt === 'string' ? entry.boundAt : null,
      }
    }
  }
  return {
    version: STATE_VERSION,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    workspaces,
    sessions,
  }
}

/** Read and sanitize one state file; any failure answers the empty store. */
function readSnapshot(filePath) {
  let text
  try {
    text = readFileSync(filePath, 'utf8')
  } catch {
    return emptySnapshot()
  }
  try {
    return sanitizeSnapshot(JSON.parse(text))
  } catch {
    return emptySnapshot()
  }
}

/** One serialized write queue; a rejected task never blocks the next one. */
function createQueue() {
  let tail = Promise.resolve()
  return (task) => {
    const result = tail.then(task, task)
    tail = result.then(() => undefined, () => undefined)
    return result
  }
}

/** Bindings exposed to callers always carry their id, even on unknown ids. */
function workspaceBinding(workspaceId, entry) {
  return { workspaceId, project: entry === null ? null : copy(entry.project) }
}

function sessionBinding(sessionId, entry) {
  if (entry === null) return { sessionId, issue: null, workspaceId: null }
  return {
    sessionId,
    issue: copy(entry.issue),
    workspaceId: entry.workspaceId,
  }
}

/**
 * Create the binding store rooted at one JSON file.
 *
 * Methods are plain data operations (no `ctx`): reads are synchronous and
 * tolerant, writes return promises that resolve after the file was renamed
 * into place. The store never touches the network and never logs.
 *
 * @param {string} filePath - absolute path of `state.json`.
 */
export function createStateStore(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new TypeError('createStateStore(path): path must be a non-empty string')
  }
  const resolvedPath = filePath
  const tempPath = `${resolvedPath}.tmp`
  const enqueue = createQueue()

  /** Persist one snapshot atomically, then keep it as the returned value. */
  async function persist(snapshot) {
    try {
      mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 })
    } catch (error) {
      throw new StateStoreError(`cannot create binding directory: ${error?.message ?? error}`, { cause: error })
    }
    try {
      await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: FILE_MODE })
      await rename(tempPath, resolvedPath)
    } catch (error) {
      // Leave the previous file in place; drop the half-written temp file.
      try { await unlink(tempPath) } catch { /* nothing to clean up */ }
      throw new StateStoreError(`cannot write bindings: ${error?.message ?? error}`, { cause: error })
    }
    return snapshot
  }

  /** Mutate a fresh on-disk snapshot inside the write queue. */
  function mutate(mutator) {
    return enqueue(async () => {
      const snapshot = readSnapshot(resolvedPath)
      const result = mutator(snapshot)
      snapshot.updatedAt = new Date().toISOString()
      await persist(snapshot)
      return result
    })
  }

  return {
    /** Current durable snapshot (empty shape when the file is missing/corrupt). */
    read() {
      return readSnapshot(resolvedPath)
    },

    /** Stored workspace binding, or `{ workspaceId, project: null }`. */
    getWorkspace(workspaceId) {
      const snapshot = readSnapshot(resolvedPath)
      const entry = isId(workspaceId) && Object.hasOwn(snapshot.workspaces, workspaceId)
        ? snapshot.workspaces[workspaceId]
        : null
      return workspaceBinding(isId(workspaceId) ? workspaceId : '', entry)
    },

    /** Stored session binding, or `{ sessionId, issue: null, workspaceId: null }`. */
    getSession(sessionId) {
      const snapshot = readSnapshot(resolvedPath)
      const entry = isId(sessionId) && Object.hasOwn(snapshot.sessions, sessionId)
        ? snapshot.sessions[sessionId]
        : null
      return sessionBinding(isId(sessionId) ? sessionId : '', entry)
    },

    /**
     * Bind (or replace) the Project of one workspace.
     * @returns {Promise<{workspaceId: string, project: object}>}
     */
    bindWorkspace(workspaceId, project) {
      if (!isId(workspaceId)) throw new TypeError('bindWorkspace: workspaceId must be a non-empty string')
      if (!isStoredProject(project)) throw new TypeError('bindWorkspace: project must carry an owner and a positive number')
      const stored = copy(project)
      return mutate((snapshot) => {
        snapshot.workspaces[workspaceId] = {
          project: stored,
          boundAt: new Date().toISOString(),
        }
        return workspaceBinding(workspaceId, snapshot.workspaces[workspaceId])
      })
    },

    /** Remove the Project binding of one workspace (idempotent). */
    unbindWorkspace(workspaceId) {
      if (!isId(workspaceId)) throw new TypeError('unbindWorkspace: workspaceId must be a non-empty string')
      return mutate((snapshot) => {
        if (Object.hasOwn(snapshot.workspaces, workspaceId)) delete snapshot.workspaces[workspaceId]
        return true
      })
    },

    /**
     * Bind (or replace) the Issue of one session.
     * @returns {Promise<{sessionId: string, issue: object, workspaceId: string|null}>}
     */
    bindIssue(sessionId, issue, workspaceId = null) {
      if (!isId(sessionId)) throw new TypeError('bindIssue: sessionId must be a non-empty string')
      if (!isStoredIssue(issue)) throw new TypeError('bindIssue: issue must carry a repo and a positive number')
      const stored = copy(issue)
      const workspace = isId(workspaceId) ? workspaceId : null
      return mutate((snapshot) => {
        snapshot.sessions[sessionId] = {
          issue: stored,
          workspaceId: workspace,
          boundAt: new Date().toISOString(),
        }
        return sessionBinding(sessionId, snapshot.sessions[sessionId])
      })
    },

    /** Remove the Issue binding of one session (idempotent). */
    unbindIssue(sessionId) {
      if (!isId(sessionId)) throw new TypeError('unbindIssue: sessionId must be a non-empty string')
      return mutate((snapshot) => {
        if (Object.hasOwn(snapshot.sessions, sessionId)) delete snapshot.sessions[sessionId]
        return true
      })
    },

    /** Raw versioned snapshot with both maps (fresh read, defensive copy). */
    snapshot() {
      return readSnapshot(resolvedPath)
    },
  }
}
