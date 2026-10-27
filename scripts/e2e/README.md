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
| 7 | `projects-board` | binds `Astropath-issues` (#9) from the picker, then asserts the v1.1 swimlane board under the **v0.3.0 hidden-lane rule**: `[data-ghp-view-mode="board"]`, `[data-ghp-board]`, rendered lane keys a subsequence of `no-status,todo,in-progress,in-review,done` (+ trailing `other:*` only when non-empty), the four non-No-status lanes exactly once in order, `no-status` present iff not listed in `data-ghp-hidden-lanes` (and hidden when its filtered count is 0), every lane `data-ghp-count` == cards in that lane and board total == sum(counts), ≥1 card. Fixture data has a No-status item → 5 lanes + empty hidden list; real Project #9 has none → `data-ghp-hidden-lanes="no-status"` + exactly 4 lanes | `04-projects-board.png` |
| 8 | `projects-list` | `[data-ghp-action="view-list"]` switches to list mode: `[data-ghp-view-mode="list"]`, `[data-ghp-list]`, grouped status sections with rows | `05-projects-list.png` |
| 9 | `projects-milestone` | back to board; `[data-ghp-action="milestone"]` opens the dropdown, options include `all` + `backlog` + a concrete milestone (`v1.2.0` when present), selecting it moves `data-active="true"`, shrinks card counts (and keeps counters consistent); captured with the dropdown open; then reset to `all`, counts restored, dropdown closed | `06-projects-milestone.png` |
| 9b | `projects-wide` | resizes the viewport to 2200×1300 (CDP `Emulation.setDeviceMetricsOverride`), keeps the bound board open and re-validates the hidden-lane rule for the visible lanes, then asserts the page fills the conversation body: `.ghp-page` width ≥ 70% of the window (old 1000px cap ≈ 45%), page left edge < 25% of the window (no centred fixed column), the visible lanes in order share the width (equal ±12px, lane sum ≥85% of board width), ≥1 card; the PNG is asserted to be exactly 2200×1300; viewport restored to 1280×800 for the issue stages | `11-projects-wide.png` (2200×1300) |
| 10 | `issue-empty` | `issue` tab renders the unbound empty state (`为当前会话绑定 Issue`, `从项目选择`, reference input) | `07-issue-empty.png` |
| 11 | `issue-detail` | binds #240 from the projects board card (`[data-ghp-card][data-issue="ceasarXuu/Astropath#240"]`, whole card is the action; ref-paste fallback kept) and asserts the fully loaded detail (meta line `N 条评论`, markdown body, labels, comments) | `08-issue-detail.png` |
| 12 | `console` | zero browser console errors, zero uncaught exceptions, zero plugin HTTP ≥400 responses, zero plugin network failures (warnings are reported, not failed) | — |
| opt | `issue-comments` | only with `--extra-comments`: scrolls the issue view to the bottom and shoots the comments | `09-issue-comments.png` |

Screenshots are 1280×800 viewport PNGs written to
[`artifacts/screenshots/`](../../artifacts/screenshots). Acceptance set:
**01-tabs, 02-projects-empty, 03-projects-picker, 04-projects-board,
05-projects-list, 06-projects-milestone, 07-issue-empty, 08-issue-detail,
11-projects-wide** — the first eight at 1280×800, `11` at **2200×1300** (wide
layout regression) — plus opt-in `09-issue-comments.png` with `--extra-comments`.
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
| `--only=<stage>` | run the stages up to and including `<stage>` (prerequisites included), then stop; the `console` check still runs last. Useful for iterating on one view: `--only=projects-milestone`. Valid stages: `boot`, `app`, `session`, `tabs`, `projects-empty`, `projects-picker`, `projects-board`, `projects-list`, `projects-milestone`, `projects-wide`, `issue-empty`, `issue-detail`, `issue-comments`, `console`. |
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
| `console`: `SyntaxError` from `/plugins/??@local/dsh-github-projects/client.js&rev=...` | `client.js` was being edited **while the run was in flight** (HMR served a half-written bundle). Freeze client.js during a run; re-run. |
| `projects-picker` / `issue-detail`: timeout waiting `ghp-*` content | client view regressed (skeleton never leaves / body never renders); failure dump + screenshot show the state. |
| `boot` in real mode: `gh` unavailable / `gh-auth` | `gh auth status` not valid for the invoking user; fix `gh auth login` or use `--mode fixture`. |

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
- Screenshots are overwritten by the latest run; the artifact set is only
  deterministic when runs are serialized. The harness deletes stale numbered
  state shots from earlier revisions (`failure-*.png`, old `04-projects-list.png`,
  `07-desktop-tabs.png`, …) and regenerates `09-issue-comments.png` (only with
  `--extra-comments`) and `11-projects-wide.png`; `10-desktop-tabs.png` is preserved.
- `02-projects-empty.png` includes the isolated temp workspace path by design
  (the empty state documents which workspace is being bound).

## Current status (2026-10-28) — plugin v0.3.0 final acceptance, client.js frozen

`client.js` frozen at sha256 `813dae78bbd27bdb47218a098dcb8e98df09fbe7c811551005be853c7a8b7a7d`
(mtime 2026-10-28 05:28; v0.3.0 = hidden-empty-No-status lane rule + the
§4.2.0 visual system: status palette, tinted count pills, raised cards on
sunken lanes, hash-colored label/avatar dots, brand accents, full-width layout).
`index.js` ships `export const inject = ['webServer']`.

| Mode | Command | Exit | Run dir | Result |
|---|---|---|---|---|
| fixture | `node scripts/e2e/run.mjs --mode fixture --keep` | `0` (PASS) | `/tmp/dsh-github-projects-e2e/2026-10-27T21-29-15-300Z` | hidden-lane rule: `hidden=""`, 5 lanes `no-status 1 / todo 3 / in-progress 2 / in-review 1 / done 1` (8 == sum); milestone v1.2.0 hides No-status (4 lanes, `todo 0 / in-progress 2 / in-review 1 / done 1`), 8→4→8; wide @2200×1300: 5 lanes `[361.8 ×5]` spread 0, page 86.6% of window, shot exactly 2200×1300; console 0/0/0; shots 01–08 + 11 |
| real (`gh` 2.96.0, `ceasarXuu`, Project #9) | `node scripts/e2e/run.mjs --mode real --keep --extra-comments` | `0` (PASS) | `/tmp/dsh-github-projects-e2e/2026-10-27T21-29-27-351Z` | hidden-lane rule: **`data-ghp-hidden-lanes="no-status"`, exactly 4 lanes `todo 27 / in-progress 1 / in-review 1 / done 166` = 195 cards = sum**; milestone v1.2.0 keeps No-status hidden, 195→19→195; wide @2200×1300: 4 lanes `[454.3 ×4]` spread 0, page 86.6%, 195 cards; issue #240 via card + full detail; console 0/0/0; shots 01–09 + 11 |

Both authoritative runs were sequential against the frozen client;
`artifacts/screenshots/` holds the **real-mode** v0.3.0 set from
`2026-10-27T21-29-27-351Z`.

Final artifact set (`artifacts/screenshots/`):

| File | Source | Size |
|---|---|---|
| `01-tabs.png`, `02-projects-empty.png`, `03-projects-picker.png`, `04-projects-board.png`, `05-projects-list.png`, `06-projects-milestone.png`, `07-issue-empty.png`, `08-issue-detail.png` | harness, authoritative real-host run (v0.3.0 visual system) | 1280×800 |
| `09-issue-comments.png` | harness real-host run `--extra-comments` (opt-in) | 1280×800 |
| `10-desktop-tabs.png` | **manual** Desktop-install evidence (Lead), never written by the harness | full app window |
| `11-projects-wide.png` | harness, `projects-wide` stage (wide-layout + hidden-lane proof) | 2200×1300 |

The light theme was additionally verified manually during the v0.3.0 review
(settings → 浅色; board/list/picker/issue shots rendered correctly via
`color-mix` tints, zero console errors) — the automated harness runs the DSH
default dark theme only.

Earlier v1.x/v0.2.x screenshot numbers are removed automatically as stale
numbered state shots at the start of every run. Older temp run directories under
`/tmp/dsh-github-projects-e2e/` are development history and may be deleted.

## File map

```
scripts/e2e/
  run.mjs              orchestrator: args, stages, JSON lines, screenshots, cleanup
  lib/dsh.mjs          temp layout, overlay generation, `dsh web` spawn/URL/HTTP wait
  lib/browser.mjs      headless Chrome launch, DevToolsActivePort, page target attach
  lib/cdp.mjs          raw-WebSocket CDP client (evaluate/waitFor/screenshot, console capture)
  lib/app.mjs          DSH UI helpers (app shell, dialogs, tabs, composer, buttons)
  lib/mock-llm.mjs     local Anthropic-Messages SSE mock used to start an offline turn
```
