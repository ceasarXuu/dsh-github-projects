# `scripts/e2e` — isolated end-to-end verification for dsh-github-projects

One command boots a throw-away DeepSeek Harness web server, loads this plugin
through a `--patch` overlay, drives **real headless Chrome** through the real UI,
and captures the acceptance screenshots. It never touches the user's `~/.dsh`
profile, the running Desktop app, or the Desktop app's port (61670).

```bash
node scripts/e2e/run.mjs --mode fixture        # fixture host (dev/mock-host.js), no gh
node scripts/e2e/run.mjs --mode real --keep    # real host (index.js) against the local, read-only gh CLI
```

Exit code `0` = every executed stage passed (`PASS` on the last line), `1` = a
stage failed (`FAIL`, the failing stage's JSON line carries the evidence).

## v1.0.2 UI under test

The plugin no longer ships a `projects` conversation view tab. The project board
is a **DSH right-sidebar custom tab** (`项目`) opened from a small board icon
injected into the left-sidebar workspace row:

- entry icon: `[data-ghp-workspace-entry]` inside a
  `[data-row-key^="workspace:"]` row (it carries
  `data-ghp-workspace-entry-bound="0|1"`; the click calls `stopPropagation`);
- pane body: `.ghp-sidebar-project[data-ghp-sidebar-project=<workspaceId>]`,
  which hosts the unchanged `ProjectsView` (`[data-ghp-view-mode]`,
  `[data-ghp-board]`, `[data-ghp-list]`, `[data-ghp-column]`,
  `[data-ghp-card]`, `[data-ghp-action]`, milestone hooks);
- the project picker (`.ghp-picker`, `[class*="ghp-picker-row"]`) renders
  **inside that pane**;
- an Issue is still bound from the board's `[data-ghp-card-action="bind"]` and
  shown in the `issue` conversation tab (the session-header subtitle §4.5 and
  left-sidebar session subtitle §4.6 are unchanged).

The right sidebar can be collapsed (`收起右侧边栏` / `打开右侧边栏`), the pane can
be maximized with the shipped `全屏` control, and the project tab is a normal
dockkit tab (context menu → 关闭).

## v1.1.0 write path under test (opt-in, `allowWrites`)

The host config `allowWrites` defaults to **false** (CONTRACT §3.0): the board is
read-only, exactly one `[data-ghp-board-readonly]` hint (`只读看板…`) renders in
the toolbar, cards are not `draggable`, no `[data-ghp-card-action="move"]` /
`[data-ghp-move-menu]` exists, no lane is a `[data-ghp-lane-drop]` target, the
client never calls `/project-meta`, and `POST /item-status` is refused with
403 `writes-disabled` (the `github_project_item_status` tool is not registered).

With `allowWrites: true` (exercised only by the fixture write stack) the client
exposes the §4.8 hooks:

- `[data-ghp-card][data-ghp-card-id]` with `draggable="true"` and
  `[data-ghp-drag-handle]`;
- `[data-ghp-card-action="move"]` → portal'd `[data-ghp-move-menu]` listing every
  Status option plus `No status` as `[data-ghp-move-option="<optionId|clear>"]`
  (the current option carries `data-active="true"`);
- canonical `[data-ghp-lane][data-ghp-lane-key]` lanes carry
  `data-ghp-lane-drop="1"` (`other:*` custom-status lanes stay read-only);
- optimistic lane repaint, `POST /item-status` body
  `{owner, number, itemId, optionId}` (`optionId: null` clears the Status),
  success toast `[data-ghp-toast="success"]` + `[data-ghp-toast-action="undo"]`,
  failure rollback with `[data-ghp-toast="error"]`.

Fixture Status option ids (captured fixture, `test/fixtures/graphql-project-meta.json`):
TODO `8fc1d6c9`, In Progress `47fc9ee4`, In Review `edd18149`, Done `98236657`.
The fixture write stage moves `PVTI_lAHOAwDbXM4Bocj3zhDFe-U` (#246, TODO).

Mock-only assertion aid (dev/mock-host.js, not part of the shipped contract):

```
GET /plugin/github-projects/mock-state
{ allowWrites, writes: [{ at, owner, number, itemId, optionId, name?, ok, code? }],
  statuses: { [itemId]: name|null }, failureItem: { id, title, number } }
```

`PVTI_mock_write_failure` (#9005, title `[mock] 写入失败条目（e2e 回滚验证）`,
status TODO) is the deterministic failure item: its `POST /item-status` always
answers 502 `gh-failed` and never changes the in-memory status.

## What it proves (stages)

The run prints one JSON line per stage: `{"step": "<name>", "ok": true|false, "detail": {...}}`.

| # | Stage | What is asserted | Screenshot |
|---|---|---|---|
| 1 | `boot` | temp DSH_HOME/profile/workspace booted, plugin route answers `/health` (real mode also requires a usable `gh`), headless Chrome navigates and the SPA shell renders | — |
| 2 | `app` | first-run dialogs dismissed (预览版说明/继续, credentials notice), composer focusable | — |
| 3 | `session` | a real turn is sent from the composer and completes (mock model), turning the blank session into a normal conversation | — |
| 4 | `tabs` | session header has the shipped `对话`, `轨迹` **and** the plugin's `issue` tab, the removed `projects` conversation tab is **absent**, the left-sidebar workspace row exposes the visible `[data-ghp-workspace-entry]` board icon (`aria-label="打开 GitHub Project"`, `data-ghp-workspace-entry-bound="0"`) and no right-sidebar pane is open yet; records the `workspaceId` from the row key for later stages | `01-tabs.png` |
| 5 | `projects-empty` | clicking the workspace-row board icon opens the keyed right-sidebar pane `.ghp-sidebar-project[data-ghp-sidebar-project=<workspaceId>]` (dockkit tab `项目`) and renders the unbound empty state (`绑定 GitHub Project`, `选择 Project`) inside it | `02-projects-empty.png` |
| 6 | `projects-picker` | `选择 Project` opens the picker **inside the sidebar pane**; project rows render, the loading state finished, `web-issues` is listed | `03-projects-picker.png` |
| 7 | `projects-board` | binds `web-issues` (#9) from the picker, then asserts the board is mounted **inside** the pane (`.ghp-sidebar-project [data-ghp-board]`, workspace icon now `bound="1"`), under the **v0.3.0 hidden-lane rule**: `[data-ghp-view-mode="board"]`, `[data-ghp-board]`, rendered lane keys a subsequence of `no-status,todo,in-progress,in-review,done` (+ trailing `other:*` only when non-empty), the four non-No-status lanes exactly once in order, `no-status` present iff not listed in `data-ghp-hidden-lanes` (and hidden when its filtered count is 0), every lane `data-ghp-count` == cards in that lane and board total == sum(counts), ≥1 card. Fixture data has a No-status item → 5 lanes + empty hidden list; real Project #9 has none → `data-ghp-hidden-lanes="no-status"` + exactly 4 lanes. Also logs the **cold board duration** (`coldBoardMs`) and asserts no session subtitle exists before any bind | `04-projects-board.png` |
| 7b | `projects-read-only` | **v1.1.0 §4.8** default config, asserted in **both** modes: board open, `/config.writes.allowed === false`, no `draggable` card / `[data-ghp-drag-handle]` / `[data-ghp-card-action="move"]` / `[data-ghp-move-menu]` / `[data-ghp-lane-drop]` target, exactly one `[data-ghp-board-readonly]` hint, **zero** `/project-meta` requests; a direct page-context `POST /item-status` is refused with **403 `writes-disabled`** (exactly one response, never 2xx). Real mode therefore performs zero GitHub writes — the `console` stage allowlists exactly this one probe and still fails on every other ≥400 | — (hint visible in `04-projects-board.png`) |
| 8 | `projects-external-open` | **v1.0.1**: stubs `window.open` in the page, clicks the Issue card body (`[data-ghp-card-action="open"]`) and asserts the system-browser path — exactly one call with the Issue URL `https://github.com/acme/web/issues/240`, target `_blank`, features containing `noopener,noreferrer`; asserts **no** `[data-sidebar-browser-frame]` and no dockkit browser tab were created, **no binding** was made (no header subtitle) and the board stayed mounted **inside the sidebar pane** | `12-external-open.png` |
| 9 | `projects-list` | `[data-ghp-action="view-list"]` switches to list mode inside the pane: `[data-ghp-view-mode="list"]`, `[data-ghp-list]`, grouped status sections with rows | `05-projects-list.png` |
| 10 | `projects-milestone` | back to board; `[data-ghp-action="milestone"]` opens the dropdown, options include `all` + `backlog` + a concrete milestone (`v1.2.0` when present), selecting it moves `data-active="true"`, shrinks card counts (and keeps counters consistent); captured with the dropdown open; then reset to `all`, counts restored, dropdown closed | `06-projects-milestone.png` |
| 10b | `projects-wide` | resizes the viewport to 2200×1300 (`Emulation.setDeviceMetricsOverride`), maximizes the right-sidebar pane through the shipped `全屏` control, and asserts the v1.1.1 layout contract **inside the maximized pane**: pane ≥ 90% of the window, `.ghp-page` ≥ 90% of the pane width and left-aligned (no centred 1000px cap), visible lanes in order share the board width (equal ±12px, lane sum ≥85%), hidden-lane rule re-checked at the wide viewport, ≥1 card; the PNG is asserted to be exactly 2200×1300. Then exits fullscreen, restores 1280×800, re-checks the pane shrank back and collapses the right sidebar for the issue stages | `11-projects-wide.png` (2200×1300) |
| 11 | `issue-empty` | `issue` tab renders the unbound empty state (`为当前会话绑定 Issue`, `从项目选择`, reference input) | `07-issue-empty.png` |
| 12 | `issue-bind-subtitle` | **v0.4.0**: opens the right-sidebar board from the workspace icon and clicks the explicit `[data-ghp-card-action="bind"]` button on the #240 card (asserts it does **not** open the browser), asserts the `issue` view stays the active conversation tab (a sidebar bind does not change the conversation view), and that the session header subtitle (§4.5) appears: `[data-ghp-session-subtitle]` with `[data-ghp-subtitle-chip]` text `#240`, non-empty `[data-ghp-subtitle-title]` whose `title` attribute carries the full issue title, inside `header[data-window-drag]`, single-line (`nowrap`/height ≤26px) and ellipsised (`text-overflow: ellipsis` or scrollWidth > clientWidth); the sidebar is collapsed again before the shot | `13-issue-subtitle.png` |
| 13 | `issue-detail` | already on the bound `issue` view after the bind action; asserts the fully loaded detail (meta line `N 条评论`, markdown body, labels, comments) | `08-issue-detail.png` |
| opt | `issue-comments` | only with `--extra-comments`: scrolls the issue view to the bottom and shoots the comments | `09-issue-comments.png` |
| 14b | `workspace-branch` | **v1.2.0 §4.9**: waits up to 20 s for the workspace-row chip injected from the polled `GET /branches` map, then asserts at least one visible `[data-ghp-workspace-branch]`; the chip is a plain **`span`, not a button**; its text is non-empty and its `title` tooltip is set; `data-ghp-workspace-branch-detached` is `0|1`; **placement**: the chip sits on the **same line** as the workspace name (chip top < title bottom — it must not stack under it), starts at/after the title text's right edge, stays inside the row's content box, and neither the row nor the sidebar tree gains a horizontal scrollbar (`scrollWidth ≤ clientWidth + 1`). Fixture mode's mock host serves `main` / `feat/left-sidebar-branch` / a detached HEAD across bound workspaces; `MOCK_BRANCHES="<id>=<branch>,<id>=detached,<id>=!norepo"` overrides | `17-workspace-branch.png` |
| 14 | `sidebar-subtitle` | **v1.0.1 §4.6**: with the session still bound to #240, waits up to 6 s for the left-sidebar decorator (module-level binding map from `GET /bindings`, SWR poll ≈4 s) to inject the row subtitle: exactly one `[data-ghp-sidebar-subtitle]` — a plain **`span`, not a button** — inside the bound `[data-row-key^="session:"]` row, chip `#240`, full `repo#N title` in the `title` attribute, row ≥ 40px, subtitle below the row title; **no horizontal overflow** (subtitle right ≤ row content right, row and sidebar tree/list `scrollWidth ≤ clientWidth + 1` — the stray-scrollbar user bug); **non-interactive click behavior**: a real mouse click at the subtitle coordinates must not call `window.open`, must not navigate (`location.href` unchanged) and must keep the same session row selected and the current issue view open (the shipped row `onOpen` is a no-op for the already-selected session; Lead confirmed `对话` must not be required there); then the stage returns to the `issue` view for the whole-window screenshot | `14-sidebar-subtitle.png` |
| 15 | `project-picker-replay` | v1.0.2 picker replay regression (frozen from the preview probe): after resetting the session Issue binding through the shipped unbind flow, asserts an explicit `从项目选择` opens the sidebar picker exactly once; choosing a project closes the picker, consumes the one-shot intent (no replay on remount), keeps one sidebar tab / expanded sidebar / `data-ghp-workspace-entry-bound="1"`; session switch-away/return and sidebar collapse/expand do not replay it; a second explicit open opens exactly once and can be dismissed with no replay; then the existing Issue-binding path still works from the sidebar board (issue detail + header/sidebar subtitles kept after a session switch, one sidebar tab) | — |
| 16 | `projects-warm` | **v0.4.0 §3.5** adapted to v1.0.2: closes the right-sidebar `项目` tab through its dockkit context menu (this unmounts the pane/`ProjectsView`), asserts the pane is gone, then reopens it from the workspace-row board icon and measures until the cached `[data-ghp-view-mode="board"]`/board renders with **no** `[class*="ghp-skeleton"]`; asserts ≤ **1500 ms** and that no cold skeleton was ever rendered (module-level SWR cache hit), and logs the cold duration from `projects-board` (`coldBoardMs`) alongside `warmMs` | — |
| 16b | `projects-status-write` | **v1.1.0 §4.8**, fixture mode only: boots a **second** isolated fixture stack with `allowWrites: true` in the overlay row config, then asserts the write UI (`draggable` + grip + `移动到` on every card, canonical drop lanes, `/project-meta` requested, move menu = every option + clear with the current one active); TODO → In Progress repaints the card in the target lane and `mock-state.writes[0]` = `{itemId PVTI_lAHOAwDbXM4Bocj3zhDFe-U, optionId 47fc9ee4, name "In Progress", ok:true, owner ceasarXuu, number 9}`; success toast carries Undo and Undo re-POSTs the previous TODO option `8fc1d6c9` (`writes[1]`, statuses back to `TODO`); the deterministic failure item `PVTI_mock_write_failure` gets 502 `gh-failed` (`writes[2]`, `ok:false`) with rollback to TODO + error toast; write-stack `/item-status` responses `[200,200,502]` and no browser errors | `16-projects-status-write.png` |
| 17 | `console` | zero browser console errors, zero uncaught exceptions, zero unexpected plugin HTTP ≥400 responses (the single intentional read-only `POST /item-status` 403 probe is allowlisted by exact URL/status; everything else still fails), zero plugin network failures, and — v1.1.0 — **zero `/project-meta` requests / zero 2xx `/item-status` responses in the default/real stack** (warnings are reported, not failed; the benign-console allowlist is **empty**). The stage also asserts a boolean `stale` on every 2xx `/projects`, `/items`, `/issue` response and logs per-request host timings | — |

Screenshots are 1280×800 viewport PNGs written to
[`artifacts/screenshots/`](../../artifacts/screenshots) (except `11`). Acceptance set:
**01-tabs, 02-projects-empty, 03-projects-picker, 04-projects-board,
05-projects-list, 06-projects-milestone, 07-issue-empty, 08-issue-detail,
11-projects-wide, 12-external-open, 13-issue-subtitle,
14-sidebar-subtitle** — `01`–`09` at 1280×800 (09 opt-in), `11` at **2200×1300**
(maximized right-sidebar board), `12` is the system-browser (`window.open`) open
state, `13` is the session-header issue subtitle, `14` is the left-sidebar
session-row subtitle (whole window). The board/picker shots (`02`–`06`, `12`)
capture the v1.0.2 right-sidebar pane; `07`/`08`/`13`/`14` are captured with
the right sidebar collapsed (plain conversation) as before.
The sidebar decoration is driven by `GET /bindings` (local state only, SWR
poll ≈4 s), so the stage waits up to 6 s for the injected row after the bind action.
`16-projects-status-write.png` is fixture-only write-path evidence (the second,
`allowWrites: true` fixture stack); real mode never writes it and the real run's
artifact cleanup preserves it.
`15-published-install.png` is produced by the separate post-publish
`release-smoke.mjs` gate (registry install in a clean profile), not by `run.mjs`.
Board screenshots reflect the v0.3.0 hidden-empty-No-status rule: fixture mode
shows five lanes, real Project #9 shows four lanes with
`data-ghp-hidden-lanes="no-status"`.
`10-desktop-tabs.png` is **not** produced by this harness: it is the manual
evidence from the user's installed Desktop app (full-window screenshot of a real
session header showing `对话 | 轨迹 | issue` plus the workspace-row board icon).
The harness deletes stale numbered shots from earlier runs (and `09` unless
`--extra-comments`) so the artifact directory matches the current numbering.

## Options

| Option | Meaning |
|---|---|
| `--mode=fixture\|real` | host half under test. `fixture` mounts [`dev/mock-host.js`](../../dev/mock-host.js) (contract-shaped data from `test/fixtures/`, in-memory bindings, **no network, no gh**). `real` mounts [`index.js`](../../index.js) (real `gh`, read-only). Default `fixture`. |
| `--keep` | keep the temp run directory (`home/`, `workspace/`, `documents/`, `logs/`, `chrome-profile/`). A failing run is kept even without this flag. |
| `--only=<stage>` | run the stages up to and including `<stage>` (prerequisites included), then stop; the `console` check still runs last. Useful for iterating on one view: `--only=projects-milestone`. Valid stages: `boot`, `app`, `session`, `tabs`, `projects-empty`, `projects-picker`, `projects-board`, `projects-read-only`, `projects-external-open`, `projects-list`, `projects-milestone`, `projects-wide`, `issue-empty`, `issue-bind-subtitle`, `issue-detail`, `issue-comments`, `sidebar-subtitle`, `workspace-branch`, `project-picker-replay`, `projects-warm`, `projects-status-write`, `console`. |
| `--headful` | run Chrome with a visible window (local debugging; default is `--headless=new`). |
| `--extra-comments` | also capture `09-issue-comments.png`. |
| `--timeout-scale=<n>` | multiply every stage timeout (slow machines: `1.5`). Default `1`. |
| `-h`, `--help` | usage. |

## Prerequisites

- macOS with the installed app (validated against **DeepSeek Harness 0.2.1-rc.3**):
  - CLI: `$DSH_E2E_CLI` when set, else the Desktop app's bundled runtime (probed at
    `DeepSeek Harness 2.app` then `DeepSeek Harness.app`, whose directory name changes between
    releases), else `dsh` on `PATH`
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
           (the fixture write stage adds a second isolated tree,
            /tmp/dsh-github-projects-e2e/<run>-write-fixture/ with its own
            home/, workspace/, documents/, logs/ and chrome-profile/)
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
      # config:                      # only the fixture write stack sets this (v1.1.0)
      #   allowWrites: true
```

The main stack's overlay never sets `config.allowWrites`, so the read-only stages
(and real mode) always see the shipped default `false`.

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

### Why the workspace-row icon is clicked with a retry

The plugin injects `[data-ghp-workspace-entry]` from a `requestAnimationFrame`
sweep after the left-sidebar workspace row renders, and DSH's right-sidebar tab
type is registered from the same plugin scope. On a fresh page the first
programmatic `.click()` can land in the ~1-frame window before the sidebar face /
tab type is ready, so the harness waits for the icon to be injected and retries
the click (≤3 attempts, checking the visible `收起右侧边栏` button + the keyed
pane). This is a harness-side stabilisation, not a product change.

### Why the write-path stage boots a second stack

`allowWrites` is plugin activation config resolved once per host instance, so one
`dsh web` server cannot be simultaneously read-only (shipped default, verified by
`projects-read-only`) and write-enabled (verified by `projects-status-write`).
The harness therefore keeps the authoritative stack read-only and, only for the
fixture write stage, boots a second fully isolated fixture stack
(`<run>-write-fixture/`) with `config.allowWrites: true` in the overlay row. It
has its own DSH_HOME, workspace, Documents dir, mock-host memory and Chrome
profile; the only shared process is the offline mock LLM server. The second stack
is torn down at the end of the stage (kept with `--keep` or on failure, and its
path is reported in the stage detail / `logs/summary.json` → `writeRunDir`).

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
| `tabs`: missing `issue` / workspace board icon absent | `client.js` failed to load/apply, or the sidebar-right services are not exposed by the installed DSH build (the v1.0.2 entry/board feature degrades to absent); check `console` and `failure-tabs.png`. |
| `console`: `SyntaxError` from `/plugins/??@ceasarxuu/dsh-github-projects/client.js&rev=...` | `client.js` was being edited **while the run was in flight** (HMR served a half-written bundle). Freeze client.js during a run; re-run. |
| `projects-empty`/`projects-picker`: pane never opens | the workspace icon was clicked before the sidebar face settled (the helper retries), or the installed DSH build no longer exposes `sidebarRightTabs`; failure dump shows the workspace-row snapshot. |
| `projects-wide`: maximized pane is not ≥90% of the window | the shipped `全屏` control changed aria-label/markup, or the plugin page is capped/centred inside the pane (the regression this stage guards). |
| `projects-warm`: warm open rendered a skeleton | the module-level SWR cache was lost (pane remount cold) or the project tab close/reopen path changed. |
| `project-picker-replay`: picker replays / opens twice | the one-shot `pick` intent navigation was not consumed (`SidebarProjectView.consumePick`) — the regression this stage guards. |
| `projects-picker` / `issue-detail`: timeout waiting `ghp-*` content | client view regressed (skeleton never leaves / body never renders); failure dump + screenshot show the state. |
| `projects-read-only`: read-only hint missing or write UI present | a v1.1.0 regression: `allowWrites` leaked `true` into the default stack, or the read-only rendering broke. Check `/config.writes.allowed` and the failure UI dump. |
| `projects-read-only`: probe answered 2xx | the abstract host write gate is broken: `POST /item-status` must answer 403 `writes-disabled` while `allowWrites` is false. |
| `projects-status-write`: write-stack board not rendered | the second fixture stack failed to boot/bind (see `<run>-write-fixture/logs/dsh.log`), or `POST /bind-workspace` / `/config` did not return the bound fixture Project. |
| `projects-status-write`: mock-state payload mismatch | the client sent a different `itemId`/`optionId` than the mock recorded, or Undo did not re-POST the previous option id (`8fc1d6c9`). |
| `boot` in real mode: `gh` unavailable / `gh-auth` | `gh auth status` not valid for the invoking user; fix `gh auth login` or use `--mode fixture`. |

## Release gate: published-install smoke (`release-smoke.mjs`)

`run.mjs` deliberately loads the plugin through a `--patch` overlay from this
checkout. For a release, the plugin must also be proven as a **published npm
package**: [`release-smoke.mjs`](./release-smoke.mjs) installs it from the
registry into a throw-away profile and boots `dsh web` from that profile.

```bash
# after `npm publish` (clean temp DSH_HOME created by the script)
node scripts/e2e/release-smoke.mjs --spec=@ceasarxuu/dsh-github-projects@1.0.2
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
   model, same as `run.mjs`), asserts the header tabs `对话`, `轨迹`, `issue`
   exist and that the removed `projects` conversation tab is absent, clicks
   `issue` then `对话`, asserts the left-sidebar workspace row exposes the
   `[data-ghp-workspace-entry]` board icon (v1.0.2-only; it is the board entry
   now), then captures
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
allowlist (`run.mjs` → `BENIGN_CONSOLE_ERRORS`) is **empty**: the plugin does
not embed GitHub in an iframe (card/subtitle clicks call
`window.open(url, '_blank', 'noopener,noreferrer')` for the system browser), so
the previous github.com `X-Frame-Options` refusal does not occur. Independently
of console messages, the `console` stage allowlists exactly **one** intentional
plugin HTTP 403 (the `projects-read-only` `POST /item-status` probe, matched by
URL + status); every other ≥400 still fails the run.

## Known limitations / flakiness

- The fixture write stage boots a second DSH server + Chrome (≈10–20 s extra);
  `--keep`/failure keeps its `<run>-write-fixture/` tree for inspection. Real
  mode flags the stage as `skipped` (fixture-only, read-only by contract).
- `16-projects-status-write.png` is only written by the fixture write stage; the
  real run preserves it (same as the manual `10` and release `15` evidence).
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
- The workspace-row board icon is injected by a guarded DOM decorator (rAF sweep
  + 1.5 s interval) and can be absent for the first ~1–2 s after boot; the
  harness waits for it and retries the click (see above). If the sidebar row
  anchors ever change, the feature degrades to no entry (the `tabs` stage then
  fails with the workspace-row snapshot).
- The sidebar session-row subtitle is injected by a guarded DOM decorator driven
  by `GET /bindings` (SWR poll ≈4 s plus an immediate `binding-changed` refresh);
  the stage waits up to 6 s after a bind. If the sidebar row anchors ever change,
  the feature degrades to no subtitle (the stage then fails with the last snapshot).
- `projects-wide` depends on the shipped `全屏` / `退出全屏` controls of the DSH
  right sidebar; if the installed DSH build renames them the stage fails with the
  aria-label it looked for (the pane/fullscreen DOM is part of what the release
  verifies, not plugin code).
- Card-body / subtitle clicks open the Issue in the **system browser** via
  `window.open(url, '_blank', 'noopener,noreferrer')`. Headless Chrome cannot
  present a system browser, so the `projects-external-open` stage stubs
  `window.open` in the page and asserts the exact call (URL/target/features); the
  pointer-click path in `sidebar-subtitle` asserts no call is made at all.

## Current status — plugin v1.1.0 acceptance

Inputs used for the authoritative pair: `client.js` sha256
`a32492bbe82036c5c4be50c7b8155b55c82b976480140676d63462ff51d5ec27`,
`index.js` `f4619d0db5fd12f358465b1e9b31b2a1c38e32884c4b6735b7c9ecd0be1851af`,
`github.js` `6b654241be3f7df70a256d248036e053deffb8b8f871aba95329a8df0c138d27`,
`dev/mock-host.js` `bdcef59524be82ba5cc6d41f3071ad245a2ba9a4bc6dd58ca54b397412171d04`;
`package.json` version **1.1.0** (`@ceasarxuu/dsh-github-projects`, read-only by
default + opt-in `allowWrites` write path).

| Mode | Command | Exit | Run dir |
|---|---|---|---|
| fixture | `node scripts/e2e/run.mjs --mode fixture --extra-comments --keep` | `0` (PASS) | `/tmp/dsh-github-projects-e2e/2026-10-29T00-17-13-691Z` (write stack: `/tmp/dsh-github-projects-e2e/2026-10-29T00-17-13-691Z-write-fixture`) |
| real (`gh` 2.96.0, `ceasarXuu`, Project #9) | `node scripts/e2e/run.mjs --mode real --keep --extra-comments` | `0` (PASS) | `/tmp/dsh-github-projects-e2e/2026-10-29T00-17-44-274Z` |

**21/21 stages `ok:true`** in fixture mode (both new v1.1.0 stages; `issue-comments`
included via `--extra-comments`) and **21/21** in real mode (`projects-status-write`
reports `skipped: true, fixtureOnly: true`; real mode stays read-only). The
`console` stage: **0 errors / 0 exceptions / 0 warnings**, 0 plugin network
failures, exactly **one** allowlisted `/item-status` 403 probe (no other plugin
HTTP ≥400), boolean `stale` on every 2xx `/projects`, `/items`, `/issue`
(12 fixture / 14 real data responses, 0 missing). The final acceptance PNGs come
from the authoritative **real** run, except the fixture-only
`16-projects-status-write.png` written by the fixture run's write stack.

v1.1.0 evidence:
- `projects-read-only` (both modes): `/config.writes.allowed === false`; fixture
  board 9 cards / real board 200 cards with **0** draggable cards, 0 drag
  handles, 0 `移动到` actions, no move menu, 0 lane drop targets, exactly one
  `[data-ghp-board-readonly]` hint (`只读看板：开启 allowWrites 后才能拖动卡片调整卡片 Status。`);
  **0** `/project-meta` requests; the page-context `POST /item-status` answered
  **403 `writes-disabled`** (only `/item-status` response `[403]`,
  `writesPerformed: 0`).
- Real mode zero writes: the read-only stage's only mutation request was that
  intentional probe, refused **before the handler** by the host write gate.
  `console.writePath = {probeStatuses: [403], acceptedWrites: 0,
  projectMetaRequests: 0}` — no 2xx `/item-status` response, so no GitHub
  mutation was ever executed.
- `projects-status-write` (fixture, second stack with `allowWrites: true`): write
  hooks 9/9 cards draggable + 9 grips + 9 `移动到` actions, canonical drop lanes
  `[no-status, todo, in-progress, in-review, done]`, 1 `/project-meta` read; move
  menu `[8fc1d6c9 (TODO), 47fc9ee4 (In Progress), edd18149 (In Review),
  98236657 (Done), clear]` with TODO active. TODO → In Progress painted the card
  in the target lane and `mock-state.writes[0] = {itemId
  PVTI_lAHOAwDbXM4Bocj3zhDFe-U, optionId 47fc9ee4, name "In Progress", ok: true,
  owner ceasarXuu, number 9}` (mock status `In Progress`); success toast with
  Undo. Undo re-POSTed the previous TODO option `8fc1d6c9`
  (`writes[1]`, mock status back to `TODO`). The deterministic failure item
  `PVTI_mock_write_failure` got `writes[2] = {itemId PVTI_mock_write_failure,
  optionId 47fc9ee4, ok: false, code "gh-failed"}`, with the card rolled back to
  TODO and the error toast. Write-stack `/item-status` responses `[200, 200,
  502]`; no browser errors in the write stack. Screenshot
  `16-projects-status-write.png` (moved card + success toast with Undo).
- Existing v1.0.2/v1.0.1 coverage unchanged and green: board/lane rule (5 fixture
  / 4 real lanes), external-open single `window.open`, list, milestone filter,
  maximized-sidebar wide layout at 2200×1300, issue header/sidebar subtitles,
  picker replay, warm SWR open, console module-id gate.

Final artifact set (`artifacts/screenshots/`):

| File | Source | Size |
|---|---|---|
| `01-tabs.png` … `09-issue-comments.png` | `run.mjs` authoritative run (09 via `--extra-comments`) | 1280×800 |
| `10-desktop-tabs.png` | **manual** Desktop-app evidence (Lead), never harness-written | full app window |
| `11-projects-wide.png` | `run.mjs`, `projects-wide` (maximized right-sidebar board) | 2200×1300 |
| `12-external-open.png` | `run.mjs`, `projects-external-open` (system-browser open) | 1280×800 |
| `13-issue-subtitle.png` | `run.mjs`, `issue-bind-subtitle` | 1280×800 |
| `14-sidebar-subtitle.png` | `run.mjs`, `sidebar-subtitle` | 1280×800 |
| `17-workspace-branch.png` | `run.mjs`, `workspace-branch` | 1280×800 |
| `15-published-install.png` | `release-smoke.mjs`, clean-profile **registry** install (still the 1.0.2 evidence; overwritten after the v1.1.0 publish) | 1280×800 |
| `16-projects-status-write.png` | `run.mjs`, `projects-status-write` (fixture write stack; a real run preserves it) | 1280×800 |

### Publishing gate

- **v1.0.0 / v1.0.1 / v1.0.2** publish history: registry metadata verified and
  clean-profile `release-smoke` PASS (see the release notes / git history).
- **v1.1.0** publish: pending. `release-smoke.mjs` still defaults to the 1.0.2
  spec and does not yet assert the v1.1.0 read-only default, so after publish run
  it with an explicit spec:
  `node scripts/e2e/release-smoke.mjs --spec=@ceasarxuu/dsh-github-projects@1.1.0 --keep`
  (updating the release-smoke defaults/read-only checks for v1.1.0 is a separate
  release-task follow-up, outside this task's `run.mjs`/README scope).

Earlier screenshot numbers from previous versions are removed automatically as
stale numbered state shots at the start of every `run.mjs` run; `10`, `15` and the
fixture-only `16` are preserved by that cleanup. Older temp run directories under
`/tmp/dsh-github-projects-e2e/` and `/tmp/dsh-github-projects-release-smoke/` are
development/release history and may be deleted.

## File map

```
scripts/e2e/
  run.mjs              orchestrator: args, stages, JSON lines, screenshots, cleanup
  lib/dsh.mjs          temp layout, overlay generation (v1.1.0 row `config`),
                       `dsh web` spawn/URL/HTTP wait
  lib/browser.mjs      headless Chrome launch, DevToolsActivePort, page target attach
  lib/cdp.mjs          raw-WebSocket CDP client (evaluate/waitFor/screenshot, console capture)
  lib/app.mjs          DSH UI helpers (app shell, dialogs, tabs, composer, buttons)
  lib/mock-llm.mjs     local Anthropic-Messages SSE mock used to start an offline turn
  release-smoke.mjs    post-publish gate: install from npm into a temp profile,
                       boot `dsh web` from it, assert /health + tabs + board entry, capture 15
```
