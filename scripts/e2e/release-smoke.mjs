#!/usr/bin/env node
// Release smoke: install the *published* plugin from the npm registry into a
// throw-away DSH profile, boot `dsh web` from that profile, verify the plugin
// HTTP route + the two conversation tabs, and capture the release screenshot.
//
// This is the post-publish gate (see RELEASING.md): unlike scripts/e2e/run.mjs it
// uses NO `--patch` overlay — the plugin must come from the profile's installed
// package (`dsh plugin --profile <p> add <spec>` → `dsh.profile.bundles`).
//
// Usage:
//   node scripts/e2e/release-smoke.mjs
//   node scripts/e2e/release-smoke.mjs --spec=@ceasarxuu/dsh-github-projects@1.0.0
//   node scripts/e2e/release-smoke.mjs --spec=/abs/pkg.tgz --skip-install --home=/tmp/existing-home
//
// Output: JSON lines `{step, ok, detail}` then PASS/FAIL; exit 0 only when the
// install, profile composition, `/health`, tabs and console checks all pass.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { DSH_CLI, isolatedEnv, runTimestamp, startDshWeb, waitForHttpReady } from './lib/dsh.mjs'
import { launchChrome, waitForDevToolsPort, connectPageTarget } from './lib/browser.mjs'
import { startMockLlm } from './lib/mock-llm.mjs'
import {
  clickTab, collectUi, prepareConversationUi, sendComposerMessage, settle, tabLabels, waitForAppShell,
} from './lib/app.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCREENSHOT = join(REPO_ROOT, 'artifacts', 'screenshots', '15-published-install.png')
const DEFAULT_SPEC = '@ceasarxuu/dsh-github-projects@1.0.0'

function parseArgs(argv) {
  const options = {
    spec: DEFAULT_SPEC,
    expectedVersion: '1.0.0',
    profile: 'web',
    home: null,
    skipInstall: false,
    keep: false,
    screenshot: SCREENSHOT,
  }
  for (const arg of argv) {
    if (arg === '--keep') options.keep = true
    else if (arg === '--skip-install') options.skipInstall = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg.startsWith('--spec=')) options.spec = arg.slice('--spec='.length)
    else if (arg.startsWith('--expected-version=')) options.expectedVersion = arg.slice('--expected-version='.length)
    else if (arg.startsWith('--profile=')) options.profile = arg.slice('--profile='.length)
    else if (arg.startsWith('--home=')) options.home = arg.slice('--home='.length)
    else if (arg.startsWith('--screenshot=')) options.screenshot = arg.slice('--screenshot='.length)
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

const HELP = `release-smoke — post-publish install + boot smoke for dsh-github-projects

  node scripts/e2e/release-smoke.mjs [options]

Options:
  --spec=<pkg@version|tarball>  plugin spec for \`dsh plugin add\` (default ${DEFAULT_SPEC})
  --expected-version=<v>        version expected in the profile (default 1.0.0)
  --profile=<name>              DSH profile to install into (default web)
  --home=<dir>                  reuse an existing temp DSH_HOME (skip creating one)
  --skip-install                do not run \`dsh plugin add\` (profile must exist)
  --screenshot=<path>           screenshot destination (default artifacts/screenshots/15-published-install.png)
  --keep                        keep the temp run directory (always kept on failure)
`

function emit(step, ok, detail) {
  process.stdout.write(`${JSON.stringify({ step, ok, detail })}\n`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function tail(text, length = 4000) {
  const value = String(text ?? '')
  return value.length <= length ? value : `…${value.slice(-length)}`
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    process.stdout.write(HELP)
    process.exit(0)
  }
  mkdirSync(join(REPO_ROOT, 'artifacts', 'screenshots'), { recursive: true })

  const runRoot = options.home === null
    ? join('/tmp/dsh-github-projects-release-smoke', runTimestamp())
    : join(options.home, '..', `release-smoke-${runTimestamp()}`)
  const home = options.home === null ? join(runRoot, 'home') : resolve(options.home)
  const workspace = join(runRoot, 'workspace')
  const logs = join(runRoot, 'logs')
  for (const dir of [workspace, logs]) mkdirSync(dir, { recursive: true })
  if (options.home === null) mkdirSync(home, { recursive: true })
  const runLog = name => join(logs, name)

  const resources = { cdp: null, chrome: null, dsh: null, llm: null }
  const failures = []
  const steps = []

  async function step(name, fn) {
    const started = Date.now()
    try {
      const detail = (await fn()) ?? {}
      steps.push(name)
      emit(name, true, { ...detail, ms: Date.now() - started })
      return true
    } catch (error) {
      failures.push({ step: name, error: String(error?.message ?? error) })
      const detail = { error: String(error?.message ?? error) }
      if (resources.dsh !== null) detail.dshLogTail = tail(resources.dsh.output, 2500)
      emit(name, false, { ...detail, ms: Date.now() - started })
      return false
    }
  }

  try {
    // 1) install from the registry into the temp profile
    if (options.skipInstall) {
      emit('install', true, { skipped: true, home, profile: options.profile })
    } else if (!(await step('install', async () => {
      const result = spawnSync(DSH_CLI, ['plugin', '--profile', options.profile, 'add', options.spec], {
        cwd: workspace,
        env: isolatedEnv(home),
        encoding: 'utf8',
        timeout: 180_000,
      })
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
      assert(result.status === 0, `dsh plugin add exited ${result.status}: ${tail(output)}`)
      assert(
        output.includes(`@ceasarxuu/dsh-github-projects ${options.expectedVersion}`)
        || output.includes(options.spec),
        `install output does not mention the package/version: ${tail(output)}`,
      )
      return { spec: options.spec, tail: tail(output, 1200) }
    }))) throw new Error('install failed')

    // 2) profile composition: dsh.profile.bundles must list the package
    if (!(await step('profile', async () => {
      const profilePackage = join(home, 'profiles', options.profile, 'package.json')
      assert(existsSync(profilePackage), `profile package.json not found: ${profilePackage}`)
      const manifest = JSON.parse(readFileSync(profilePackage, 'utf8'))
      const bundles = manifest?.dsh?.profile?.bundles ?? []
      assert(bundles.includes('@ceasarxuu/dsh-github-projects'), `dsh.profile.bundles does not contain the plugin: ${JSON.stringify(bundles)}`)
      const dependency = manifest?.dependencies?.['@ceasarxuu/dsh-github-projects']
      assert(dependency !== undefined, 'profile package.json has no plugin dependency entry')
      if (options.spec.startsWith('@')) {
        assert(dependency.includes(options.expectedVersion) || dependency.includes('1.0.0'), `dependency does not pin the published version: ${dependency}`)
      }
      return { bundles, dependency, profile: options.profile }
    }))) throw new Error('profile composition check failed')

    // 3) boot `dsh web` from the installed profile (no overlay)
    if (!(await step('boot', async () => {
      resources.llm = await startMockLlm()
      resources.dsh = startDshWeb({
        root: runRoot,
        home,
        workspace,
        overlayPath: null,
        profile: options.profile,
        logPath: runLog('dsh.log'),
        env: {
          DEEPSEEK_API_KEY: 'sk-release-smoke',
          DEEPSEEK_BASE_URL: resources.llm.baseUrl,
        },
      })
      const url = await resources.dsh.waitForUrl(120_000)
      await waitForHttpReady(url, { timeoutMs: 30_000 })
      const origin = new URL(url).origin
      const health = await fetch(`${origin}/plugin/github-projects/health`, { signal: AbortSignal.timeout(15_000) })
        .then(async response => ({ status: response.status, body: await response.json().catch(() => null) }))
        .catch(error => ({ status: 0, error: String(error?.message ?? error) }))
      assert(health.status === 200, `published plugin /health did not answer 200: ${JSON.stringify(health)}`)
      assert(health.body?.ok === true, `published plugin /health body is not contract-shaped: ${JSON.stringify(health.body)}`)
      resources.origin = origin
      resources.url = url
      return {
        url: url.replace(/token=[^&]+/u, 'token=<redacted>'),
        health: health.body?.gh ?? null,
        profile: options.profile,
      }
    }))) throw new Error('boot from installed profile failed')

    // 4) browser: clean profile → session → header tabs → screenshot
    if (!(await step('tabs', async () => {
      resources.chrome = launchChrome({ root: runRoot, logPath: runLog('chrome.log') })
      const port = await waitForDevToolsPort(resources.chrome.userDataDir, 30_000)
      resources.cdp = await connectPageTarget(port)
      await resources.cdp.enable({ width: 1280, height: 800 })
      await resources.cdp.navigate(resources.url, { timeoutMs: 60_000 })
      await waitForAppShell(resources.cdp, { timeoutMs: 60_000 })
      await prepareConversationUi(resources.cdp, { timeoutMs: 45_000 })
      await sendComposerMessage(resources.cdp, 'release smoke', { timeoutMs: 45_000 })
      const labels = await tabLabels(resources.cdp)
      for (const required of ['对话', '轨迹', 'projects', 'issue']) {
        assert(labels.includes(required), `session header is missing the "${required}" tab in the clean published-install profile (tabs: ${JSON.stringify(labels)})`)
      }
      assert(await clickTab(resources.cdp, 'projects'), 'projects tab is not clickable in the clean profile')
      await settle(500)
      assert(await clickTab(resources.cdp, '对话'), 'could not return to the chat view for the screenshot')
      await settle(400)
      await resources.cdp.screenshot(options.screenshot)
      return { tabs: labels, screenshot: options.screenshot }
    }))) throw new Error('tabs/screenshot check failed')

    // 5) browser console / network checks
    if (!(await step('console', async () => {
      const { consoleErrors, consoleWarnings, exceptions } = resources.cdp.errors()
      const unexpected = [...consoleErrors, ...exceptions].filter(entry => !/X-Frame-Options|Refused to display/u.test(entry.text))
      assert(unexpected.length === 0, `clean-profile browser reported errors: ${JSON.stringify(unexpected.slice(0, 5))}`)
      const pluginHttpErrors = resources.cdp.httpErrors.filter(entry => entry.url.includes('/plugin/github-projects'))
      assert(pluginHttpErrors.length === 0, `plugin HTTP errors: ${JSON.stringify(pluginHttpErrors.slice(0, 5))}`)
      return { consoleErrors: consoleErrors.length, exceptions: exceptions.length, warnings: consoleWarnings.length }
    }))) throw new Error('console check failed')
  } finally {
    try { resources.cdp?.close() } catch { /* ignore */ }
    try { await resources.chrome?.stop() } catch { /* ignore */ }
    try { await resources.dsh?.stop() } catch { /* ignore */ }
    try { await resources.llm?.close() } catch { /* ignore */ }
  }

  const keep = options.keep || failures.length > 0
  if (!keep && options.home === null) {
    try { rmSync(runRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  const detail = {
    spec: options.spec,
    expectedVersion: options.expectedVersion,
    profile: options.profile,
    home,
    runDir: keep ? runRoot : null,
    screenshot: options.screenshot,
    steps,
    failures,
  }
  emit('result', failures.length === 0, detail)
  process.stdout.write(failures.length === 0 ? 'PASS\n' : 'FAIL\n')
  process.exit(failures.length === 0 ? 0 : 1)
}

await main()
