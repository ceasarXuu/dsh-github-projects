/**
 * Git remote reader for the `github-projects` host plugin (v1.3.0, contract
 * §3.7).
 *
 * Auto-bind needs to answer one question about a workspace directory: **which
 * GitHub repository does it belong to?** That is the directory's `origin`
 * remote, so it is read with local `git` — never the network, never auth:
 *
 * - `git config --get remote.origin.url` answers the configured URL;
 * - `git rev-parse --show-toplevel` is not needed: `git config` already walks up
 *   to the enclosing repository, so a workspace pointing at a subdirectory of a
 *   checkout still answers that checkout's remote (the same behaviour the branch
 *   chip relies on).
 *
 * Every URL shape git accepts is normalized to `owner/name`:
 *
 *   git@github.com:owner/repo.git        https://github.com/owner/repo.git
 *   ssh://git@github.com/owner/repo.git  https://user@github.com/owner/repo
 *   git://github.com/owner/repo          /abs/path/to/local-mirror
 *
 * A non-GitHub remote (a local mirror, GitLab, Bitbucket, …) answers
 * `github: false`: auto-bind must never guess a repository that is not on
 * GitHub. A directory that is not a repository, or has no `origin`, answers
 * `repo: null` — again not an error.
 *
 * Plain ESM, `node:*` builtins only.
 */

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** One `git config` invocation deadline; reading a config is cheap. */
export const DEFAULT_REMOTE_TIMEOUT_MS = 4_000

/** Bound of the captured `git` output. */
const MAX_BUFFER_BYTES = 256 * 1024

/** `owner/name` as GitHub spells it; both parts stop at the first separator. */
const OWNER_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u

/**
 * Normalize one git remote URL to `owner/name`.
 *
 * Handles the scp-like shorthand (`git@host:owner/repo`), `ssh://`, `git://`,
 * `http(s)://`, with an optional `.git` suffix, trailing slash, embedded
 * credentials, or a port. Anything whose host is not GitHub answers `null`.
 *
 * @param {string} raw - `remote.origin.url` as configured.
 * @returns {string|null} `owner/name`, or null when it is not a GitHub repo.
 */
export function parseGitHubRemote(raw) {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (value === '' || value.length > 2048) return null

  let path = null
  let host = null

  // scp-like shorthand: `[user@]host:path` (no scheme, no leading `/`).
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/u.exec(value)
  if (scp !== null && !value.includes('://') && !value.startsWith('/')) {
    host = scp[1]
    path = scp[2]
  } else if (value.includes('://')) {
    let parsed
    try {
      parsed = new URL(value)
    } catch {
      return null
    }
    host = parsed.hostname
    path = decodeURIComponent(parsed.pathname)
  } else {
    // A plain local path or relative remote: not a GitHub repository.
    return null
  }

  if (typeof host !== 'string' || host.toLowerCase() !== 'github.com') return null
  if (typeof path !== 'string') return null

  let normalized = path.replace(/^\/+/u, '').replace(/\/+$/u, '')
  if (normalized.toLowerCase().endsWith('.git')) normalized = normalized.slice(0, -'.git'.length)
  if (normalized === '' || normalized.includes('//')) return null

  // Exactly two segments: a deeper path is a URL to a file, not a repository.
  const segments = normalized.split('/')
  if (segments.length !== 2) return null
  const candidate = `${segments[0]}/${segments[1]}`
  return OWNER_REPO_PATTERN.test(candidate) ? candidate : null
}

/** First non-empty trimmed line of `git` output, or `null`. */
function firstLine(text) {
  if (typeof text !== 'string') return null
  const line = text.split(/\r?\n/u).find((part) => part.trim() !== '')
  return line === undefined ? null : line.trim()
}

/** `execFile` rejection is normal here; keep its exit facts. */
function runGit(gitCommand, args, cwd, timeoutMs) {
  return execFileAsync(gitCommand, args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER_BYTES,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
  })
    .then(({ stdout }) => ({ exitCode: 0, stdout: String(stdout ?? '') }))
    .catch((error) => {
      const code = error?.code
      if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') throw error
      return {
        exitCode: typeof code === 'number' ? code : null,
        stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      }
    })
}

/**
 * Read the GitHub repository of one directory.
 *
 * @param {string} directory - absolute workspace directory.
 * @param {{gitCommand?: string, timeoutMs?: number}} [options]
 * @returns {Promise<{
 *   dir: string, repository: string|null, github: boolean,
 *   remoteUrl: string|null, readAt: string|null,
 * }>} `repository` is `owner/name` only when `github` is true.
 */
export async function readRemoteState(directory, options = {}) {
  const gitCommand = typeof options.gitCommand === 'string' && options.gitCommand.trim() !== ''
    ? options.gitCommand.trim()
    : 'git'
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_REMOTE_TIMEOUT_MS
  const empty = { dir: directory, repository: null, github: false, remoteUrl: null, readAt: null }

  try {
    const stats = await fs.stat(directory)
    if (!stats.isDirectory()) return empty
  } catch {
    return empty
  }

  const result = await runGit(gitCommand, ['config', '--get', 'remote.origin.url'], directory, timeoutMs)
  if (result.exitCode !== 0) return empty
  const remoteUrl = firstLine(result.stdout)
  if (remoteUrl === null) return empty
  const repository = parseGitHubRemote(remoteUrl)
  return {
    dir: directory,
    repository,
    github: repository !== null,
    remoteUrl,
    readAt: new Date().toISOString(),
  }
}
