// Headless Chrome lifecycle for the e2e harness.
//
// Chrome is started with a throw-away `--user-data-dir` and
// `--remote-debugging-port=0`; the actual debugging port is read from
// `<user-data-dir>/DevToolsActivePort`. Only the first `page` target is used.

import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { CdpClient } from './cdp.mjs'

export const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/**
 * @param {{root: string, headful?: boolean, logPath: string}} options
 */
export function launchChrome({ root, headful = false, logPath }) {
  const userDataDir = join(root, 'chrome-profile')
  rmSync(userDataDir, { recursive: true, force: true })

  const args = [
    headful ? '--headless=old' : '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--metrics-recording-only',
    '--no-service-autorun',
    '--password-store=basic',
    '--use-mock-keychain',
    '--mute-audio',
    '--hide-scrollbars',
    '--window-size=1280,800',
    'about:blank',
  ]
  if (headful) args.splice(0, 1)

  const log = createWriteStream(logPath, { flags: 'w' })
  const child = spawn(CHROME_BIN, args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.pipe(log)
  child.stderr.pipe(log)
  child.unref?.()

  let exitCode = null
  child.on('exit', (code, signal) => { exitCode = code ?? signal ?? 'unknown' })

  return {
    child,
    userDataDir,
    get exitCode() { return exitCode },
    async stop() {
      if (exitCode !== null) return
      try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch { /* gone */ } }
      for (let i = 0; i < 40; i++) {
        if (exitCode !== null) break
        await sleep(100)
      }
      if (exitCode === null) {
        try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* gone */ } }
        await sleep(200)
      }
      log.end()
      rmSync(userDataDir, { recursive: true, force: true })
    },
    logPath,
  }
}

/**
 * Wait for `DevToolsActivePort` and return the debugging port.
 * @param {string} userDataDir
 * @param {number} timeoutMs
 */
export async function waitForDevToolsPort(userDataDir, timeoutMs = 30_000) {
  const file = join(userDataDir, 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      try {
        const [portLine] = readFileSync(file, 'utf8').split('\n')
        const port = Number(portLine)
        if (Number.isInteger(port) && port > 0) return port
      } catch (error) {
        lastError = error
      }
    }
    await sleep(100)
  }
  throw new Error(`Chrome did not expose a debugging port within ${timeoutMs}ms (${file})${lastError === null ? '' : `: ${lastError.message}`}`)
}

/**
 * Find the first page target and attach a CDP client to it.
 * @param {number} port
 * @returns {Promise<CdpClient>}
 */
export async function connectPageTarget(port, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let targets = []
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      targets = await response.json()
      const page = targets.find(target => target.type === 'page')
      if (page !== undefined && typeof page.webSocketDebuggerUrl === 'string') {
        return await CdpClient.connect(page.webSocketDebuggerUrl)
      }
    } catch {
      /* chrome http endpoint not ready yet */
    }
    await sleep(150)
  }
  throw new Error(`no page target on the Chrome debugging endpoint (port ${port}); targets=${JSON.stringify(targets.map(t => t.type))}`)
}
