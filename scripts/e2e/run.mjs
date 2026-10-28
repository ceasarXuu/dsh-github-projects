#!/usr/bin/env node
// dsh-github-projects — isolated end-to-end verification harness.
//
// One command boots a throw-away `dsh web` (temp DSH_HOME, temp profile, temp
// first-use workspace), loads the plugin through a `--patch` overlay (fixture
// mock host or the real host), drives headless Chrome over CDP through the real
// UI, and captures the acceptance screenshots under artifacts/screenshots/.
//
// Usage:
//   node scripts/e2e/run.mjs [--mode fixture|real] [--keep] [--only=<stage>] [--headful]
//
// Output: one JSON line per stage `{step, ok, detail}`, then `PASS` or `FAIL`.
// Exit code 0 only when every executed stage passed.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  createRunRoot, runTimestamp, startDshWeb, waitForHttpReady, writeOverlay,
} from './lib/dsh.mjs'
import { launchChrome, waitForDevToolsPort, connectPageTarget } from './lib/browser.mjs'
import { startMockLlm } from './lib/mock-llm.mjs'
import {
  clickButton, clickTab, collectUi, prepareConversationUi, sendComposerMessage, settle, tabLabels,
  visibleButtonLabels, waitForAppShell, waitForText,
} from './lib/app.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCREENSHOT_DIR = join(REPO_ROOT, 'artifacts', 'screenshots')

/** Stages in execution order. `--only=<name>` stops after that stage. */
const STAGES = [
  'boot',
  'app',
  'session',
  'tabs',
  'projects-empty',
  'projects-picker',
  'projects-board',
  'projects-browser',
  'projects-list',
  'projects-milestone',
  'projects-wide',
  'issue-empty',
  'issue-bind-subtitle',
  'issue-detail',
  'issue-comments',
  'sidebar-subtitle',
  'projects-warm',
  'console',
]

/**
 * Browser console errors that are known-benign in this isolated environment.
 * Keep this list empty unless a real, explained false positive shows up; every
 * entry must be documented in scripts/e2e/README.md.
 * @type {{pattern: RegExp, why: string}[]}
 */
const BENIGN_CONSOLE_ERRORS = [
  {
    pattern: /Refused to display[^\n]*github\.com|X-Frame-Options[^\n]*(?:deny|DENY)/iu,
    why: 'github.com serves X-Frame-Options: DENY. The Web build renders DSH\'s built-in browser tab as an iframe, so the remote page body is refused; the harness still asserts the browser tab, its address bar and the iframe src (the Desktop build uses an Electron webview and renders the page natively).',
  },
]

const MODES = {
  fixture: {
    pluginEntry: join(REPO_ROOT, 'dev', 'mock-host.js'),
    description: 'contract mock host (test/fixtures, in-memory bindings, no gh)',
  },
  real: {
    pluginEntry: join(REPO_ROOT, 'index.js'),
    description: 'real host (index.js + github.js) against the local gh CLI, read-only',
  },
}

function parseArgs(argv) {
  const options = { mode: 'fixture', keep: false, only: null, headful: false, timeoutScale: 1, extraComments: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const valueOf = (name) => {
      if (arg === name) {
        const next = argv[index + 1]
        if (next === undefined || next.startsWith('--')) throw new Error(`${name} needs a value`)
        index += 1
        return next
      }
      return arg.slice(name.length + 1)
    }
    if (arg === '--keep') options.keep = true
    else if (arg === '--headful') options.headful = true
    else if (arg === '--extra-comments') options.extraComments = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--mode' || arg.startsWith('--mode=')) options.mode = valueOf('--mode')
    else if (arg === '--only' || arg.startsWith('--only=')) options.only = valueOf('--only')
    else if (arg === '--timeout-scale' || arg.startsWith('--timeout-scale=')) options.timeoutScale = Number(valueOf('--timeout-scale'))
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!Object.hasOwn(MODES, options.mode)) throw new Error(`unknown --mode ${options.mode} (expected fixture|real)`)
  if (options.only !== null && !STAGES.includes(options.only)) {
    throw new Error(`unknown --only stage ${options.only} (expected one of: ${STAGES.join(', ')})`)
  }
  if (!Number.isFinite(options.timeoutScale) || options.timeoutScale <= 0) throw new Error('--timeout-scale must be a positive number')
  return options
}

const HELP = `dsh-github-projects e2e harness

  node scripts/e2e/run.mjs [options]

Options:
  --mode=fixture|real   plugin host under test (default: fixture)
  --keep                keep the temp run directory (home, workspace, logs)
  --only=<stage>        stop after this stage: ${STAGES.join(', ')}
  --headful             run Chrome with a visible window (debugging)
  --extra-comments      also capture the opt-in 09-issue-comments.png shot
  --timeout-scale=<n>   multiply all stage timeouts (default: 1)
  -h, --help            show this help

Artifacts: artifacts/screenshots/*.png (01–09, 11-projects-wide, 12-browser-open, 13-issue-subtitle, 14-sidebar-subtitle)
Temp root: /tmp/dsh-github-projects-e2e/<timestamp>/
`

/** Print one machine-readable step line. */
function emit(step, ok, detail) {
  process.stdout.write(`${JSON.stringify({ step, ok, detail })}\n`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** Shorten long strings for JSON-line details. */
const clip = (value, length = 600) => {
  const text = String(value ?? '')
  return text.length <= length ? text : `${text.slice(0, length)}…`
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    process.exit(2)
  }
  if (options.help === true) {
    process.stdout.write(HELP)
    process.exit(0)
  }

  const mode = MODES[options.mode]
  const runId = runTimestamp()
  const root = createRunRoot({ name: runId })
  const runLog = (name) => join(root.logs, name)
  const scale = options.timeoutScale
  const emitTimeout = ms => Math.round(ms * scale)

  mkdirSync(SCREENSHOT_DIR, { recursive: true })
  // Keep the acceptance artifact set deterministic. The harness owns the
  // numbered state shots; 10-desktop-tabs.png is manual Desktop-install
  // evidence (Lead) and is never written or removed by this harness.
  const EXPECTED_SHOTS = new Set([
    '01-tabs.png', '02-projects-empty.png', '03-projects-picker.png',
    '04-projects-board.png', '05-projects-list.png', '06-projects-milestone.png',
    '07-issue-empty.png', '08-issue-detail.png', '09-issue-comments.png',
    '10-desktop-tabs.png', '11-projects-wide.png', '12-browser-open.png',
    '13-issue-subtitle.png', '14-sidebar-subtitle.png',
    // 15 is produced by scripts/e2e/release-smoke.mjs (published-install gate),
    // never by this harness — preserve it as release evidence.
    '15-published-install.png',
  ])
  const DERIVED_SHOTS = new Set(['09-issue-comments.png', '11-projects-wide.png', '12-browser-open.png', '13-issue-subtitle.png', '14-sidebar-subtitle.png'])
  for (const name of readdirSync(SCREENSHOT_DIR)) {
    const numberedStateShot = /^\d\d-.*\.png$/u.test(name) && !EXPECTED_SHOTS.has(name)
    if (name.startsWith('failure-') || numberedStateShot || DERIVED_SHOTS.has(name)) {
      try { rmSync(join(SCREENSHOT_DIR, name), { force: true }) } catch { /* ignore */ }
    }
  }

  /** @type {{cdp: import('./lib/cdp.mjs').CdpClient|null, chrome: any, dsh: any, llm: any}} */
  const resources = { cdp: null, chrome: null, dsh: null, llm: null }
  const screenshots = {}
  const failures = []
  let lastStep = null

  const shot = async (name) => {
    const file = join(SCREENSHOT_DIR, name)
    await resources.cdp.screenshot(file)
    screenshots[name] = file
    return file
  }

  /** Wait for a plugin-DOM condition (ghp-* classes are the client's contract). */
  const waitForPlugin = (expression, label, timeoutMs = 30_000) =>
    resources.cdp.waitFor(expression, { timeoutMs: emitTimeout(timeoutMs), label })

  /** Save a full UI snapshot + process log tails on failure. */
  async function failureDiagnostics(stepName, error) {
    const detail = { error: clip(error?.message ?? error, 2000) }
    if (resources.cdp !== null) {
      try {
        const ui = await collectUi(resources.cdp)
        const dumpPath = runLog(`failure-${stepName}-ui.json`)
        writeFileSync(dumpPath, JSON.stringify(ui, null, 2), 'utf8')
        detail.uiDump = dumpPath
        detail.tabs = ui.tabs.map(tab => `${tab.label}${tab.selected ? '*' : ''}`)
        detail.activeTab = ui.activeTab
        detail.bodyText = clip(ui.bodyText, 1200)
        detail.dialogs = ui.dialogs
        detail.lastButtons = ui.buttons.slice(-25).map(button => button.aria || button.text)
        try {
          const file = join(SCREENSHOT_DIR, `failure-${stepName}.png`)
          await resources.cdp.screenshot(file)
          detail.screenshot = file
        } catch { /* page may be gone */ }
        const errors = resources.cdp.errors()
        detail.console = { errors: errors.consoleErrors.slice(0, 10), exceptions: errors.exceptions.slice(0, 10) }
      } catch (diagnosticsError) {
        detail.diagnosticsError = clip(diagnosticsError?.message ?? diagnosticsError, 500)
      }
    }
    if (resources.dsh !== null) {
      detail.dshLog = resources.dsh.logPath
      detail.dshLogTail = clip(tailText(resources.dsh.output, 2500), 2500)
    }
    if (resources.chrome !== null) detail.chromeLog = resources.chrome.logPath
    detail.runDir = root.root
    return detail
  }

  /** `--only=<stage>` runs every prerequisite plus that stage, then stops. */
  const gated = (name) => options.only === null || STAGES.indexOf(name) <= STAGES.indexOf(options.only)

  async function runStage(name, fn) {
    lastStep = name
    const started = Date.now()
    try {
      const detail = (await fn()) ?? {}
      emit(name, true, { ...detail, ms: Date.now() - started })
      return true
    } catch (error) {
      const detail = await failureDiagnostics(name, error)
      failures.push({ step: name, error: detail.error })
      emit(name, false, { ...detail, ms: Date.now() - started })
      return false
    }
  }

  try {
    // ---------------------------------------------------------------- boot --
    if (gated('boot')) {
      const bootOk = await runStage('boot', async () => {
        assert(existsSync(mode.pluginEntry), `plugin entry not found: ${mode.pluginEntry} (is the ${options.mode} half implemented?)`)
        assert(existsSync(join(REPO_ROOT, 'client.js')), `client half not found: ${join(REPO_ROOT, 'client.js')}`)

        const overlayPath = writeOverlay({ root: root.root, pluginEntry: mode.pluginEntry, documentsDirectory: root.documents })
        // The mock model keeps the harness offline and gives the fresh session a
        // real (non-blank) conversation, which is what makes the header show the
        // conversation view tabs.
        resources.llm = await startMockLlm()
        resources.dsh = startDshWeb({
          ...root,
          overlayPath,
          logPath: runLog('dsh.log'),
          env: {
            DEEPSEEK_API_KEY: 'sk-e2e-mock',
            DEEPSEEK_BASE_URL: resources.llm.baseUrl,
          },
        })
        const url = await resources.dsh.waitForUrl(emitTimeout(90_000))
        await waitForHttpReady(url, { timeoutMs: emitTimeout(30_000) })
        const origin = new URL(url).origin

        resources.chrome = launchChrome({ root: root.root, headful: options.headful, logPath: runLog('chrome.log') })
        const port = await waitForDevToolsPort(resources.chrome.userDataDir, emitTimeout(30_000))
        resources.cdp = await connectPageTarget(port)
        await resources.cdp.enable({ width: 1280, height: 800 })
        // v0.4.0 host contract: record every plugin API response (status + JSON)
        // so the console stage can assert `stale` booleans and log host timings.
        await resources.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PLUGIN_FETCH_INSTRUMENTATION })

        // First navigation: a reload retry covers a slow first paint of the SPA.
        let booted = false
        let lastError = null
        for (let attempt = 1; attempt <= 2 && !booted; attempt++) {
          try {
            await resources.cdp.navigate(url, { timeoutMs: emitTimeout(60_000) })
            await waitForAppShell(resources.cdp, { timeoutMs: emitTimeout(60_000) })
            booted = true
          } catch (error) {
            lastError = error
            await sleep(1000)
          }
        }
        assert(booted, `web app did not boot after 2 navigations: ${lastError?.message ?? 'unknown'}`)

        // Plugin API smoke check (unauthenticated loopback route).
        const health = await fetch(`${origin}/plugin/github-projects/health`, { signal: AbortSignal.timeout(emitTimeout(10_000)) })
          .then(async response => ({ status: response.status, body: await response.json().catch(() => null) }))
          .catch(error => ({ status: 0, error: String(error?.message ?? error) }))
        assert(health.status === 200, `plugin host /health did not answer: ${JSON.stringify(health)}`)
        assert(health.body?.ok === true, `plugin host /health body is not the contract shape: ${JSON.stringify(health.body)}`)
        if (options.mode === 'real') {
          assert(health.body?.gh?.available === true, `real host has no usable gh CLI: ${JSON.stringify(health.body?.gh ?? health)}`)
        }
        return {
          mode: options.mode,
          host: mode.description,
          runDir: root.root,
          url: url.replace(/token=[^&]+/u, 'token=<redacted>'),
          gh: health.body?.gh ?? null,
        }
      })
      if (bootOk === false) throw new Error('boot failed')
    }

    // ----------------------------------------------------------------- app --
    if (gated('app')) {
      const appOk = await runStage('app', async () => {
        const dismissed = await prepareConversationUi(resources.cdp, { timeoutMs: emitTimeout(45_000) })
        const labels = await visibleButtonLabels(resources.cdp)
        return { dismissed, ready: labels.some(entry => entry.aria === '新建会话') }
      })
      if (appOk === false) throw new Error('app stage failed')
    }

    // ------------------------------------------------------------- session --
    if (gated('session')) {
      const sessionOk = await runStage('session', async () => {
        await sendComposerMessage(resources.cdp, 'hello from the e2e harness', { timeoutMs: emitTimeout(45_000) })
        await waitForText(resources.cdp, 'mock assistant reply', { timeoutMs: emitTimeout(30_000), label: 'mock assistant reply' })
        const tabs = await tabLabels(resources.cdp)
        return { tabs, conversationStarted: true }
      })
      if (sessionOk === false) throw new Error('session stage failed')
    }

    // --------------------------------------------------------------- tabs --
    if (gated('tabs')) {
      const tabsOk = await runStage('tabs', async () => {
        const labels = await tabLabels(resources.cdp)
        for (const required of ['对话', '轨迹', 'projects', 'issue']) {
          assert(labels.includes(required), `session header is missing the "${required}" tab (tabs: ${JSON.stringify(labels)})`)
        }
        const screenshot = await shot('01-tabs.png')
        return { tabs: labels, screenshot }
      })
      if (tabsOk === false) throw new Error('tabs stage failed')
    }

    // ----------------------------------------------------- projects empty --
    if (gated('projects-empty')) {
      const projectsEmptyOk = await runStage('projects-empty', async () => {
        assert(await clickTab(resources.cdp, 'projects'), 'could not click the "projects" tab')
        await waitForText(resources.cdp, '绑定 GitHub Project', { timeoutMs: emitTimeout(30_000) })
        await waitForText(resources.cdp, '选择 Project', { timeoutMs: emitTimeout(15_000) })
        await settle(300)
        const screenshot = await shot('02-projects-empty.png')
        return { screenshot }
      })
      if (projectsEmptyOk === false) throw new Error('projects-empty stage failed')
    }

    // ---------------------------------------------------- projects picker --
    if (gated('projects-picker')) {
      const pickerOk = await runStage('projects-picker', async () => {
        assert(await clickButton(resources.cdp, { text: '选择 Project' }), 'could not open the project picker ("选择 Project" button)')
        await waitForText(resources.cdp, 'Astropath-issues', { timeoutMs: emitTimeout(30_000) })
        await waitForPlugin(`document.querySelectorAll('[class*="ghp-picker-row"]').length >= 1`, 'picker rows rendered')
        await waitForPlugin(`!document.querySelector('[class*="ghp-picker-loading"]')`, 'picker loading finished')
        await settle(400)
        const screenshot = await shot('03-projects-picker.png')
        return { screenshot }
      })
      if (pickerOk === false) throw new Error('projects-picker stage failed')
    }

    // ----------------------------------------------------- projects board --
    let coldBoardMs = null
    if (gated('projects-board')) {
      const projectsBoardOk = await runStage('projects-board', async () => {
        const boardStarted = Date.now()
        const clicked = await clickTextRow(resources.cdp, 'Astropath-issues')
        assert(clicked, 'could not select the "Astropath-issues" row in the picker')
        // Bound toolbar: project title, item count, view-mode toggle and filter.
        await waitForText(resources.cdp, 'Astropath-issues', { timeoutMs: emitTimeout(30_000) })
        await waitForText(resources.cdp, '解绑', { timeoutMs: emitTimeout(20_000) })
        await waitForText(resources.cdp, '刷新', { timeoutMs: emitTimeout(20_000) })
        await waitForPlugin(`document.querySelectorAll('[class*="ghp-skeleton"]').length === 0`, 'project board loading finished')
        const board = await waitForBoard(resources.cdp, emitTimeout(30_000))
        coldBoardMs = Date.now() - boardStarted
        // Before any bind, no session subtitle may exist (v0.4.0 baseline).
        assert(
          (await resources.cdp.evaluate(`document.querySelector('[data-ghp-session-subtitle]') === null`)),
          'session subtitle exists before any issue was bound',
        )
        // v0.3.0 hidden-lane rule: fixture data has a No-status item (5 lanes);
        // real Project #9 has none (4 lanes, data-ghp-hidden-lanes="no-status").
        const expectation = expectedLaneKeysForMode(options.mode, board.laneCheck.hidden)
        assert(expectation.ok, expectation.message)
        assert(
          JSON.stringify(board.laneCheck.laneKeys) === JSON.stringify(expectation.expected),
          `board lane keys ${JSON.stringify(board.laneCheck.laneKeys)} != expected ${JSON.stringify(expectation.expected)} for mode ${options.mode} (hidden: ${JSON.stringify(board.laneCheck.hidden)})`,
        )
        await settle(400)
        const screenshot = await shot('04-projects-board.png')
        return {
          screenshot,
          mode: board.mode,
          hiddenLanes: board.laneCheck.hidden,
          laneKeys: board.laneCheck.laneKeys,
          columns: board.columns,
          cardCount: board.cardCount,
          coldBoardMs,
        }
      })
      if (projectsBoardOk === false) throw new Error('projects-board stage failed')
    }

    // --------------------------------------------------- projects browser --
    // v0.4.0: clicking the card BODY opens DSH's built-in right sidebar browser
    // and must NOT bind — binding is only the explicit bind action.
    if (gated('projects-browser')) {
      const projectsBrowserOk = await runStage('projects-browser', async () => {
        await waitForBoard(resources.cdp, emitTimeout(20_000))
        const issueRef = 'ceasarXuu/Astropath#240'
        const bindActionPresent = await cardHasAction(resources.cdp, issueRef, 'bind')
        assert(bindActionPresent, `card ${issueRef} has no explicit [data-ghp-card-action="bind"] button`)
        const clicked = await clickCardAction(resources.cdp, issueRef, 'open')
        assert(clicked, `could not click [data-ghp-card-action="open"] on card ${issueRef}`)
        const browser = await waitForSidebarBrowser(resources.cdp, emitTimeout(20_000), issueRef)
        assert(browser.dockkitTabs.length >= 1, 'built-in browser tab is missing from the right sidebar ([data-dockkit-tab])')
        assert(
          browser.addressValue !== null && browser.addressValue.includes('github.com/ceasarXuu/Astropath/issues/240'),
          `built-in browser address bar does not show the issue URL (address: ${JSON.stringify(browser.addressValue)})`,
        )
        // Opening the browser must not create a binding or switch views.
        assert(
          (await resources.cdp.evaluate(`document.querySelector('[data-ghp-session-subtitle]') === null`)),
          'opening the card body created a binding (session subtitle appeared)',
        )
        // Opening the right-sidebar browser narrows the conversation column; the
        // shipped view-tab row then clamps extra tabs into the "更多会话视图" menu,
        // so a visible selected tab may be absent. Assert the projects board is
        // still the mounted view (and the issue view did not open) instead.
        const viewState = await resources.cdp.evaluate(`(() => {
          const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
          const modeRoot = [...document.querySelectorAll('[data-ghp-view-mode]')].find(vis)
          const board = [...document.querySelectorAll('[data-ghp-board]')].find(vis)
          const issueHead = [...document.querySelectorAll('[class*="ghp-issue-head"]')].find(vis)
          const active = [...document.querySelectorAll('button[role="tab"][aria-selected="true"]')].find(vis)
          const more = [...document.querySelectorAll('button,[role="button"]')]
            .find(el => (el.getAttribute('aria-label') || '').includes('更多会话视图'))
          return {
            mode: modeRoot === undefined ? null : modeRoot.getAttribute('data-ghp-view-mode'),
            board: board !== undefined,
            issueHead: issueHead !== undefined,
            activeTab: active === undefined ? null : (active.innerText || '').trim(),
            tabsClamped: more !== undefined,
          }
        })()`)
        assert(viewState.board && viewState.mode === 'board', `card body open must not switch away from the projects board (state: ${JSON.stringify(viewState)})`)
        assert(!viewState.issueHead, 'card body open bound the issue and opened the issue view (it must only open the browser)')
        if (viewState.activeTab !== null) {
          assert(viewState.activeTab === 'projects', `card body open must not switch views (active tab: ${JSON.stringify(viewState.activeTab)})`)
        }
        const activeTab = viewState.activeTab
        await settle(700)
        const screenshot = await shot('12-browser-open.png')
        const closed = await closeSidebarBrowser(resources.cdp, emitTimeout(15_000))
        assert(closed, 'could not close the built-in browser tab after 12-browser-open.png (dockkit tab context menu → 关闭)')
        const sidebarCollapsed = await collapseRightSidebar(resources.cdp)
        assert(sidebarCollapsed, 'right sidebar is still expanded after closing the built-in browser tab')
        await settle(300)
        return {
          screenshot,
          browserSrc: browser.src,
          browserTag: browser.tag,
          browserTabs: browser.dockkitTabs,
          browserAddress: browser.addressValue,
          activeTab,
          tabsClamped: viewState.tabsClamped,
          bindActionPresent,
          closed,
          sidebarCollapsed,
        }
      })
      if (projectsBrowserOk === false) throw new Error('projects-browser stage failed')
    }

    // ------------------------------------------------------ projects list --
    if (gated('projects-list')) {
      const projectsListOk = await runStage('projects-list', async () => {
        assert(await clickAction(resources.cdp, 'view-list'), 'could not click [data-ghp-action="view-list"]')
        await waitForPlugin(`document.querySelector('[data-ghp-view-mode="list"]') !== null`, 'list view mode', emitTimeout(20_000))
        await waitForPlugin(`document.querySelector('[data-ghp-list]') !== null`, 'list container', emitTimeout(20_000))
        await waitForPlugin(`document.querySelectorAll('[class*="ghp-skeleton"]').length === 0`, 'list view loading finished')
        const list = await resources.cdp.evaluate(LIST_SNAPSHOT)
        assert(list.rows >= 1 || list.groups >= 1, `list view has neither rows nor grouped sections (rows=${list.rows}, groups=${list.groups})`)
        assert(list.statusesInText.length >= 1, `list view shows no known status headers (text: ${JSON.stringify(list.statusesInText)})`)
        await settle(400)
        const screenshot = await shot('05-projects-list.png')
        return { screenshot, rows: list.rows, groups: list.groups, statusesInText: list.statusesInText }
      })
      if (projectsListOk === false) throw new Error('projects-list stage failed')
    }

    // ------------------------------------------------- projects milestone --
    if (gated('projects-milestone')) {
      const milestoneOk = await runStage('projects-milestone', async () => {
        // Back to board: the milestone screenshot is the filtered board with the
        // dropdown open.
        assert(await clickAction(resources.cdp, 'view-board'), 'could not click [data-ghp-action="view-board"]')
        await waitForPlugin(`document.querySelector('[data-ghp-view-mode="board"]') !== null`, 'board view mode', emitTimeout(20_000))
        const baseline = await waitForBoard(resources.cdp, emitTimeout(30_000))

        assert(await clickMilestoneToggle(resources.cdp), 'could not click [data-ghp-action="milestone"]')
        const options = await waitForMilestoneOptions(resources.cdp, emitTimeout(20_000))
        const values = options.map(option => option.value)
        for (const required of ['all', 'backlog']) {
          assert(values.includes(required), `milestone filter is missing the "${required}" option (options: ${JSON.stringify(values)})`)
        }
        const milestone = values.includes('v1.2.0')
          ? 'v1.2.0'
          : values.find(value => value !== 'all' && value !== 'backlog')
        assert(milestone !== undefined, `milestone filter has no concrete milestone option (options: ${JSON.stringify(values)})`)

        assert(await selectMilestoneOption(resources.cdp, milestone), `could not select milestone option "${milestone}"`)
        const filtered = await waitForBoard(resources.cdp, emitTimeout(30_000), { expectedLessThan: baseline.countSum })
        assert(filtered.countSum < baseline.countSum, `milestone "${milestone}" did not shrink the board (${baseline.countSum} → ${filtered.countSum})`)
        assert(filtered.countSum > 0, `milestone "${milestone}" filtered every card out`)
        // Column counters must add up to the cards actually rendered.
        assert(filtered.cardCount === filtered.countSum, `board counter mismatch after milestone filter: cards=${filtered.cardCount} counts=${filtered.countSum}`)

        // Capture with the dropdown open so the selected (data-active) option is visible.
        if (!(await isMilestoneDropdownOpen(resources.cdp))) {
          assert(await clickMilestoneToggle(resources.cdp), 'could not reopen the milestone dropdown')
        }
        const active = await waitForMilestoneActive(resources.cdp, milestone, emitTimeout(10_000))
        await settle(400)
        const screenshot = await shot('06-projects-milestone.png')

        // Reset to 全部 and leave the board in the unfiltered state for issue stages.
        assert(await selectMilestoneOption(resources.cdp, 'all'), 'could not reset the milestone filter to "all"')
        const reset = await waitForBoard(resources.cdp, emitTimeout(20_000))
        assert(reset.countSum === baseline.countSum, `board did not return to the full set after reset (${reset.countSum} != ${baseline.countSum})`)
        await closeMilestoneDropdown(resources.cdp)
        return {
          screenshot, milestones: values, selected: milestone, activeOption: active,
          baselineCards: baseline.countSum, filteredCards: filtered.countSum, resetCards: reset.countSum,
          columns: filtered.columns,
        }
      })
      if (milestoneOk === false) throw new Error('projects-milestone stage failed')
    }

    // ------------------------------------------------------ projects wide --
    // Wide-window regression (CONTRACT §4.2 "Layout width (v1.1.1)"): the page
    // must fill the conversation body with no max-width cap. The 1280×800 run
    // cannot show this — the old bug was nearly invisible there — so the stage
    // resizes to 2200×1300, measures, shoots, then restores the 1280×800 frame
    // for the issue stages.
    if (gated('projects-wide')) {
      const projectsWideOk = await runStage('projects-wide', async () => {
        // Baseline requirement: the right sidebar is collapsed (the wide page
        // fills the conversation body, not a reduced column).
        const sidebarCollapsed = await collapseRightSidebar(resources.cdp)
        assert(sidebarCollapsed, 'right sidebar is expanded before projects-wide; the conversation body must be full width')
        const WIDTH = 2200
        const HEIGHT = 1300
        await setViewport(resources.cdp, WIDTH, HEIGHT)
        // Wait for the ResizeObserver-driven reflow to settle (page width must be
        // stable across two consecutive samples, not still growing).
        const wide = await waitForWideLayout(resources.cdp, emitTimeout(20_000))
        assert(wide.innerWidth === WIDTH, `viewport did not resize (innerWidth=${wide.innerWidth}, expected ${WIDTH})`)
        assert(wide.hasBoard, 'bound board is not open during projects-wide ([data-ghp-board] missing)')
        const pagePct = (wide.pageWidth / wide.innerWidth) * 100
        const leftPct = (wide.pageLeft / wide.innerWidth) * 100
        assert(
          wide.pageWidth >= wide.innerWidth * 0.7,
          `projects page is cramped at ${WIDTH}px: .ghp-page width=${wide.pageWidth}px (${pagePct.toFixed(1)}% of window; old 1000px cap ≈ 45%). ` +
          'CONTRACT §4.2 Layout width (v1.1.1) requires width:100% with no max-width cap.',
        )
        assert(
          wide.pageLeft < wide.innerWidth * 0.25,
          `projects page is centred/fixed at ${WIDTH}px: .ghp-page left=${wide.pageLeft}px (${leftPct.toFixed(1)}% of window). ` +
          'No centred max-width column is allowed.',
        )
        // Hidden-lane rule applies at the wide viewport too.
        const wideBoard = await resources.cdp.evaluate(BOARD_SNAPSHOT)
        const laneCheck = laneRuleProblems(wideBoard)
        assert(laneCheck.problems.length === 0, `wide board violates the v0.3.0 lane rules: ${JSON.stringify(laneCheck.problems)}`)
        const expectation = expectedLaneKeysForMode(options.mode, laneCheck.hidden)
        assert(expectation.ok, expectation.message)
        assert(
          JSON.stringify(laneCheck.laneKeys) === JSON.stringify(expectation.expected),
          `wide board lane keys ${JSON.stringify(laneCheck.laneKeys)} != expected ${JSON.stringify(expectation.expected)} for mode ${options.mode} (hidden: ${JSON.stringify(laneCheck.hidden)})`,
        )
        assert(wide.laneKeys.length === laneCheck.laneKeys.length, `wide geometry lanes ${JSON.stringify(wide.laneKeys)} != snapshot lanes ${JSON.stringify(laneCheck.laneKeys)}`)
        assert(wide.cardCount >= 1, 'wide board renders no cards')
        assert(
          wide.laneWidthSum >= wide.boardWidth * 0.85,
          `wide board lanes do not share the board width: laneWidths=${JSON.stringify(wide.laneWidths)} sum=${wide.laneWidthSum} boardWidth=${wide.boardWidth}`,
        )
        const laneSpread = Math.max(...wide.laneWidths) - Math.min(...wide.laneWidths)
        assert(
          laneSpread <= 12,
          `wide board lanes are not equal-width (spread=${laneSpread}px, laneWidths=${JSON.stringify(wide.laneWidths)}) — CONTRACT requires flex:1 1 0`,
        )
        await settle(400)
        const screenshot = await shot('11-projects-wide.png')
        const size = pngDimensions(screenshot)
        assert(
          size.width === WIDTH && size.height === HEIGHT,
          `wide screenshot is ${size.width}x${size.height}, expected ${WIDTH}x${HEIGHT}`,
        )
        // Restore the standard frame before the issue stages (07–09).
        await setViewport(resources.cdp, 1280, 800)
        assert(
          (await resources.cdp.evaluate('window.innerWidth')) === 1280,
          'viewport was not restored to 1280x800 after projects-wide',
        )
        await settle(300)
        return {
          screenshot,
          screenshotSize: `${size.width}x${size.height}`,
          viewport: `${WIDTH}x${HEIGHT}`,
          pageWidth: wide.pageWidth,
          pageLeft: wide.pageLeft,
          pageWidthPct: Number(pagePct.toFixed(1)),
          pageLeftPct: Number(leftPct.toFixed(1)),
          boardWidth: wide.boardWidth,
          hiddenLanes: laneCheck.hidden,
          laneKeys: laneCheck.laneKeys,
          laneWidths: wide.laneWidths,
          laneWidthSum: wide.laneWidthSum,
          laneSpread,
          cardCount: wide.cardCount,
        }
      })
      if (projectsWideOk === false) throw new Error('projects-wide stage failed')
    }

    // -------------------------------------------------------- issue empty --
    if (gated('issue-empty')) {
      const issueEmptyOk = await runStage('issue-empty', async () => {
        assert(await clickTab(resources.cdp, 'issue'), 'could not click the "issue" tab')
        await waitForText(resources.cdp, '为当前会话绑定 Issue', { timeoutMs: emitTimeout(30_000) })
        await settle(300)
        const screenshot = await shot('07-issue-empty.png')
        return { screenshot }
      })
      if (issueEmptyOk === false) throw new Error('issue-empty stage failed')
    }

    // -------------------------------------------------- issue bind subtitle --
    // v0.4.0: the explicit bind action binds and switches to the issue view; the
    // session header then shows the issue subtitle row (§4.5).
    if (gated('issue-bind-subtitle')) {
      const bindSubtitleOk = await runStage('issue-bind-subtitle', async () => {
        assert(
          (await resources.cdp.evaluate(`document.querySelector('[data-ghp-session-subtitle]') === null`)),
          'session subtitle exists before the first bind',
        )
        assert(await clickTab(resources.cdp, 'projects'), 'could not go back to the "projects" tab')
        await waitForBoard(resources.cdp, emitTimeout(30_000))
        const issueRef = 'ceasarXuu/Astropath#240'
        const clicked = await clickCardAction(resources.cdp, issueRef, 'bind')
        assert(clicked, `could not click [data-ghp-card-action="bind"] on card ${issueRef}`)
        await settle(400)
        assert(
          (await resources.cdp.evaluate(`document.querySelector('[data-sidebar-browser-frame]') === null`)),
          'the explicit bind action opened the built-in browser (it must only bind)',
        )
        await waitForPlugin(`document.querySelector('[class*="ghp-issue-head"]') !== null`, 'issue detail header after bind', emitTimeout(30_000))
        const activeTab = await activeViewTab(resources.cdp)
        assert(activeTab === 'issue', `explicit bind must switch to the issue view (active tab: ${JSON.stringify(activeTab)})`)
        const subtitle = await waitForSubtitle(resources.cdp, emitTimeout(20_000))
        assert(subtitle.chipText.replace(/\s+/gu, '') === '#240', `subtitle chip text is ${JSON.stringify(subtitle.chipText)}, expected "#240"`)
        assert(subtitle.titleText.length > 0, 'subtitle title text is empty')
        assert(subtitle.titleAttr.length > 0, 'subtitle title attribute (full text) is empty')
        assert(subtitle.titleAttr.includes('会话名称丰富化'), `subtitle title attribute does not carry the full issue title: ${JSON.stringify(subtitle.titleAttr.slice(0, 120))}`)
        assert(subtitle.inHeader, 'subtitle row is not inside the session header (header[data-window-drag])')
        // v0.4.0 placement: the subtitle must be its own header row ABOVE the
        // conversation view-tab row (regression: it used to land inside the tab
        // flex row), aligned with the session-title text start.
        assert(subtitle.nextSiblingHasTabs, 'subtitle row is not directly above the view-tab row (next sibling does not contain [data-conversation-tabs])')
        assert(
          subtitle.tabsTop !== null && subtitle.rowBottom <= subtitle.tabsTop + 1,
          `subtitle row is not a separate line above the view tabs (subtitle bottom=${subtitle.rowBottom}, tabs top=${subtitle.tabsTop})`,
        )
        assert(subtitle.sessionTitleLeft !== null, 'could not measure the session title start for subtitle alignment')
        assert(
          Math.abs(subtitle.rowLeft - subtitle.sessionTitleLeft) <= 2,
          `subtitle row left (${subtitle.rowLeft}) is not aligned with the session title start (${subtitle.sessionTitleLeft})`,
        )
        assert(
          subtitle.whiteSpace === 'nowrap' || subtitle.height <= 26,
          `subtitle title is not single-line (whiteSpace=${subtitle.whiteSpace}, height=${subtitle.height})`,
        )
        assert(
          subtitle.textOverflow === 'ellipsis' || subtitle.scrollWidth > subtitle.clientWidth,
          `subtitle title is not truncated with an ellipsis (textOverflow=${subtitle.textOverflow}, scrollWidth=${subtitle.scrollWidth}, clientWidth=${subtitle.clientWidth})`,
        )
        // Polished evidence: let the issue detail finish loading so the shot shows
        // the header subtitle over a rendered detail, not a loading skeleton.
        await waitForPlugin(`document.querySelectorAll('[class*="ghp-skeleton"]').length === 0`, 'issue detail loaded before subtitle screenshot', emitTimeout(20_000))
        await waitForText(resources.cdp, '条评论', { timeoutMs: emitTimeout(20_000), label: 'issue meta line' })
        await settle(400)
        const screenshot = await shot('13-issue-subtitle.png')
        return { screenshot, subtitle, activeTab }
      })
      if (bindSubtitleOk === false) throw new Error('issue-bind-subtitle stage failed')
    }

    // ------------------------------------------------------- issue detail --
    if (gated('issue-detail')) {
      const issueDetailOk = await runStage('issue-detail', async () => {
        // issue-bind-subtitle bound #240 via the explicit bind action and switched
        // to this view; assert the fully loaded detail.
        assert((await activeViewTab(resources.cdp)) === 'issue', 'issue view is not active after bind')
        await waitForPlugin(`document.querySelector('[class*="ghp-issue-head"]') !== null`, 'issue detail header rendered')
        await waitForText(resources.cdp, '#240', { timeoutMs: emitTimeout(30_000) })
        await waitForText(resources.cdp, 'ceasarXuu/Astropath', { timeoutMs: emitTimeout(20_000) })
        await waitForText(resources.cdp, '会话名称丰富化', { timeoutMs: emitTimeout(20_000) })
        // Detail-only markers before shooting (never capture the loading skeleton).
        await waitForPlugin(`document.querySelectorAll('[class*="ghp-skeleton"]').length === 0`, 'issue detail loading finished')
        await waitForText(resources.cdp, '条评论', { timeoutMs: emitTimeout(20_000), label: 'issue meta line' })
        await waitForText(resources.cdp, '需求（用户', { timeoutMs: emitTimeout(20_000), label: 'issue body markdown' })
        await waitForText(resources.cdp, 'enhancement', { timeoutMs: emitTimeout(20_000), label: 'issue labels' })
        await waitForPlugin(`document.querySelectorAll('[class*="ghp-comment"]:not([class*="ghp-comments"])').length >= 1`, 'issue comments rendered')
        await settle(500)
        const screenshot = await shot('08-issue-detail.png')
        return { screenshot, bindPath: 'issue-bind-subtitle' }
      })
      if (issueDetailOk === false) throw new Error('issue-detail stage failed')
    }

    // ---------------------------------------------------- issue comments --
    if (options.extraComments && gated('issue-comments')) {
      const commentsOk = await runStage('issue-comments', async () => {
        const scrolled = await resources.cdp.evaluate(`(() => {
          const root = document.querySelector('[class~="ghp-root"]')
          if (root === null) return false
          root.scrollTop = root.scrollHeight
          return true
        })()`)
        assert(scrolled, 'issue view scrollport (.ghp-root) not found')
        await waitForText(resources.cdp, '条评论', { timeoutMs: emitTimeout(10_000) })
        await settle(500)
        const screenshot = await shot('09-issue-comments.png')
        return { screenshot }
      })
      if (commentsOk === false) throw new Error('issue-comments stage failed')
    }

    // ----------------------------------------------------- sidebar subtitle --
    // v0.4.1 §4.6: the left sidebar session row is decorated from the /bindings
    // SWR map (poll ≈4 s) once the session has a bound Issue. The stage runs
    // after the binding is created and waits up to 6 s for the injected row.
    if (gated('sidebar-subtitle')) {
      const sidebarOk = await runStage('sidebar-subtitle', async () => {
        const sidebar = await waitForSidebarSubtitle(resources.cdp, emitTimeout(6_000))
        assert(sidebar.subtitleCount === 1, `expected exactly one [data-ghp-sidebar-subtitle] in the sidebar, got ${sidebar.subtitleCount}`)
        assert(sidebar.boundRow !== null, 'sidebar subtitle is not inside a [data-row-key^="session:"] session row')
        assert(sidebar.chipText.replace(/\s+/gu, '') === '#240', `sidebar subtitle chip is ${JSON.stringify(sidebar.chipText)}, expected "#240"`)
        assert(sidebar.titleText.length > 0, 'sidebar subtitle title text is empty')
        assert(
          sidebar.titleAttr.includes('ceasarXuu/Astropath#240') && sidebar.titleAttr.includes('会话名称丰富化'),
          `sidebar subtitle title attribute does not carry the full repo#N title: ${JSON.stringify(sidebar.titleAttr.slice(0, 160))}`,
        )
        assert(sidebar.rowHeight >= 40, `bound session row is ${sidebar.rowHeight}px high; v0.4.1 requires the two-line row ≥ 40px (shipped single line is 32px)`)
        assert(sidebar.titleBottom !== null, 'could not measure the session row title for the geometric assertion')
        assert(
          sidebar.subtitleTop >= sidebar.titleBottom - 2,
          `sidebar subtitle (top=${sidebar.subtitleTop}) is not below the row title (bottom=${sidebar.titleBottom})`,
        )
        assert(
          sidebar.subtitleWidth <= sidebar.rowWidth + 1,
          `sidebar subtitle width (${sidebar.subtitleWidth}) exceeds the row width (${sidebar.rowWidth})`,
        )
        assert(
          sidebar.whiteSpace === 'nowrap' && (sidebar.textOverflow === 'ellipsis' || sidebar.overflowing !== false),
          `sidebar subtitle title is not a single-line ellipsised row (whiteSpace=${sidebar.whiteSpace}, textOverflow=${sidebar.textOverflow}, overflowing=${sidebar.overflowing})`,
        )
        assert(sidebar.otherSessionSubtitles === 0, `unbound session rows contain ${sidebar.otherSessionSubtitles} sidebar subtitle(s)`)
        assert(sidebar.workspaceSubtitles === 0, `workspace rows contain ${sidebar.workspaceSubtitles} sidebar subtitle(s)`)
        // Whole-window evidence: sidebar + the open issue view; reset the issue
        // scrollport so the detail header is visible again after issue-comments.
        await resources.cdp.evaluate(`(() => {
          const root = document.querySelector('[class~="ghp-root"]')
          if (root !== null) root.scrollTop = 0
          return true
        })()`)
        await settle(400)
        const screenshot = await shot('14-sidebar-subtitle.png')
        // §4.6 click behavior: clicking the sidebar subtitle opens the Issue page
        // in the built-in browser and must NOT change the selected session.
        const selectedBefore = await resources.cdp.evaluate(`(() => {
          const row = [...document.querySelectorAll('[data-row-key^="session:"][aria-selected="true"]')]
            .find(el => el.getBoundingClientRect().width > 0)
          return row === undefined ? null : row.getAttribute('data-row-key')
        })()`)
        const clickedSubtitle = await resources.cdp.evaluate(`(() => {
          const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
          const subtitle = [...document.querySelectorAll('[data-ghp-sidebar-subtitle]')].find(vis)
          if (subtitle === undefined) return false
          subtitle.click()
          return true
        })()`)
        assert(clickedSubtitle, 'could not click the sidebar session subtitle')
        const clickBrowser = await waitForSidebarBrowser(resources.cdp, emitTimeout(20_000), 'ceasarXuu/Astropath#240')
        const selectedAfter = await resources.cdp.evaluate(`(() => {
          const row = [...document.querySelectorAll('[data-row-key^="session:"][aria-selected="true"]')]
            .find(el => el.getBoundingClientRect().width > 0)
          return row === undefined ? null : row.getAttribute('data-row-key')
        })()`)
        assert(selectedAfter === selectedBefore, `clicking the sidebar subtitle changed the selected session (${JSON.stringify(selectedBefore)} → ${JSON.stringify(selectedAfter)})`)
        const clickCloseOk = await closeSidebarBrowser(resources.cdp, emitTimeout(15_000))
        assert(clickCloseOk, 'could not close the built-in browser opened from the sidebar subtitle')
        const collapsedAfterClick = await collapseRightSidebar(resources.cdp)
        assert(collapsedAfterClick, 'right sidebar is still expanded after the sidebar-subtitle click check')
        await settle(200)
        return {
          screenshot,
          clickOpenedBrowser: clickBrowser.src,
          clickSelectedRowUnchanged: selectedAfter === selectedBefore,
          selectedRow: selectedBefore,
          chipText: sidebar.chipText,
          titleText: clip(sidebar.titleText, 200),
          titleAttr: clip(sidebar.titleAttr, 300),
          rowKey: sidebar.boundRow,
          rowHeight: sidebar.rowHeight,
          subtitleTop: sidebar.subtitleTop,
          titleBottom: sidebar.titleBottom,
          subtitleWidth: sidebar.subtitleWidth,
          rowWidth: sidebar.rowWidth,
          whiteSpace: sidebar.whiteSpace,
          textOverflow: sidebar.textOverflow,
          overflowing: sidebar.overflowing,
          sidebarSubtitleCount: sidebar.subtitleCount,
          unboundSessionRows: sidebar.unboundSessionRows,
          workspaceRows: sidebar.workspaceRows,
        }
      })
      if (sidebarOk === false) throw new Error('sidebar-subtitle stage failed')
    }

    // ------------------------------------------------------ projects warm --
    // v0.4.0 §3.5: after the first load the projects view is served from the
    // module-level SWR cache — switching back must render the board without a
    // cold skeleton and within 1500ms.
    if (gated('projects-warm')) {
      const warmOk = await runStage('projects-warm', async () => {
        assert(await clickTab(resources.cdp, '对话'), 'could not switch to the "对话" view for the warm-open measurement')
        await settle(250)
        const warmStarted = Date.now()
        assert(await clickTab(resources.cdp, 'projects'), 'could not switch back to the "projects" view')
        let warmMs = null
        let skeletonSeen = false
        let refreshIndicators = 0
        let lastState = null
        while (Date.now() - warmStarted < emitTimeout(6000)) {
          lastState = await resources.cdp.evaluate(`(() => {
            const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
            const root = [...document.querySelectorAll('[data-ghp-view-mode]')].find(vis)
            const board = [...document.querySelectorAll('[data-ghp-board]')].find(vis)
            const skeletons = [...document.querySelectorAll('[class*="ghp-skeleton"]')].filter(vis).length
            const spinners = [...document.querySelectorAll('[class*="ghp-spinner"]')].filter(vis).length
            return {
              mode: root === undefined ? null : root.getAttribute('data-ghp-view-mode'),
              board: board !== undefined,
              skeletons,
              spinners,
            }
          })()`)
          if (lastState.skeletons > 0) skeletonSeen = true
          refreshIndicators = lastState.spinners
          if (lastState.mode === 'board' && lastState.board && lastState.skeletons === 0) {
            warmMs = Date.now() - warmStarted
            break
          }
          await sleep(40)
        }
        assert(warmMs !== null, `cached projects view did not render a skeleton-free board within ${emitTimeout(6000)}ms (last: ${JSON.stringify(lastState)})`)
        assert(warmMs <= 1500, `warm projects open took ${warmMs}ms (>1500ms) — CONTRACT §3.5 requires the cached board to render without a cold skeleton`)
        assert(!skeletonSeen, 'warm projects open rendered a loading skeleton although cached data exists (SWR cache miss)')
        // Host-side plugin request timings observed for the warm revalidation.
        const pluginRequestTimings = resources.cdp.pluginRequests.slice(-12)
        const pluginResponses = (await readPluginResponses(resources.cdp)).slice(-12).map(entry => ({
          route: String(entry.url).replace(/^[^?]*\/plugin\/github-projects/iu, '').split('?')[0],
          status: entry.status,
          stale: entry.json?.stale ?? null,
        }))
        return { warmMs, coldBoardMs, skeletonSeen, refreshIndicators, pluginRequestTimings, pluginResponses }
      })
      if (warmOk === false) throw new Error('projects-warm stage failed')
    }

    // ------------------------------------------------------------- console --
    await runStage('console', async () => {
      const { consoleErrors, consoleWarnings, exceptions } = resources.cdp.errors()
      const benign = []
      const unexpected = []
      for (const entry of [...consoleErrors.map(e => ({ ...e, kind: 'console' })), ...exceptions.map(e => ({ ...e, kind: 'exception' }))]) {
        const allowed = BENIGN_CONSOLE_ERRORS.find(candidate => candidate.pattern.test(entry.text))
        if (allowed === undefined) unexpected.push(entry)
        else benign.push({ text: clip(entry.text, 300), why: allowed.why })
      }
      assert(unexpected.length === 0, `browser reported ${unexpected.length} unexpected console error(s)/exception(s): ${JSON.stringify(unexpected.slice(0, 5))}`)
      const pluginHttpErrors = resources.cdp.httpErrors.filter(entry => entry.url.includes('/plugin/github-projects'))
      assert(pluginHttpErrors.length === 0, `plugin HTTP error responses: ${JSON.stringify(pluginHttpErrors.slice(0, 5))}`)
      const pluginNetworkFailures = resources.cdp.networkFailures.filter(entry => String(entry.url ?? '').includes('/plugin/github-projects'))
      assert(pluginNetworkFailures.length === 0, `plugin network failures: ${JSON.stringify(pluginNetworkFailures.slice(0, 5))}`)

      // v0.4.0 host contract: /projects, /items and /issue carry a boolean
      // `stale` flag on every 2xx response (fixture always false; real may be
      // true on a stale-but-served window — legal, logged, not failed).
      const pluginResponses = await readPluginResponses(resources.cdp)
      const dataRoutes = pluginResponses.filter(entry => entry.status >= 200 && entry.status < 300
        && /\/plugin\/github-projects\/(projects|items|issue)(?:\?|$)/u.test(entry.url))
      assert(dataRoutes.length >= 2, `expected /projects, /items and /issue responses to be observed, got ${dataRoutes.length}: ${JSON.stringify(pluginResponses.slice(0, 10))}`)
      const missingStale = dataRoutes.filter(entry => typeof entry.json?.stale !== 'boolean')
      assert(missingStale.length === 0, `plugin data responses without a boolean "stale" field: ${JSON.stringify(missingStale.slice(0, 5))}`)
      const staleTrue = dataRoutes.filter(entry => entry.json?.stale === true)
      const configResponses = pluginResponses.filter(entry => entry.status >= 200 && entry.status < 300
        && /\/plugin\/github-projects\/config(?:\?|$)/u.test(entry.url))
      const configPending = configResponses.filter(entry => entry.json?.gh?.error === 'pending' || entry.json?.gh?.available === false)
      // Release gate (v1.0.0): prove the renamed client module id is what the
      // browser actually loaded (served bundle URLs expose the package name).
      const moduleUrls = await resources.cdp.evaluate(`(() => {
        return [...performance.getEntriesByType('resource')]
          .map(entry => entry.name)
          .filter(name => name.includes('/plugins/'))
          .map(name => { try { return decodeURIComponent(name) } catch { return name } })
          .filter(name => name.includes('github-projects'))
      })()`)
      const renamedModuleLoaded = moduleUrls.some(url => url.includes('@ceasarxuu/dsh-github-projects'))
      const oldModuleLoaded = moduleUrls.some(url => url.includes('@local/dsh-github-projects'))
      assert(moduleUrls.length >= 1, `client plugin bundle was not observed in page resource timings (${JSON.stringify(moduleUrls)})`)
      assert(
        renamedModuleLoaded && !oldModuleLoaded,
        `client plugin module id rename mismatch: loaded=${JSON.stringify(moduleUrls)} (expected @ceasarxuu/dsh-github-projects, no @local/)`,
      )
      const routeSummary = pluginResponses.map(entry => ({
        route: String(entry.url).replace(/^[^?]*\/plugin\/github-projects/iu, ''),
        status: entry.status,
        stale: entry.json?.stale ?? null,
        ghError: entry.json?.gh?.error ?? null,
        at: entry.at,
      }))
      return {
        consoleErrors: 0,
        exceptions: 0,
        benign: benign.length,
        warnings: consoleWarnings.length,
        warningSamples: consoleWarnings.slice(0, 5).map(warning => clip(warning.text, 200)),
        pluginRequests: resources.cdp.pluginRequests.filter(entry => !entry.url.includes('/health')).slice(-12),
        pluginResponses: routeSummary.slice(-16),
        stale: {
          dataResponses: dataRoutes.length,
          missingStale: missingStale.length,
          staleTrue: staleTrue.length,
        },
        config: {
          responses: configResponses.length,
          ghPending: configPending.length,
        },
        bindings: {
          responses: pluginResponses.filter(entry => /\/plugin\/github-projects\/bindings(?:\?|$)/u.test(entry.url)).length,
        },
        clientModule: {
          renamed: renamedModuleLoaded,
          oldIdLoaded: oldModuleLoaded,
          urls: moduleUrls,
        },
      }
    })
  } catch (error) {
    // Stage helpers already emitted the failing step; this is only a guard for
    // failures between stages.
    if (failures.length === 0) {
      failures.push({ step: lastStep ?? 'unknown', error: String(error?.message ?? error) })
      emit(lastStep ?? 'unknown', false, { error: clip(error?.message ?? error, 2000), runDir: root.root })
    }
  } finally {
    // Kill children in reverse start order; never leak a browser or server.
    try { resources.cdp?.close() } catch { /* ignore */ }
    try { await resources.chrome?.stop() } catch { /* ignore */ }
    try { await resources.dsh?.stop() } catch { /* ignore */ }
    try { await resources.llm?.close() } catch { /* ignore */ }
  }

  // Artifact accounting: the harness writes 01–06 (and optionally 08); 07 is
  // manual Desktop-install evidence owned by the Lead and never touched here.
  const desktopEvidence = join(SCREENSHOT_DIR, '10-desktop-tabs.png')
  const manualEvidence = existsSync(desktopEvidence) ? { '10-desktop-tabs.png': desktopEvidence } : {}

  // Persist a machine-readable record of the run next to its logs.
  const summary = {
    runId,
    mode: options.mode,
    host: MODES[options.mode].description,
    ok: failures.length === 0,
    failures,
    harnessScreenshots: screenshots,
    manualEvidence,
    runDir: root.root,
    keep: options.keep,
  }
  writeFileSync(join(root.logs, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8')

  if (!options.extraComments) {
    try { rmSync(join(SCREENSHOT_DIR, '09-issue-comments.png'), { force: true }) } catch { /* ignore */ }
  }
  const keepRun = options.keep || failures.length > 0
  if (!keepRun) {
    try { rmSync(root.root, { recursive: true, force: true }) } catch { /* ignore */ }
  } else {
    process.stderr.write(`run directory kept: ${root.root}\n`)
  }

  if (failures.length === 0) {
    emit('result', true, { screenshots, manualEvidence, runDir: keepRun ? root.root : null, mode: options.mode })
    process.stdout.write('PASS\n')
    process.exit(0)
  }
  emit('result', false, { failures, runDir: root.root })
  process.stdout.write('FAIL\n')
  process.exit(1)
}

// ------------------------------------------------------------------ helpers --

/** Find the deepest visible element containing `text` and click its row/button. */
async function clickTextRow(cdp, text) {
  return cdp.evaluate(`(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const norm = (el) => (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ')
    const nodes = [...document.querySelectorAll('button,[role="button"],[role="option"],li,div')].filter(vis)
    const holders = nodes.filter(el => norm(el).includes(${JSON.stringify(text)}))
    if (holders.length === 0) return false
    // deepest holder = the row itself (not an ancestor container listing it)
    const target = holders.filter(el => !holders.some(other => other !== el && el.contains(other))).pop()
    const clickable = target.closest('button,[role="button"],[role="option"],a') ?? target
    clickable.click()
    return true
  })()`)
}

/** Click the "绑定" action on the project row whose text contains `rowMarker`. */
async function clickBindActionForRow(cdp, rowMarker) {
  return cdp.evaluate(`(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const norm = (el) => (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ')
    const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(vis)
      .filter(el => norm(el) === '绑定' || el.getAttribute('aria-label') === '绑定' || norm(el) === '绑定 Issue')
    for (const button of buttons) {
      let node = button.parentElement
      let rowText = ''
      for (let depth = 0; depth < 8 && node !== null; depth++) {
        rowText = norm(node)
        if (rowText.length > 12) break
        node = node.parentElement
      }
      if (rowText.includes(${JSON.stringify(rowMarker)})) { button.click(); return true }
    }
    return false
  })()`)
}

/** Set a visible input/textarea by its placeholder and fire framework events. */
async function setByPlaceholder(cdp, placeholder, value) {
  return cdp.evaluate(`(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const els = [...document.querySelectorAll('input,textarea,[contenteditable="true"],[role="textbox"]')].filter(vis)
    const target = els.find(el => (el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || '') === ${JSON.stringify(placeholder)})
    if (target === undefined) return false
    target.focus()
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(target, ${JSON.stringify(value)})
      target.dispatchEvent(new Event('input', { bubbles: true }))
      target.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }
    const range = document.createRange()
    range.selectNodeContents(target)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    return document.execCommand('insertText', false, ${JSON.stringify(value)})
  })()`)
}

function tailText(text, length = 2000) {
  const value = String(text ?? '')
  return value.length <= length ? value : `…${value.slice(-length)}`
}

// ------------------------------------------------------- plugin DOM helpers --
// v1.1 stable test hooks (docs/CONTRACT.md §4.2.1): board/list modes, milestone
// dropdown, board columns/cards. Kept as expressions so the same logic runs in
// every stage and failure diagnostics can reuse it.

const BOARD_SNAPSHOT = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const viewRoot = [...document.querySelectorAll('[data-ghp-view-mode]')].find(vis) ?? document.querySelector('[data-ghp-view-mode]')
  const board = document.querySelector('[data-ghp-board]')
  const columns = [...document.querySelectorAll('[data-ghp-column]')].map(el => ({
    key: el.getAttribute('data-ghp-column'),
    countAttr: el.getAttribute('data-ghp-count'),
    cardCount: el.querySelectorAll('[data-ghp-card]').length,
  }))
  const cards = [...document.querySelectorAll('[data-ghp-card]')].filter(vis)
  const countSum = columns.reduce((sum, column) => {
    const value = Number(column.countAttr)
    return sum + (Number.isFinite(value) ? value : 0)
  }, 0)
  return {
    mode: viewRoot === null ? null : viewRoot.getAttribute('data-ghp-view-mode'),
    hasBoard: board !== null,
    hiddenLanes: board === null ? null : board.getAttribute('data-ghp-hidden-lanes'),
    columns: columns.map(column => ({ key: column.key, count: Number(column.countAttr), cardCount: column.cardCount })),
    cardCount: cards.length,
    countSum,
  }
})()`

const LIST_SNAPSHOT = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const viewRoot = [...document.querySelectorAll('[data-ghp-view-mode]')].find(vis) ?? document.querySelector('[data-ghp-view-mode]')
  const list = document.querySelector('[data-ghp-list]')
  const statuses = ['No status', 'TODO', 'In Progress', 'In Review', 'Done', '未分类']
  const text = list === null ? '' : (list.innerText || '')
  const rowCandidates = list === null ? [] : [...list.querySelectorAll('.ghp-item, [data-ghp-card], [class*="ghp-item"]')].filter(vis)
  const rows = new Set(rowCandidates.map(el => el.closest('.ghp-item') ?? el)).size
  const groups = list === null ? 0 : (() => {
    const exact = list.querySelectorAll('.ghp-section').length
    if (exact > 0) return exact
    return list.querySelectorAll('[class*="ghp-section"]:not([class*="ghp-section-head"]):not([class*="ghp-section-title"]):not([class*="ghp-section-count"])').length
  })()
  return {
    mode: viewRoot === null ? null : viewRoot.getAttribute('data-ghp-view-mode'),
    hasList: list !== null,
    rows,
    groups,
    textLength: text.trim().length,
    statusesInText: statuses.filter(status => text.includes(status)),
  }
})()`

const MILESTONE_OPTIONS = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  return [...document.querySelectorAll('[data-ghp-milestone-option]')].filter(vis).map(el => ({
    value: el.getAttribute('data-ghp-milestone-option'),
    active: el.getAttribute('data-active') === 'true',
    text: (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80),
  }))
})()`

// Canonical lane order and the v0.3.0 hidden-lane rule (CONTRACT §4.2).
const CANONICAL_LANES = ['no-status', 'todo', 'in-progress', 'in-review', 'done']
const ALWAYS_RENDERED_LANES = CANONICAL_LANES.filter(key => key !== 'no-status')

/** `data-ghp-hidden-lanes` is a comma-separated list; empty string = nothing hidden. */
function parseHiddenLanes(value) {
  if (value === null || value === undefined) return []
  return String(value).split(',').map(entry => entry.trim()).filter(entry => entry.length > 0)
}

/**
 * Validate CONTRACT §4.2 v0.3.0 lane rules against a board snapshot:
 * canonical lanes are a subsequence in fixed order, `no-status` renders iff not
 * declared hidden (and hidden iff its filtered count is 0), unknown `other:*`
 * lanes render only when non-empty and trail the canonical lanes, and every
 * lane's `data-ghp-count` agrees with the cards rendered in it.
 * @returns {{problems: string[], hidden: string[], laneKeys: string[], others: string[]}}
 */
function laneRuleProblems(board) {
  const problems = []
  const laneKeys = board.columns.map(column => column.key)
  const hidden = parseHiddenLanes(board.hiddenLanes)
  const others = laneKeys.filter(key => key.startsWith('other:'))
  const canonicalVisible = laneKeys.filter(key => CANONICAL_LANES.includes(key))

  for (const key of hidden) {
    if (!CANONICAL_LANES.includes(key)) problems.push(`hidden lane ${JSON.stringify(key)} is not a canonical lane`)
    else if (key !== 'no-status') problems.push(`only no-status may be hidden, got ${JSON.stringify(key)}`)
  }

  // The four non-No-status canonical lanes always render exactly once and in order.
  const expectedVisible = CANONICAL_LANES.filter(key => !hidden.includes(key))
  if (JSON.stringify(canonicalVisible) !== JSON.stringify(expectedVisible)) {
    problems.push(`rendered canonical lanes ${JSON.stringify(canonicalVisible)} != expected ${JSON.stringify(expectedVisible)} (hidden: ${JSON.stringify(hidden)})`)
  }
  for (const key of ALWAYS_RENDERED_LANES) {
    const count = laneKeys.filter(entry => entry === key).length
    if (count !== 1) problems.push(`canonical lane ${key} must render exactly once, got ${count}`)
  }

  // No status: present iff not declared hidden; when present its count is non-zero.
  const noStatusVisible = laneKeys.includes('no-status')
  const noStatusHidden = hidden.includes('no-status')
  if (noStatusVisible === noStatusHidden) {
    problems.push(`no-status visibility inconsistent with data-ghp-hidden-lanes=${JSON.stringify(board.hiddenLanes)} (present=${noStatusVisible})`)
  }
  if (noStatusVisible) {
    const column = board.columns.find(entry => entry.key === 'no-status')
    if (!(column !== undefined && column.count > 0)) problems.push(`no-status is rendered but its filtered count is ${column?.count}`)
  }

  // Unknown lanes only when non-empty, trailing the canonical lanes.
  const firstOther = laneKeys.findIndex(key => key.startsWith('other:'))
  if (firstOther !== -1) {
    if (laneKeys.slice(firstOther).some(key => !key.startsWith('other:'))) problems.push('other:* lanes must trail the canonical lanes')
    for (const key of others) {
      const column = board.columns.find(entry => entry.key === key)
      if (!(column !== undefined && column.count > 0)) problems.push(`unknown lane ${JSON.stringify(key)} renders with count ${column?.count}`)
    }
  }

  // Counters agree with rendered cards, per lane and in total.
  for (const column of board.columns) {
    if (column.count !== column.cardCount) problems.push(`lane ${column.key}: data-ghp-count=${column.count} but ${column.cardCount} cards rendered`)
  }
  if (board.cardCount !== board.countSum) problems.push(`board cards=${board.cardCount} != sum(data-ghp-count)=${board.countSum}`)

  return { problems, hidden, laneKeys, others }
}

/**
 * Mode-specific lane expectation (CONTRACT §5): fixture data contains a
 * no-status item (5 lanes, nothing hidden); real Project #9 has none
 * (`data-ghp-hidden-lanes="no-status"`, exactly the four remaining lanes).
 */
function expectedLaneKeysForMode(mode, hidden) {
  if (mode === 'fixture') {
    if (hidden.length !== 0) {
      return { ok: false, expected: CANONICAL_LANES, message: `fixture board must not hide lanes, got data-ghp-hidden-lanes=${JSON.stringify(hidden)}` }
    }
    return { ok: true, expected: CANONICAL_LANES }
  }
  if (hidden.length !== 1 || hidden[0] !== 'no-status') {
    return { ok: false, expected: ALWAYS_RENDERED_LANES, message: `real Project #9 board must hide exactly no-status, got data-ghp-hidden-lanes=${JSON.stringify(hidden)}` }
  }
  return { ok: true, expected: ALWAYS_RENDERED_LANES }
}

/** Wait until the board reaches a coherent state (mode, v0.3.0 lane rules, counters). */
async function waitForBoard(cdp, timeoutMs, { expectedLessThan } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  let lastProblem = 'not evaluated'
  while (Date.now() < deadline) {
    try {
      last = await cdp.evaluate(BOARD_SNAPSHOT)
    } catch (error) {
      lastProblem = `evaluate failed: ${error.message}`
      await sleep(200)
      continue
    }
    const laneCheck = laneRuleProblems(last)
    const cardsOk = last.cardCount >= 1
    const shrinkOk = expectedLessThan === undefined || last.countSum < expectedLessThan
    if (last.mode === 'board' && last.hasBoard && laneCheck.problems.length === 0 && cardsOk && shrinkOk) {
      return { ...last, laneCheck }
    }
    const keys = last.columns.map(column => column.key)
    lastProblem = `mode=${JSON.stringify(last.mode)} hasBoard=${last.hasBoard} hidden=${JSON.stringify(last.hiddenLanes)} columns=${JSON.stringify(keys)} cards=${last.cardCount} countSum=${last.countSum} problems=${JSON.stringify(laneCheck.problems)}`
    await sleep(200)
  }
  throw new Error(`board did not reach the expected state within ${timeoutMs}ms (${lastProblem})`)
}

/** Click one of the `data-ghp-action` toolbar hooks. */
async function clickAction(cdp, action) {
  return cdp.evaluate(`(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const selector = '[data-ghp-action="' + ${JSON.stringify(action)} + '"]'
    const el = [...document.querySelectorAll(selector)].find(vis) ?? document.querySelector(selector)
    if (el === undefined || el === null) return false
    el.click()
    return true
  })()`)
}

const clickMilestoneToggle = cdp => clickAction(cdp, 'milestone')

async function milestoneOptions(cdp) {
  return cdp.evaluate(MILESTONE_OPTIONS).catch(() => [])
}

/** Wait for the milestone dropdown to expose its visible options. */
async function waitForMilestoneOptions(cdp, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = []
  while (Date.now() < deadline) {
    last = await milestoneOptions(cdp)
    if (last.length >= 2) return last
    await sleep(150)
  }
  throw new Error(`milestone dropdown did not open (visible options: ${JSON.stringify(last.map(option => option.value))})`)
}

async function isMilestoneDropdownOpen(cdp) {
  return (await milestoneOptions(cdp)).length >= 1
}

/** Select a milestone option by its `data-ghp-milestone-option` value. */
async function selectMilestoneOption(cdp, value) {
  if (!(await isMilestoneDropdownOpen(cdp))) {
    if (!(await clickMilestoneToggle(cdp))) return false
    await waitForMilestoneOptions(cdp, 10_000).catch(() => {})
  }
  const clicked = await cdp.evaluate(`(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const els = [...document.querySelectorAll('[data-ghp-milestone-option]')].filter(vis)
    const target = els.find(el => el.getAttribute('data-ghp-milestone-option') === ${JSON.stringify(value)})
    if (target === undefined) return false
    target.click()
    return true
  })()`)
  await sleep(250)
  return clicked
}

/** Wait until exactly one milestone option is active and it is `value`. */
async function waitForMilestoneActive(cdp, value, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let actives = []
  while (Date.now() < deadline) {
    const options = await milestoneOptions(cdp)
    actives = options.filter(option => option.active).map(option => option.value)
    if (actives.length === 1 && actives[0] === value) return options
    await sleep(150)
  }
  throw new Error(`milestone option "${value}" is not the single active option (active: ${JSON.stringify(actives)})`)
}

async function pressEscape(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
}

async function closeMilestoneDropdown(cdp) {
  if (!(await isMilestoneDropdownOpen(cdp))) return
  await pressEscape(cdp)
  await sleep(250)
  if (await isMilestoneDropdownOpen(cdp)) {
    await clickMilestoneToggle(cdp)
    await sleep(250)
  }
}

/** Click the bind/open action of the board card for `issueRef` (owner/repo#N). */
async function openIssueCard(cdp, issueRef) {
  return cdp.evaluate(`(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const card = [...document.querySelectorAll('[data-ghp-card]')]
      .find(el => el.getAttribute('data-issue') === ${JSON.stringify(issueRef)} && vis(el))
    if (card === undefined) return false
    const action = card.querySelector('[data-ghp-card-action]')
    ;(action ?? card).click()
    return true
  })()`)
}

// ------------------------------------------------- wide-layout (v1.1.1) helpers --

/** Resize the page viewport through CDP and wait for the window to report it. */
async function setViewport(cdp, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await cdp.waitFor(`window.innerWidth === ${width} && window.innerHeight === ${height}`, {
    timeoutMs: 15_000,
    label: `viewport ${width}x${height}`,
  })
  await sleep(250)
}

const WIDE_LAYOUT = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const viewRoot = [...document.querySelectorAll('[data-ghp-view-mode="board"]')].find(vis)
  const page = viewRoot === undefined ? null : viewRoot.querySelector('.ghp-page')
  const board = document.querySelector('[data-ghp-board]')
  const columns = [...document.querySelectorAll('[data-ghp-board] [data-ghp-column]')]
  const cards = [...document.querySelectorAll('[data-ghp-board] [data-ghp-card]')].filter(vis)
  const pageRect = page === null ? null : page.getBoundingClientRect()
  const boardRect = board === null ? null : board.getBoundingClientRect()
  const laneWidths = columns.map(el => Math.round(el.getBoundingClientRect().width * 10) / 10)
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    hasBoard: board !== null,
    hasPage: page !== null,
    pageWidth: pageRect === null ? 0 : Math.round(pageRect.width * 10) / 10,
    pageLeft: pageRect === null ? -1 : Math.round(pageRect.left * 10) / 10,
    boardWidth: boardRect === null ? 0 : Math.round(boardRect.width * 10) / 10,
    hiddenLanes: board === null ? null : board.getAttribute('data-ghp-hidden-lanes'),
    laneKeys: columns.map(el => el.getAttribute('data-ghp-column')),
    laneWidths,
    laneWidthSum: Math.round(laneWidths.reduce((sum, width) => sum + width, 0) * 10) / 10,
    cardCount: cards.length,
  }
})()`

/** Wait for the 2200px reflow to settle (page present and width stable). */
async function waitForWideLayout(cdp, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let previousWidth = -1
  let stableTicks = 0
  let last = null
  while (Date.now() < deadline) {
    last = await cdp.evaluate(WIDE_LAYOUT)
    if (last.hasPage && last.hasBoard && last.pageWidth > 0) {
      stableTicks = Math.abs(last.pageWidth - previousWidth) < 1 ? stableTicks + 1 : 0
      previousWidth = last.pageWidth
      if (stableTicks >= 2) return last
    } else {
      stableTicks = 0
    }
    await sleep(200)
  }
  throw new Error(`wide layout did not settle within ${timeoutMs}ms (last: ${JSON.stringify(last)})`)
}

/** Actual PNG pixel size, parsed from the IHDR chunk. */
function pngDimensions(file) {
  const buffer = readFileSync(file)
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') {
    throw new Error(`not a PNG file: ${file}`)
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

// ---------------------------------------- v0.4.0 browser / subtitle helpers --

/** The currently selected conversation view tab label (or null). */
async function activeViewTab(cdp) {
  return cdp.evaluate(`(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const el = [...document.querySelectorAll('button[role="tab"][aria-selected="true"]')].find(vis)
    return el === undefined ? null : (el.innerText || el.textContent || '').trim()
  })()`)
}

/** Does the board card for `issueRef` expose the given `[data-ghp-card-action]`? */
async function cardHasAction(cdp, issueRef, action) {
  return cdp.evaluate(`(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const card = [...document.querySelectorAll('[data-ghp-card]')]
      .find(el => el.getAttribute('data-issue') === ${JSON.stringify(issueRef)} && vis(el))
    if (card === undefined) return false
    if (card.getAttribute('data-ghp-card-action') === ${JSON.stringify(action)}) return true
    return card.querySelector('[data-ghp-card-action="' + ${JSON.stringify(action)} + '"]') !== null
  })()`)
}

/**
 * Click a card's explicit action (`bind`/`open`). v0.4.0: the card body opens the
 * built-in browser, the bind button binds — they are separate hooks.
 */
async function clickCardAction(cdp, issueRef, action) {
  return cdp.evaluate(`(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const card = [...document.querySelectorAll('[data-ghp-card]')]
      .find(el => el.getAttribute('data-issue') === ${JSON.stringify(issueRef)} && vis(el))
    if (card === undefined) return false
    const explicit = card.querySelector('[data-ghp-card-action="' + ${JSON.stringify(action)} + '"]')
    let target = explicit
    if (target === null && card.getAttribute('data-ghp-card-action') === ${JSON.stringify(action)}) target = card
    if (target === null && ${JSON.stringify(action)} === 'open') target = card
    if (target === null) return false
    target.click()
    return true
  })()`)
}

/** Wait for DSH's built-in sidebar browser iframe showing the given issue URL. */
async function waitForSidebarBrowser(cdp, timeoutMs, issueRef) {
  const selector = `[data-sidebar-browser-frame]`
  const [repo, number] = issueRef.split('#')
  const expectedUrlPart = `github.com/${repo}/issues/${number}`
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await cdp.evaluate(`(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
      const frame = [...document.querySelectorAll(${JSON.stringify(selector)})].find(vis)
      if (frame === undefined) return null
      const pane = frame.closest('[data-dockkit-pane]')
      const tabs = (pane === null ? [...document.querySelectorAll('[data-dockkit-tab]')] : [...pane.querySelectorAll('[data-dockkit-tab]')]).filter(vis)
      const addressValue = [...document.querySelectorAll('input')].filter(vis)
        .map(el => el.value)
        .find(value => typeof value === 'string' && value.includes('github.com/')) ?? null
      return {
        tag: frame.tagName.toLowerCase(),
        src: frame.getAttribute('src') || (frame.src === undefined ? '' : frame.src),
        dockkitTabs: tabs.map(el => (el.innerText || el.textContent || '').trim()).filter(Boolean),
        addressValue,
      }
    })()`)
    if (last !== null && last.src.includes(expectedUrlPart)) return last
    await sleep(150)
  }
  throw new Error(`built-in browser did not open ${issueRef} within ${timeoutMs}ms (iframe: ${JSON.stringify(last)})`)
}

/**
 * Close the built-in browser tab: open the dockkit tab context menu, click the
 * "关闭" menu item, wait for the frame to disappear, then restore the sidebar
 * baseline (collapsed) so later screenshots are unaffected.
 * @returns {Promise<boolean>}
 */
async function closeSidebarBrowser(cdp, timeoutMs) {
  const opened = await cdp.evaluate(`(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const frame = [...document.querySelectorAll('[data-sidebar-browser-frame]')].find(vis)
    if (frame === undefined) return { ok: false, why: 'no browser frame' }
    const pane = frame.closest('[data-dockkit-pane]')
    const tabs = (pane === null ? [...document.querySelectorAll('[data-dockkit-tab]')] : [...pane.querySelectorAll('[data-dockkit-tab]')]).filter(vis)
    let tab = tabs.find(el => el.getAttribute('aria-selected') === 'true')
    if (tab === undefined) tab = tabs.find(el => (el.innerText || '').includes('GitHub'))
    if (tab === undefined) tab = tabs[0]
    if (tab === undefined) return { ok: false, why: 'no dockkit tab found' }
    const rect = tab.getBoundingClientRect()
    tab.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
    }))
    return { ok: true }
  })()`)
  if (opened.ok !== true) return false
  const menuReady = await cdp.waitFor(
    `[...document.querySelectorAll('[data-dockkit-tab-menu] [data-dockkit-menu-close]')].some(el => el.getBoundingClientRect().width > 0)`,
    { timeoutMs, intervalMs: 100, label: 'dockkit tab context menu' },
  ).then(() => true).catch(() => false)
  if (!menuReady) return false
  const clicked = await cdp.evaluate(`(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const item = [...document.querySelectorAll('[data-dockkit-tab-menu] [data-dockkit-menu-close]')].find(vis)
    if (item === undefined) return false
    item.click()
    return true
  })()`)
  if (!clicked) return false
  const gone = await cdp.waitFor(`document.querySelector('[data-sidebar-browser-frame]') === null`, {
    timeoutMs, intervalMs: 100, label: 'browser frame removed',
  }).then(() => true).catch(() => false)
  if (!gone) return false
  await collapseRightSidebar(cdp)
  return true
}

/** Restore the shipped baseline: right sidebar collapsed (idempotent, retried). */
async function collapseRightSidebar(cdp) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const state = await cdp.evaluate(`(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
      const expand = [...document.querySelectorAll('[data-sidebar-right-expand]')].find(vis)
      if (expand !== undefined) return { state: 'collapsed' }
      const toggle = [...document.querySelectorAll('[data-sidebar-right-toggle]')].find(vis)
      if (toggle !== undefined) { toggle.click(); return { state: 'clicked-toggle' } }
      const fallback = [...document.querySelectorAll('button,[role="button"]')]
        .find(el => el.getAttribute('aria-label') === '收起右侧边栏' && vis(el))
      if (fallback !== undefined) { fallback.click(); return { state: 'clicked-aria' } }
      return { state: 'absent' }
    })()`)
    if (state.state === 'collapsed') return true
    await sleep(400)
  }
  return cdp.evaluate(`(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    return [...document.querySelectorAll('[data-sidebar-right-expand]')].some(vis)
  })()`)
}

// Session issue subtitle (§4.5): chip + truncated title + full title attribute.
const SUBTITLE_SNAPSHOT = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const row = [...document.querySelectorAll('[data-ghp-session-subtitle]')].find(vis)
  if (row === undefined) return null
  const chip = row.querySelector('[data-ghp-subtitle-chip]')
  const title = row.querySelector('[data-ghp-subtitle-title]')
  const style = title === null ? null : getComputedStyle(title)
  const rect = title === null ? null : title.getBoundingClientRect()
  const rowRect = row.getBoundingClientRect()
  const header = row.closest('header[data-window-drag]')
  // v0.4.0 fixed placement: the subtitle is its own header row directly above
  // the conversation view-tab row (not a flex child inside it).
  const nextSibling = row.nextElementSibling
  const tabsContainer = nextSibling === null ? null : nextSibling.querySelector('[data-conversation-tabs]')
  const tabsRowRect = tabsContainer === null ? null : (nextSibling.getBoundingClientRect())
  // Session title start: the shipped header renders it as an (innermost) crumb.
  const crumbs = header === null ? [] : [...header.querySelectorAll('[class*="crumb"]')].filter(vis)
  const titleEl = crumbs.sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)[0]
  return {
    chipText: chip === null ? '' : (chip.innerText || chip.textContent || '').trim(),
    rowTop: Math.round(rowRect.top * 10) / 10,
    rowBottom: Math.round(rowRect.bottom * 10) / 10,
    rowLeft: Math.round(rowRect.left * 10) / 10,
    tabsTop: tabsRowRect === null ? null : Math.round(tabsRowRect.top * 10) / 10,
    nextSiblingHasTabs: tabsContainer !== null,
    sessionTitleLeft: titleEl === undefined ? null : Math.round(titleEl.getBoundingClientRect().left * 10) / 10,
    titleText: title === null ? '' : (title.innerText || title.textContent || '').trim(),
    titleAttr: title === null ? '' : (title.getAttribute('title') || ''),
    inHeader: row.closest('header[data-window-drag]') !== null,
    whiteSpace: style === null ? null : style.whiteSpace,
    textOverflow: style === null ? null : style.textOverflow,
    height: rect === null ? null : Math.round(rect.height * 10) / 10,
    scrollWidth: title === null ? null : title.scrollWidth,
    clientWidth: title === null ? null : title.clientWidth,
    rowText: (row.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 200),
  }
})()`

/** Wait for the session issue subtitle to render with a chip and title. */
async function waitForSubtitle(cdp, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await cdp.evaluate(SUBTITLE_SNAPSHOT)
    if (last !== null && last.chipText.length > 0 && last.titleText.length > 0) return last
    await sleep(150)
  }
  throw new Error(`session issue subtitle did not render within ${timeoutMs}ms (last: ${JSON.stringify(last)})`)
}

// --------------------------- plugin API response instrumentation (v0.4.0) --

/**
 * Installed into every new document before any page script runs: wraps
 * `window.fetch` so the harness can read plugin API JSON (asserting contract
 * fields such as `stale`) and log per-request status without network sniffing.
 */
const PLUGIN_FETCH_INSTRUMENTATION = `(() => {
  if (window.__dshE2EPluginFetchInstalled === true) return
  window.__dshE2EPluginFetchInstalled = true
  window.__dshE2EPluginResponses = []
  const original = window.fetch
  window.fetch = async function (input, init) {
    const response = await original.apply(this, arguments)
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      if (url.includes('/plugin/github-projects/')) {
        const clone = response.clone()
        const text = await clone.text()
        let json = null
        try { json = JSON.parse(text) } catch { /* non-JSON body */ }
        window.__dshE2EPluginResponses.push({ url, status: response.status, at: Date.now(), json })
        if (window.__dshE2EPluginResponses.length > 500) window.__dshE2EPluginResponses.splice(0, 250)
      }
    } catch { /* never break the app because of instrumentation */ }
    return response
  }
})()`

/** Read the plugin API responses recorded by the in-page instrumentation. */
async function readPluginResponses(cdp) {
  return cdp.evaluate(`window.__dshE2EPluginResponses === undefined ? [] : window.__dshE2EPluginResponses`).catch(() => [])
}

// ------------------------------------ v0.4.1 sidebar session-row subtitle --

const SIDEBAR_SUBTITLE_SNAPSHOT = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const rowOf = (el) => (el.getAttribute('data-row-key') || '')
  const rows = [...document.querySelectorAll('[data-row-key]')].filter(vis)
  const sessionRows = rows.filter(el => rowOf(el).startsWith('session:'))
  const workspaceRows = rows.filter(el => rowOf(el).startsWith('workspace:'))
  const subtitles = [...document.querySelectorAll('[data-ghp-sidebar-subtitle]')].filter(vis)
  if (subtitles.length === 0) return null
  const subtitle = subtitles[0]
  const row = subtitle.closest('[data-row-key^="session:"]')
  const chip = subtitle.querySelector('[data-ghp-sidebar-subtitle-chip]')
  const title = subtitle.querySelector('[data-ghp-sidebar-subtitle-title]')
  const style = title === null ? null : getComputedStyle(title)
  // Shipped first-line row title (class token such as "*_title"); exclude our injected nodes.
  const titleCandidates = row === null ? [] : [...row.querySelectorAll('span,div')].filter(el => {
    if (el.closest('[data-ghp-sidebar-subtitle]') !== null) return false
    if (!vis(el)) return false
    return [...el.classList].some(cls => /(?:^|_)title$/iu.test(cls))
  })
  const rowTitle = titleCandidates.sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)[0]
  const rowRect = row === null ? null : row.getBoundingClientRect()
  const subtitleRect = subtitle.getBoundingClientRect()
  return {
    subtitleCount: subtitles.length,
    boundRow: row === null ? null : rowOf(row),
    chipText: chip === null ? '' : (chip.innerText || chip.textContent || '').trim(),
    titleText: title === null ? '' : (title.innerText || title.textContent || '').trim(),
    titleAttr: title === null ? '' : (title.getAttribute('title') || ''),
    rowHeight: rowRect === null ? 0 : Math.round(rowRect.height * 10) / 10,
    rowWidth: rowRect === null ? 0 : Math.round(rowRect.width * 10) / 10,
    subtitleTop: Math.round(subtitleRect.top * 10) / 10,
    subtitleWidth: Math.round(subtitleRect.width * 10) / 10,
    titleBottom: rowTitle === undefined ? null : Math.round(rowTitle.getBoundingClientRect().bottom * 10) / 10,
    whiteSpace: style === null ? null : style.whiteSpace,
    textOverflow: style === null ? null : style.textOverflow,
    overflowing: title === null ? null : title.scrollWidth > title.clientWidth,
    unboundSessionRows: sessionRows.filter(el => el.querySelector('[data-ghp-sidebar-subtitle]') === null).length,
    otherSessionSubtitles: sessionRows.filter(el => el !== row && el.querySelector('[data-ghp-sidebar-subtitle]') !== null).length,
    workspaceRows: workspaceRows.length,
    workspaceSubtitles: workspaceRows.filter(el => el.querySelector('[data-ghp-sidebar-subtitle]') !== null).length,
  }
})()`

/** Wait for the /bindings-poll decorator to inject the sidebar session subtitle. */
async function waitForSidebarSubtitle(cdp, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await cdp.evaluate(SIDEBAR_SUBTITLE_SNAPSHOT).catch(() => null)
    if (last !== null && last.subtitleCount >= 1 && last.chipText.length > 0 && last.titleText.length > 0) return last
    await sleep(150)
  }
  throw new Error(`sidebar session subtitle did not appear within ${timeoutMs}ms (last: ${JSON.stringify(last)})`)
}

await main()
