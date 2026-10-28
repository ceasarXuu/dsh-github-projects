# `scripts/e2e` — isolated end-to-end verification for dsh-github-projects

One command boots a throw-away DeepSeek Harness web server, loads this plugin
through a `--patch` overlay, drives **real headless Chrome** through the real UI,
and captures the acceptance screenshots. It never touches the user's `~/.dsh`
profile, the running Desktop app, or port 49342.

```bash
node scripts/e2e/run.mjs --mode fixture        # fixture host (dev/mock-host.js), no gh
node scripts/e2e/run.mjs --mode real --keep    # real host (index.js) against the local, read-only gh CLI
```

Exit code `0` = every executed stage passed (`PASS` on the last line), `1` = a
stage failed (`FAIL`, the failing stage's JSON line carries the evidence).

## What it proves (stages)

The run prints one JSON line per stage: `{"step": "<name>", "ok": true|false, "detail": {...}}`.

| # | Stage | What is asserted | Screenshot |
|---|---|---|---|
| 1 | `boot` | temp DSH_HOME/profile/workspace booted, plugin route answers `/health` (real mode also requires a usable `gh`), headless Chrome navigates and the SPA shell renders | — |
| 2 | `app` | first-run dialogs dismissed (预览版说明/继续, credentials notice), composer focusable | — |
| 3 | `session` | a real turn is sent from the composer and completes (mock model), turning the blank session into a normal conversation | — |
| 4 | `tabs` | session header has exactly the shipped `对话`, `轨迹` **and** the plugin's `projects`, `issue` tabs | `01-tabs.png` |
| 5 | `projects-empty` | `projects` tab renders the unbound empty state (`绑定 GitHub Project`, `选择 Project`) | `02-projects-empty.png` |
| 6 | `projects-picker` | picker opens, renders project rows + manual binding row, loading finished | `03-projects-picker.png` |
| 7 | `projects-board` | binds `Astropath-issues` (#9) from the picker, then asserts the v1.1 swimlane board under the **v0.3.0 hidden-lane rule**: `[data-ghp-view-mode="board"]`, `[data-ghp-board]`, rendered lane keys a subsequence of `no-status,todo,in-progress,in-review,done` (+ trailing `other:*` only when non-empty), the four non-No-status lanes exactly once in order, `no-status` present iff not listed in `data-ghp-hidden-lanes` (and hidden when its filtered count is 0), every lane `data-ghp-count` == cards in that lane and board total == sum(counts), ≥1 card. Fixture data has a No-status item → 5 lanes + empty hidden list; real Project #9 has none → `data-ghp-hidden-lanes="no-status"` + exactly 4 lanes. Also logs the **cold board duration** (`coldBoardMs`, picker-select → board ready) and asserts no session subtitle exists before any bind | `04-projects-board.png` |
| 8 | `projects-external-open` | **v1.0.1**: stubs `window.open` in the page, clicks the Issue card body (`[data-ghp-card-action="open"]`) and asserts the system-browser path — exactly one call with the Issue URL `https://github.com/ceasarXuu/Astropath/issues/240`, target `_blank`, features containing `noopener,noreferrer`; asserts **no** `[data-sidebar-browser-frame]` and no dockkit browser tab were created, **no binding** was made (no header subtitle) and the projects board stayed mounted; `12-external-open.png`. The overlay no longer enables `ui-sidebar-browser` and no `X-Frame-Options` console allowlist is needed (the page is never embedded) | `12-external-open.png` |
| 9 | `projects-list` | `[data-ghp-action="view-list"]` switches to list mode: `[data-ghp-view-mode="list"]`, `[data-ghp-list]`, grouped status sections with rows | `05-projects-list.png` |
| 10 | `projects-milestone` | back to board; `[data-ghp-action="milestone"]` opens the dropdown, options include `all` + `backlog` + a concrete milestone (`v1.2.0` when present), selecting it moves `data-active="true"`, shrinks card counts (and keeps counters consistent); captured with the dropdown open; then reset to `all`, counts restored, dropdown closed | `06-projects-milestone.png` |
| 10b | `projects-wide` | resizes the viewport to 2200×1300 (CDP `Emulation.setDeviceMetricsOverride`), keeps the bound board open and re-validates the hidden-lane rule for the visible lanes, then asserts the page fills the conversation body: `.ghp-page` width ≥ 70% of the window (old 1000px cap ≈ 45%), page left edge < 25% of the window (no centred fixed column), the visible lanes in order share the width (equal ±12px, lane sum ≥85% of board width), ≥1 card; the PNG is asserted to be exactly 2200×1300; viewport restored to 1280×800 for the issue stages | `11-projects-wide.png` (2200×1300) |
| 11 | `issue-empty` | `issue` tab renders the unbound empty state (`为当前会话绑定 Issue`, `从项目选择`, reference input) | `07-issue-empty.png` |
| 12 | `issue-bind-subtitle` | **v0.4.0**: clicks the explicit `[data-ghp-card-action="bind"]` button on the #240 card (asserts it does **not** open the browser), asserts the client switches to the `issue` view, and that the session header subtitle (§4.5) appears: `[data-ghp-session-subtitle]` with `[data-ghp-subtitle-chip]` text `#240`, non-empty `[data-ghp-subtitle-title]` whose `title` attribute carries the full issue title, inside `header[data-window-drag]`, single-line (`nowrap`/height ≤26px) and ellipsised (`text-overflow: ellipsis` or scrollWidth > clientWidth) | `13-issue-subtitle.png` |
| 13 | `issue-detail` | already on the bound `issue` view after the bind action; asserts the fully loaded detail (meta line `N 条评论`, markdown body, labels, comments) | `08-issue-detail.png` |
| opt | `issue-comments` | only with `--extra-comments`: scrolls the issue view to the bottom and shoots the comments | `09-issue-comments.png` |
| 14 | `sidebar-subtitle` | **v1.0.1 §4.6**: with the session still bound to #240, waits up to 6 s for the left-sidebar decorator (module-level binding map from `GET /bindings`, SWR poll ≈4 s) to inject the row subtitle: exactly one `[data-ghp-sidebar-subtitle]` — a plain **`span`, not a button** — inside the bound `[data-row-key^="session:"]` row, chip `#240`, full `repo#N title` in the `title` attribute, row ≥ 40px, subtitle below the row title; **no horizontal overflow** (subtitle right ≤ row content right, row and sidebar tree/list `scrollWidth ≤ clientWidth + 1` — the stray-scrollbar user bug); **non-interactive click behavior**: a real mouse click at the subtitle coordinates must not call `window.open`, must not navigate (`location.href` unchanged) and must keep the same session row selected and the current issue view open (the shipped row `onOpen` is a no-op for the already-selected session; Lead confirmed `对话` must not be required there); then the stage returns to the `issue` view for the whole-window screenshot | `14-sidebar-subtitle.png` |
| 15 | `projects-warm` | **v0.4.0 §3.5**: switches to `对话` and back to `projects`, measures until the cached `[data-ghp-view-mode="board"]`/`[data-ghp-board]` renders with **no** `[class*="ghp-skeleton"]`; asserts ≤ **1500 ms** and that no cold skeleton was ever rendered (module-level SWR cache hit), and logs the cold duration from `projects-board` (`coldBoardMs`) alongside `warmMs` | — |
| 16 | `console` | zero browser console errors, zero uncaught exceptions, zero plugin HTTP ≥400 responses, zero plugin network failures (warnings are reported, not failed; the benign-error allowlist is **empty** in v1.0.1 because GitHub pages are no longer embedded). The stage also asserts a boolean `stale` on every 2xx `/projects`, `/items`, `/issue` response and logs per-request host timings | — |

Screenshots are 1280×800 viewport PNGs written to
[`artifacts/screenshots/`](../../artifacts/screenshots). Acceptance set:
**01-tabs, 02-projects-empty, 03-projects-picker, 04-projects-board,
05-projects-list, 06-projects-milestone, 07-issue-empty, 08-issue-detail,
11-projects-wide, 12-external-open, 13-issue-subtitle,
14-sidebar-subtitle** — 01–09 at 1280×800 (09 opt-in), `11` at **2200×1300**
(wide layout), `12` is the system-browser (`window.open`) open state, `13` is the session-header
issue subtitle, `14` is the left-sidebar session-row subtitle (whole window). The
sidebar decoration is driven by `GET /bindings` (local state only, SWR poll ≈4 s),
so the stage waits up to 6 s for the injected row after the bind action.
`15-published-install.png` is produced by the separate post-publish
`release-smoke.mjs` gate (registry install in a clean profile), not by `run.mjs`.
Board screenshots reflect the v0.3.0 hidden-empty-No-status rule: fixture mode
shows five lanes, real Project #9 shows four lanes with
`data-ghp-hidden-lanes="no-status"`.
`10-desktop-tabs.png` is **not** produced by this harness: it is the manual
evidence from the user's installed Desktop app (full-window screenshot of a real
session header showing `对话 | 轨迹 | projects | issue`). The harness deletes stale
numbered shots from earlier runs (and `09` unless `--extra-comments`) so the
artifact directory matches the current numbering.

## Options

| Option | Meaning |
|---|---|
| `--mode=fixture\|real` | host half under test. `fixture` mounts [`dev/mock-host.js`](../../dev/mock-host.js) (contract-shaped data from `test/fixtures/`, in-memory bindings, **no network, no gh**). `real` mounts [`index.js`](../../index.js) (real `gh`, read-only). Default `fixture`. |
| `--keep` | keep the temp run directory (`home/`, `workspace/`, `documents/`, `logs/`, `chrome-profile/`). A failing run is kept even without this flag. |
| `--only=<stage>` | run the stages up to and including `<stage>` (prerequisites included), then stop; the `console` check still runs last. Useful for iterating on one view: `--only=projects-milestone`. Valid stages: `boot`, `app`, `session`, `tabs`, `projects-empty`, `projects-picker`, `projects-board`, `projects-external-open`, `projects-list`, `projects-milestone`, `projects-wide`, `issue-empty`, `issue-bind-subtitle`, `issue-detail`, `issue-comments`, `sidebar-subtitle`, `projects-warm`, `console`. |
| `--headful` | run Chrome with a visible window (local debugging; default is `--headless=new`). |
| `--extra-comments` | also capture `09-issue-comments.png`. |
| `--timeout-scale=<n>` | multiply every stage timeout (slow machines: `1.5`). Default `1`. |
| `-h`, `--help` | usage. |

## Prerequisites

- macOS with the installed app (validated against **DeepSeek Harness 0.2.1-rc.3**):
  - CLI: `/Applications/DeepSeek Harness 2.app/Contents/Resources/runtime/cli/bin/dsh`
  - Chrome: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` (v156)
- Node.js ≥ 22 (validated on Node 24; the harness uses the global `WebSocket`/`fetch` and `node:*` only — no npm dependencies).
- `--mode real` additionally needs the GitHub CLI (`gh` ≥ 2.4, `gh auth login`
  completed; validated with `gh` 2.96.0, account `ceasarXuu`). All `gh` use is
  read-only (`gh api user`, `gh api user/orgs`, `gh project list`,
  `gh project item-list`, `gh api repos/.../issues/...`).

## Isolation (what the run creates and why)

Per run: `/tmp/dsh-github-projects-e2e/<timestamp>/`

```
home/       DSH_HOME for the child `dsh web` (fresh profile, never ~/.dsh)
workspace/  cwd of the child `dsh web`
documents/  Documents-directory override: the auto-created first-use workspace
            is <documents>/deepseek-harness/default-workspace, i.e. inside the temp root
logs/       dsh.log, chrome.log, failure-<stage>-ui.json, summary.json
overlay.yml the --patch overlay used for this run
chrome-profile/  throw-away Chrome --user-data-dir (deleted on cleanup success)
```

The boot command is equivalent to:

```bash
DSH_HOME=<run>/home DEEPSEEK_API_KEY=sk-e2e-mock DEEPSEEK_BASE_URL=http://127.0.0.1:<mock>/anthropic \
  "<dsh>" --profile web --patch <run>/overlay.yml --no-open --port 0
# cwd=<run>/workspace; the printed `dsh web: http://127.0.0.1:<port>/?token=...` is parsed
```

`overlay.yml` (generated) contains two things:

```yaml
- id: workspace-controller            # keep the first-use workspace inside the temp root
  config:
    documentsDirectory: '<run>/documents'
- insert:
    - id: github-projects
      name: '<absolute path of dev/mock-host.js or index.js>'
      inject: ['webServer']          # belt-and-braces: defer the row until webServer exists
```

All child processes are started detached and killed (TERM then KILL on the
process group) in a `finally` block; ports are chosen by the OS (`--port 0` for
the server, `--remote-debugging-port=0` + `DevToolsActivePort` for Chrome).

### Why a mock model server

The shipped conversation header only renders its view tabs once the session is
non-blank, and a fresh isolated profile has no model credentials. The harness
therefore starts a tiny loopback Anthropic-Messages-compatible SSE server
([`lib/mock-llm.mjs`](./lib/mock-llm.mjs)) and points the provider route at it
via `DEEPSEEK_API_KEY`/`DEEPSEEK_BASE_URL` **in the child dsh environment only**.
One composer message produces one real turn and a short assistant reply: fully
offline, deterministic, no credentials, no external network. It does not touch
the product code under test; it only satisfies DSH's "conversation started"
condition. (The model answer text is `e2e: mock assistant reply.`.)

## Failure inspection

- A failed run prints the failing stage's JSON line with `error`, the last 1200
  chars of page `bodyText`, visible tabs/buttons, dialog texts, console
  errors/exceptions observed so far, `dshLogTail`, and paths. The run directory is
  always kept on failure.
- `logs/failure-<stage>-ui.json` — full UI snapshot at the failure (buttons with
  aria labels, tabs and their selected state, editables, `ghp-*` nodes, dialogs).
- `artifacts/screenshots/failure-<stage>.png` — viewport screenshot at the
  failure (deleted at the next run's start).
- `logs/dsh.log` — host stdout/stderr (includes any plugin activation error).
  `logs/chrome.log` — Chrome stderr.
- `logs/summary.json` — machine-readable run summary (mode, ok, failures,
  screenshot paths, run dir).

Common failures:

| Symptom | Likely cause |
|---|---|
| `boot`: `plugin host /health did not answer` | host plugin row not mounted: a bare overlay row activates before the `webServer` service; the overlay sets `inject: ['webServer']` (and shipped `index.js`/`dev/mock-host.js` also export `inject` — keep both). |
| `boot`: `client bundle not found` / startup failure `1 required plugin did not activate` | `client.js` missing or syntactically broken at boot time. |
| `session`: composer not focusable / `conversation UI not ready` | first-run dialog still up (unknown dialog text), or app boot slower than the timeout (`--timeout-scale=1.5`). |
| `tabs`: missing `projects`/`issue` | `client.js` failed to load/apply; check `console` line and `failure-tabs.png`. |
| `console`: `SyntaxError` from `/plugins/??@ceasarxuu/dsh-github-projects/client.js&rev=...` | `client.js` was being edited **while the run was in flight** (HMR served a half-written bundle). Freeze client.js during a run; re-run. |
| `projects-picker` / `issue-detail`: timeout waiting `ghp-*` content | client view regressed (skeleton never leaves / body never renders); failure dump + screenshot show the state. |
| `boot` in real mode: `gh` unavailable / `gh-auth` | `gh auth status` not valid for the invoking user; fix `gh auth login` or use `--mode fixture`. |

## Release gate: published-install smoke (`release-smoke.mjs`)

`run.mjs` deliberately loads the plugin through a `--patch` overlay from this
checkout. For a release, the plugin must also be proven as a **published npm
package**: [`release-smoke.mjs`](./release-smoke.mjs) installs it from the
registry into a throw-away profile and boots `dsh web` from that profile.

```bash
# after `npm publish` (clean temp DSH_HOME created by the script)
node scripts/e2e/release-smoke.mjs --spec=@ceasarxuu/dsh-github-projects@1.0.0
# offline rehearsal with a local tarball / pre-existing temp home
node scripts/e2e/release-smoke.mjs --spec=/abs/path/pkg.tgz
node scripts/e2e/release-smoke.mjs --skip-install --home=/tmp/existing-home
```

What it does, as JSON-line steps then PASS/FAIL:
1. `install` — `dsh plugin --profile <p> add <spec>` in a temp `DSH_HOME`
   (default profile `web`), asserting the output names the package/version;
2. `profile` — `<home>/profiles/<p>/package.json` has `dsh.profile.bundles`
   containing `@ceasarxuu/dsh-github-projects` and the dependency pins the
   expected version;
3. `boot` — boots `dsh web` **without any overlay** from that profile and asserts
   `/plugin/github-projects/health` answers 200 with the contract shape;
4. `tabs` — clean profile: creates a session through the composer (offline mock
   model, same as `run.mjs`) and asserts the header tabs `对话`, `轨迹`,
   `projects`, `issue` exist, then captures
   [`artifacts/screenshots/15-published-install.png`](../../artifacts/screenshots);
5. `console` — zero unexpected browser console errors/exceptions and no plugin
   HTTP errors in the clean profile.

Options: `--spec=`, `--expected-version=`, `--profile=`, `--home=`,
`--skip-install`, `--screenshot=`, `--keep`. Temp run directories live under
`/tmp/dsh-github-projects-release-smoke/<timestamp>/` (kept on failure /
`--keep`). `15-published-install.png` is release-gate evidence: it is **not**
written by `run.mjs` and is preserved by its artifact cleanup.

## Known-benign console errors

The `console` stage fails on every unexpected console error/exception. The
allowlist (`run.mjs` → `BENIGN_CONSOLE_ERRORS`) is **empty** in v1.0.1: the
plugin no longer embeds GitHub in an iframe (card/subtitle clicks call
`window.open(url, '_blank', 'noopener,noreferrer')` for the system browser), so
the previous github.com `X-Frame-Options` refusal no longer occurs.

## Known limitations / flakiness

- Runs must not overlap: the harness writes fixed screenshot names under
  `artifacts/screenshots/` and each run should own its temp dir. Run one at a
  time (fixture and real runs included).
- Do not edit `client.js` (or restart/move the installed app) while a run is in
  flight; the client bundle is served live and HMR reloads mid-run can flake the
  `issue-detail` stage. The harness fails fast and dumps the exception instead of
  hiding it.
- The fresh profile always shows the 预览版说明 preview notice once; the harness
  dismisses it (recorded in the `app` stage `dismissed` field).
- `--mode real` performs only read calls, but rate limits / a temporary GitHub
  failure can still fail a stage; re-run or fall back to `--mode fixture`.
- The sidebar session-row subtitle is injected by a guarded DOM decorator driven
  by `GET /bindings` (SWR poll ≈4 s plus an immediate `binding-changed` refresh);
  the stage waits up to 6 s after a bind. If the sidebar row anchors ever change,
  the feature degrades to no subtitle (the stage then fails with the last snapshot).
- Card-body / subtitle clicks open the Issue in the **system browser** via
  `window.open(url, '_blank', 'noopener,noreferrer')`. Headless Chrome cannot
  present a system browser, so the `projects-external-open` stage stubs
  `window.open` in the page and asserts the exact call (URL/target/features); the
  pointer-click path in `sidebar-subtitle` asserts no call is made at all.

## Current status (2026-10-28) — plugin v1.0.1 acceptance

Inputs used for the authoritative pair: `client.js` sha256
`e6a3b2c963005f41cce8f383b86a0228dea54becabd11471333e5dd46dc113de`
(v1.0.1: card/subtitle clicks open the **system browser** via
`window.open(url, '_blank', 'noopener,noreferrer')`; sidebar subtitle is a
non-interactive `span` without overflow), `package.json` version
**1.0.1** (`@ceasarxuu/dsh-github-projects`), host halves unchanged from
v0.4.1 (`index.js b52964f7…`, `github.js a4d279f9…`, `state.js 484af66b…`).

| Mode | Command | Exit | Run dir |
|---|---|---|---|
| fixture | `node scripts/e2e/run.mjs --mode fixture --keep` | `0` (PASS) | `/tmp/dsh-github-projects-e2e/2026-10-28T01-03-02-918Z` |
| real (`gh` 2.96.0, `ceasarXuu`, Project #9) | `node scripts/e2e/run.mjs --mode real --keep --extra-comments` | `0` (PASS) | `/tmp/dsh-github-projects-e2e/2026-10-28T01-03-18-830Z` |

17/17 executed stages in fixture mode (issue-comments is opt-in), 18/18 in real
mode; console **0 errors / 0 exceptions / 0 warnings** (allowlist empty).

v1.0.1 evidence (fixture → real, identical):
- `projects-external-open` (`12-external-open.png`): clicking the Issue card body
  produced exactly one stubbed `window.open` call —
  `https://github.com/ceasarXuu/Astropath/issues/240`, target `_blank`, features
  `noopener,noreferrer`; **no** `[data-sidebar-browser-frame]`, **no** dockkit
  browser tab, **no** binding (header subtitle absent) and the projects board
  stayed mounted. The `ui-sidebar-browser` overlay enablement and the
  `X-Frame-Options` console allowlist are gone.
- `sidebar-subtitle` (`14-sidebar-subtitle.png`): `[data-ghp-sidebar-subtitle]` is
  a plain **`span`**; row height 41 px, subtitle below the row title
  (`342 ≥ 340 − 2`), chip `#240`, full `repo#N title` in the `title` attribute;
  **no overflow** — subtitle right 260 ≤ row content right 260, row
  `scrollWidth/clientWidth` 256/256, sidebar tree/list 265/265 (the v1.0.1
  stray-scrollbar bug is gone). A real mouse click at the subtitle coordinates
  made **0** `window.open` calls, did not navigate (`location.href` unchanged),
  kept the same session row selected and the current issue view open (shipped row
  `onOpen` is a no-op for the already-selected session — Lead confirmed the
  harness must not require `对话` there).
- Header subtitle (13) unchanged: chip `#240`, own row above tabs
  (`bottom 61 ≤ tabs.top 71`), left-aligned with the session title (x 300).
- Latency: cold board 319 ms → 3804 ms (logged), warm re-open **16 ms → 59 ms**,
  `skeletonSeen:false`; wide 2200×1300 page 86.6% of window; real board 196 items
  (`data-ghp-hidden-lanes="no-status"`, TODO 27 / In Progress 2 / In Review 1 /
  Done 166); boolean `stale` on every 2xx `/projects`, `/items`, `/issue`
  (4 fixture / 7 real, 0 missing).

Final artifact set (`artifacts/screenshots/`, 15 files):

| File | Source | Size |
|---|---|---|
| `01-tabs.png` … `09-issue-comments.png` | `run.mjs` authoritative real run (09 opt-in) | 1280×800 |
| `10-desktop-tabs.png` | **manual** Desktop-app evidence (Lead), never harness-written | full app window |
| `11-projects-wide.png` | `run.mjs`, `projects-wide` | 2200×1300 |
| `12-external-open.png` | `run.mjs`, `projects-external-open` (system-browser open) | 1280×800 |
| `13-issue-subtitle.png` | `run.mjs`, `issue-bind-subtitle` | 1280×800 |
| `14-sidebar-subtitle.png` | `run.mjs`, `sidebar-subtitle` | 1280×800 |
| `15-published-install.png` | `release-smoke.mjs`, clean-profile **registry** install. Currently the 1.0.0 publish; after the 1.0.1 publish the gate is rerun with `--spec=@ceasarxuu/dsh-github-projects@1.0.1` and this file is overwritten | 1280×800 |

### Publishing gate

- **v1.0.0** publish: registry metadata verified (`1.0.0`, public), clean-profile
  `release-smoke` PASS, screenshot `15-published-install.png`.
- **v1.0.1** publish (PASS): registry `dist-tags.latest = 1.0.1`, versions
  `[0.0.0-stage, 1.0.0, 1.0.1]`, public, tarball
  `https://registry.npmjs.org/@ceasarxuu/dsh-github-projects/-/dsh-github-projects-1.0.1.tgz`,
  integrity `sha512-K8hCsCrNj72fYm5cXriKsqBopaxiWZJ0F3xxZwEs590vGJ2140o5saZs0nSLUhzAbeB57Hz15STRgf904LK3pA==`.
  `node scripts/e2e/release-smoke.mjs --spec=@ceasarxuu/dsh-github-projects@1.0.1 --keep`
  → **EXIT 0 / PASS**, run dir
  `/tmp/dsh-github-projects-release-smoke/2026-10-28T01-07-11-757Z`:
  - install output `+ @ceasarxuu/dsh-github-projects 1.0.1`; pnpm-lock resolution
    integrity equals the registry `dist.integrity`; installed `client.js` sha
    `e6a3b2c9…` matches this checkout;
  - `dsh.profile.bundles` = `["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","@ceasarxuu/dsh-github-projects"]`,
    dependency `1.0.1`;
  - boot from the installed profile (no overlay): `/plugin/github-projects/health`
    200 (`gh 2.96.0`, `ceasarXuu`); clean-profile tabs
    `对话 | 轨迹 | projects | issue`; console 0 errors / 0 exceptions /
    0 warnings;
  - `15-published-install.png` overwritten with the 1.0.1 clean-profile shot
    (sha256 `2352994a1dfa6bf7e3d95a755d15bee31f0805f7290c50cdaf9c61eda07c672a`);
  - registry tarball (`npm pack …@1.0.1 --dry-run`): **14 files / 149 KB** incl.
    `client.js`, `cordis.patch.yml`, `locale/en.json`, `locale/zh.json`,
    `LICENSE`, `index.js`, `github.js`, `state.js`, `package.json`, READMEs,
    `CHANGELOG.md`, `icon.svg`, `docs/DESIGN.zh.md`.

Earlier screenshot numbers from previous versions are removed automatically as
stale numbered state shots at the start of every `run.mjs` run; `10` and `15` are
preserved by that cleanup. Older temp run directories under
`/tmp/dsh-github-projects-e2e/` and `/tmp/dsh-github-projects-release-smoke/` are
development/release history and may be deleted.

## File map

```
scripts/e2e/
  run.mjs              orchestrator: args, stages, JSON lines, screenshots, cleanup
  lib/dsh.mjs          temp layout, overlay generation, `dsh web` spawn/URL/HTTP wait
  lib/browser.mjs      headless Chrome launch, DevToolsActivePort, page target attach
  lib/cdp.mjs          raw-WebSocket CDP client (evaluate/waitFor/screenshot, console capture)
  lib/app.mjs          DSH UI helpers (app shell, dialogs, tabs, composer, buttons)
  lib/mock-llm.mjs     local Anthropic-Messages SSE mock used to start an offline turn
  release-smoke.mjs    post-publish gate: install from npm into a temp profile,
                       boot `dsh web` from it, assert /health + tabs, capture 15
```
