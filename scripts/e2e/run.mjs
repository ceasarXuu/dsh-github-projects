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
  'projects-list',
  'projects-milestone',
  'projects-wide',
  'issue-empty',
  'issue-detail',
  'issue-comments',
  'console',
]

/**
 * Browser console errors that are known-benign in this isolated environment.
 * Keep this list empty unless a real, explained false positive shows up; every
 * entry must be documented in scripts/e2e/README.md.
 * @type {{pattern: RegExp, why: string}[]}
 */
const BENIGN_CONSOLE_ERRORS = []

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

Artifacts: artifacts/screenshots/*.png (01-tabs … 06-issue-detail)
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
    '10-desktop-tabs.png', '11-projects-wide.png',
  ])
  const DERIVED_SHOTS = new Set(['09-issue-comments.png', '11-projects-wide.png'])
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
    if (gated('projects-board')) {
      const projectsBoardOk = await runStage('projects-board', async () => {
        const clicked = await clickTextRow(resources.cdp, 'Astropath-issues')
        assert(clicked, 'could not select the "Astropath-issues" row in the picker')
        // Bound toolbar: project title, item count, view-mode toggle and filter.
        await waitForText(resources.cdp, 'Astropath-issues', { timeoutMs: emitTimeout(30_000) })
        await waitForText(resources.cdp, '解绑', { timeoutMs: emitTimeout(20_000) })
        await waitForText(resources.cdp, '刷新', { timeoutMs: emitTimeout(20_000) })
        await waitForPlugin(`document.querySelectorAll('[class*="ghp-skeleton"]').length === 0`, 'project board loading finished')
        const board = await waitForBoard(resources.cdp, emitTimeout(30_000))
        await settle(400)
        const screenshot = await shot('04-projects-board.png')
        return { screenshot, mode: board.mode, columns: board.columns, cardCount: board.cardCount }
      })
      if (projectsBoardOk === false) throw new Error('projects-board stage failed')
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
        const expectedColumns = ['no-status', 'todo', 'in-progress', 'in-review', 'done']
        assert(
          expectedColumns.every((key, index) => wide.laneKeys[index] === key),
          `wide board lane order is wrong: ${JSON.stringify(wide.laneKeys)}`,
        )
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
          laneKeys: wide.laneKeys,
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

    // ------------------------------------------------------- issue detail --
    let boundIssuePath = null
    if (gated('issue-detail')) {
      const issueDetailOk = await runStage('issue-detail', async () => {
        // Bind #240 from the projects board (the whole card is the action; the
        // plugin switches to the issue view itself).
        assert(await clickTab(resources.cdp, 'projects'), 'could not go back to the "projects" tab')
        await waitForBoard(resources.cdp, emitTimeout(30_000))
        const opened = await openIssueCard(resources.cdp, 'ceasarXuu/Astropath#240')
        if (opened) {
          boundIssuePath = 'projects-card'
        } else {
          // Fallback: paste the issue reference into the issue empty state.
          assert(await clickTab(resources.cdp, 'issue'), 'could not return to the "issue" tab')
          const set = await setByPlaceholder(resources.cdp, '粘贴 Issue 链接或 owner/repo#123', 'ceasarXuu/Astropath#240')
          assert(set, 'issue empty state has no reference input')
          const bound = await clickButton(resources.cdp, { text: '绑定' })
          assert(bound, 'issue empty state has no "绑定" button')
          boundIssuePath = 'issue-ref-paste'
        }
        // The issue view renders the binding summary immediately; wait for the
        // bound detail header (the projects view also contains "#240" on a card).
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
        return { screenshot, bindPath: boundIssuePath }
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
      return {
        consoleErrors: 0,
        exceptions: 0,
        benign: benign.length,
        warnings: consoleWarnings.length,
        warningSamples: consoleWarnings.slice(0, 5).map(warning => clip(warning.text, 200)),
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

/** Wait until the board reaches a coherent state (mode, column order, counters). */
async function waitForBoard(cdp, timeoutMs, { expectedLessThan } = {}) {
  const expectedColumns = ['no-status', 'todo', 'in-progress', 'in-review', 'done']
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
    const keys = last.columns.map(column => column.key)
    const columnsOk = expectedColumns.every((key, index) => keys[index] === key)
    const cardsOk = last.cardCount >= 1
    const consistencyOk = last.cardCount === last.countSum
    const shrinkOk = expectedLessThan === undefined || last.countSum < expectedLessThan
    if (last.mode === 'board' && last.hasBoard && columnsOk && cardsOk && consistencyOk && shrinkOk) return last
    lastProblem = `mode=${JSON.stringify(last.mode)} hasBoard=${last.hasBoard} columns=${JSON.stringify(keys)} cards=${last.cardCount} countSum=${last.countSum}`
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

await main()
