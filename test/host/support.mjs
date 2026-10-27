/**
 * Shared, side-effect-free helpers for the host half's `node:test` suites.
 *
 * Nothing here talks to GitHub or the network: the fake web server and the
 * fake `gh` runner are in-memory. Real fixtures under `test/fixtures/` feed
 * the normalizer and route-shape assertions.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../../index.js'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const FIXTURE_DIR = join(HERE, '..', 'fixtures')
export const APP_PREFIX = '/plugin/github-projects'

/* ------------------------------------------------------------------ */
/* Fixtures.                                                           */
/* ------------------------------------------------------------------ */

export function loadFixture(name) {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'))
}

export const fixture = {
  projects: loadFixture('project-list.json'),
  items: loadFixture('item-list.json'),
  issue: loadFixture('issue.json'),
  comments: loadFixture('issue-comments.json'),
}

/* ------------------------------------------------------------------ */
/* Fake `gh` runner.                                                   */
/* ------------------------------------------------------------------ */

/** Create a runner whose invocation log is `runner.calls`. */
export function createRunner(handler) {
  /** @type {string[][]} */
  const calls = []
  const run = async (args) => {
    calls.push([...args])
    return handler(args)
  }
  run.calls = calls
  run.commands = () => calls.map((args) => args.join(' '))
  return run
}

/** Classified-style error that `execFile` would reject with for a non-zero exit. */
export function ghError(stderr, code = 1) {
  return Object.assign(new Error(stderr), { code, stderr, stdout: '' })
}

export function ghNotFound(message = 'gh: Not Found (HTTP 404)') {
  return ghError(message)
}

export function ghAuthError() {
  return ghError('To get started with GitHub CLI, please run:  gh auth login')
}

export function ghMissingError(ghCommand = 'gh') {
  return Object.assign(new Error(`spawn ${ghCommand} ENOENT`), { code: 'ENOENT', path: ghCommand, syscall: `spawn ${ghCommand}` })
}

export function ghTimeoutError() {
  return Object.assign(new Error('Command failed: gh'), { code: null, killed: true, signal: 'SIGTERM', stderr: '' })
}

export function ghProjectNotFound(number) {
  return ghError(`GraphQL: Could not resolve to a ProjectV2 with the number ${String(number)}. (user.projectV2)`)
}

const PROJECT_OWNER = 'ceasarXuu'
const PR_NUMBER = 283

/**
 * Default fixture-backed gh invocation handler.
 * Supports the exact read commands the adapter issues for the captured data.
 */
export async function fixtureRun(args) {
  const command = args.join(' ')
  if (command === '--version') {
    return { stdout: 'gh version 2.96.0 (2026-07-02)\nhttps://github.com/cli/cli/releases/tag/v2.96.0\n', stderr: '' }
  }
  if (command === 'api user --jq .login') return { stdout: `${PROJECT_OWNER}\n`, stderr: '' }
  if (command === 'api user/orgs --jq [.[].login]') return { stdout: '["XuyuTech","BeanDoor"]\n', stderr: '' }

  if (args[0] === 'project' && args[1] === 'list') {
    const owner = args[args.indexOf('--owner') + 1]
    const payload = owner === PROJECT_OWNER ? fixture.projects : { projects: [], totalCount: 0 }
    return { stdout: `${JSON.stringify(payload)}\n`, stderr: '' }
  }
  if (args[0] === 'project' && args[1] === 'view') {
    const number = Number(args[2])
    const owner = args[args.indexOf('--owner') + 1]
    const project = (fixture.projects.projects ?? []).find(entry => entry.number === number && entry.owner?.login === owner)
    if (project === undefined) throw ghProjectNotFound(number)
    return { stdout: `${JSON.stringify(project)}\n`, stderr: '' }
  }
  if (args[0] === 'project' && args[1] === 'item-list') {
    const number = Number(args[2])
    if (number !== 9) throw ghProjectNotFound(number)
    return { stdout: `${JSON.stringify(fixture.items)}\n`, stderr: '' }
  }

  if (args[0] === 'api') {
    const resource = args[1] ?? ''
    if (resource === `repos/${PROJECT_OWNER}/Astropath/issues/240`) {
      return { stdout: `${JSON.stringify(fixture.issue)}\n`, stderr: '' }
    }
    if (resource === `repos/${PROJECT_OWNER}/Astropath/issues/${String(PR_NUMBER)}`) {
      const pullRequest = { ...fixture.issue, number: PR_NUMBER, pull_request: { url: 'https://api.github.com/repos/ceasarXuu/Astropath/pulls/283' } }
      return { stdout: `${JSON.stringify(pullRequest)}\n`, stderr: '' }
    }
    if (resource.startsWith(`repos/${PROJECT_OWNER}/Astropath/issues/240/comments?per_page=`)) {
      return { stdout: `${JSON.stringify(fixture.comments)}\n`, stderr: '' }
    }
  }
  throw ghError(`unexpected gh invocation: ${command}`)
}

/** Fixture-backed runner (fixture data + invocation log). */
export function fixtureRunner() {
  return createRunner(fixtureRun)
}

/* ------------------------------------------------------------------ */
/* Fake web server + plugin harness.                                   */
/* ------------------------------------------------------------------ */

function createFakeWebServer() {
  /** @type {Array<{kind: string, path: string, handler: Function}>} */
  const routes = []
  return {
    routes,
    service: {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index !== -1) routes.splice(index, 1)
        }
      },
    },
  }
}

/**
 * Apply the plugin against a fake `webServer` and expose a request helper.
 *
 * @param {object} [options]
 * @param {object} [options.config] - extra/overriding plugin config.
 * @param {Function} [options.runner] - injected gh runner (default fixture).
 * @param {string} [options.statePath] - override the temp state file path.
 */
export function startApp(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ghp-test-'))
  const statePath = options.statePath ?? join(dir, 'state.json')
  const runner = options.runner ?? fixtureRunner()
  const fake = createFakeWebServer()
  const disposers = []
  const ctx = {
    get(name) {
      return name === 'webServer' ? fake.service : undefined
    },
    effect(callback) {
      const dispose = callback()
      disposers.push(dispose)
      return () => { if (typeof dispose === 'function') dispose() }
    },
  }
  apply(ctx, {
    statePath,
    healthCacheTtlMs: 0,
    ...options.config,
    run: runner,
  })
  const route = fake.routes[0]
  const request = (requestOptions) => invokeHandler(route.handler, requestOptions)
  return {
    dir,
    statePath,
    runner,
    calls: runner.calls ?? [],
    commands: () => (typeof runner.commands === 'function' ? runner.commands() : runner.calls.map(args => args.join(' '))),
    routes: fake.routes,
    service: fake.service,
    request,
    get(pathname, headers = {}) {
      return request({ method: 'GET', url: `${APP_PREFIX}${pathname}`, headers })
    },
    post(pathname, payload, extra = {}) {
      return request({
        method: 'POST',
        url: `${APP_PREFIX}${pathname}`,
        headers: { 'content-type': 'application/json', ...extra.headers },
        body: extra.raw !== undefined ? extra.raw : JSON.stringify(payload),
      })
    },
    readState() {
      return JSON.parse(readFileSync(this.statePath, 'utf8'))
    },
    dispose() {
      for (const dispose of disposers) {
        try { if (typeof dispose === 'function') dispose() } catch { /* idempotent */ }
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/* ------------------------------------------------------------------ */
/* Raw node:http request/response fakes.                               */
/* ------------------------------------------------------------------ */

/**
 * Invoke one plugin handler against a real `Readable` request and a capturing
 * response. The handler owns writeHead/end, exactly like under `node:http`.
 */
export function invokeHandler(handler, options = {}) {
  const { method = 'GET', url = '/', headers = {}, body } = options
  const chunks = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(String(body))]
  const req = Readable.from(chunks)
  req.method = method
  req.url = url
  req.headers = { ...headers }

  return new Promise((resolve) => {
    const captured = {
      statusCode: 0,
      headers: {},
      body: '',
      headersSent: false,
      destroyed: false,
    }
    const res = {
      statusCode: 200,
      headersSent: false,
      setHeader(name, value) {
        captured.headers[String(name).toLowerCase()] = value
      },
      getHeader(name) {
        return captured.headers[String(name).toLowerCase()]
      },
      writeHead(status, responseHeaders) {
        captured.statusCode = status
        captured.headersSent = true
        this.statusCode = status
        this.headersSent = true
        if (responseHeaders !== undefined && responseHeaders !== null) {
          for (const [name, value] of Object.entries(responseHeaders)) {
            captured.headers[String(name).toLowerCase()] = value
          }
        }
      },
      end(chunk) {
        if (chunk !== undefined && chunk !== null) {
          captured.body += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        }
        captured.done = true
        resolve(captured)
      },
      destroy() {
        captured.destroyed = true
        captured.done = true
        resolve(captured)
      },
    }
    let result
    try {
      result = handler(req, res)
    } catch (error) {
      captured.done = true
      captured.threw = error
      resolve(captured)
      return
    }
    if (result !== undefined && result !== null && typeof result.then === 'function') {
      result.catch((error) => { captured.threw = error })
    }
  })
}

/* ------------------------------------------------------------------ */
/* Assertions over captured responses.                                 */
/* ------------------------------------------------------------------ */

export function parseJson(response) {
  if (response.body === '') throw new Error('response body is empty')
  return JSON.parse(response.body)
}

/** Assert one successful JSON response and return its parsed body. */
export function expectJson(response, status = 200) {
  if (response.statusCode !== status) {
    throw new Error(`expected status ${String(status)}, got ${String(response.statusCode)} (body: ${response.body})`)
  }
  const headers = response.headers
  if (headers['content-type'] !== 'application/json; charset=utf-8') {
    throw new Error(`unexpected content-type: ${String(headers['content-type'])}`)
  }
  if (headers['cache-control'] !== 'no-store') {
    throw new Error(`unexpected cache-control: ${String(headers['cache-control'])}`)
  }
  return parseJson(response)
}

/** Assert one error envelope; return its `error` object. */
export function expectErrorJson(response, status, code) {
  const body = expectJson(response, status)
  if (typeof body?.error !== 'object' || body.error === null) {
    throw new Error(`missing error envelope: ${response.body}`)
  }
  if (typeof body.error.code !== 'string' || typeof body.error.message !== 'string') {
    throw new Error(`malformed error envelope: ${response.body}`)
  }
  if (code !== undefined && body.error.code !== code) {
    throw new Error(`expected error code ${code}, got ${body.error.code} (${body.error.message})`)
  }
  return body.error
}
