# Changelog

All notable user-facing changes of this plugin. Versions before the first public
release are listed as internal history.

## 1.3.0 — 2026-11-17

**A workspace binds its Project by itself.** Most workspaces are a checkout of exactly one GitHub
repository, and that repository already says which Project it belongs to — so making the user click
a board icon and pick one is answering a question GitHub could answer. Auto-bind reads the git
remote, finds the Project, and fills the binding. It only ever fills a *gap*: a Project you bound
yourself is never touched.

- **The rule.** `git config --get remote.origin.url` (local git, no network, no auth) →
  `owner/name` → the Projects linked to that repository (one GraphQL call) → a pick: a **closed**
  Project is never a candidate, an enabled **"Auto-add to project"** workflow wins because that is
  the repository's intended board, otherwise the **most recently updated** open Project. A remote
  that is not `github.com` (a local mirror, GitLab, Bitbucket) is never guessed into a GitHub repo.
- **It explains itself.** An auto-filled board shows one muted line in its toolbar —
  `已根据仓库 ceasarXuu/Astropath 自动绑定 Project「Astropath-issues」` — and says so explicitly when
  the repository links several Projects and the pick was a choice. The note reads the durable
  binding's provenance, so it survives a reload and a restart, and it disappears the moment you bind
  by hand. `更换` stays the way to overrule it.
- **Never overwrites a choice.** A workspace with any existing binding is answered `already-bound`
  and left alone. Re-binding by hand clears the provenance, so the board stops claiming it chose.
- **Host API.** New `GET /auto-bind?workspaceId=&path=` (the path is optional; the host resolves it
  from `workspaceRegistry`). A workspace's binding now optionally carries
  `{repository, ambiguous, considered, appliedAt}` through `/bindings` and `/config`.
  One startup pass covers every registered workspace; a 60 s sweep catches workspaces created later;
  answers are remembered for `autoBindTtlMs`, so the steady state costs no `git` and no `gh`.
- **Config.** `autoBind` (default **true**) and `autoBindTtlMs` (600000). Set `autoBind: false` for
  the manual picker only.
- No breaking change, no new runtime dependencies, no DSH compatibility change (`engines.dsh` still
  `>=0.2.1-rc.3 <0.3.0`). Existing installs keep working; a workspace that was unbound simply gains
  a Project on the next start, and one you bound by hand is untouched.
- Verification: host tests **191/191** pass (33 new: every git remote URL shape against real
  throw-away repositories, the ranking rule against a live-captured `Repository.projectsV2` fixture,
  the orchestration — never overwrite, remember negatives, never remember a `gh` failure — durable
  provenance, and the route). The e2e harness passes in both fixture and real-host mode including a
  new `auto-bind` stage on its own isolated stack (screenshot `18-auto-bind.png`): the workspace is
  filled with no user action, a second call answers `already-bound`, the sidebar icon flips to bound,
  and the board renders a readable two-line note naming the repository.

## 1.2.0 — 2026-11-16

**Workspace branch in the left sidebar.** Every workspace row now shows which git branch that
workspace's directory is currently on, right next to the workspace name. It is a local read — `git`,
never `gh`, never the network, no auth — and it is decoration: a read-only chip that never changes a
branch, a file, or a GitHub object.

- **The chip.** `Astropath  main  ▣` — one muted chip to the right of the workspace title, before the
  board entry icon. It is a plain `span` with no click handler, so clicking it just toggles the
  workspace row like clicking the name does. A **detached HEAD** shows `@<short sha>` in a muted warn
  colour, a **workspace that is not a git repository** shows no chip at all rather than a placeholder,
  and the chip's tooltip carries the branch plus the workspace directory (the chip keeps pointer
  events so that native tooltip stays reachable when the text is truncated, while a press still
  lands on the workspace row and only toggles it). The title ellipsises first
  when the sidebar gets narrow, so the row never gains a horizontal scrollbar.
- **When it is read.** Once at DSH startup (so the first paint already has every chip), again on every
  **user message** sent in that workspace (so a `git checkout` by you or the agent shows up on your
  next prompt), and on a 15 s poll to pick up an external checkout. A synthetic context injection — a
  skill body, a file-change notice, a scheduled-task reminder, a goal continuation — is **not** a user
  message and refreshes nothing.
- **Host API.** New `GET /branches`: the branch of every registered workspace, cached per directory so
  polling never spawns one `git` per request, with concurrent reads sharing a single process. Each
  invocation runs bounded (`GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, an output cap, and a
  deadline), so a hung or prompting git cannot wedge the route. Without the `workspaceRegistry`
  service the route still answers 200 with an empty map and the chip simply never appears.
- **Config.** Three new keys: `gitCommand` (default `git`), `gitTimeoutMs` (4000) and `branchTtlMs`
  (30000). Restate them in a profile patch only when you override the row, like the other keys.
- No breaking change, no new runtime dependencies, no DSH compatibility change (`engines.dsh` still
  `>=0.2.1-rc.3 <0.3.0`). Existing installs keep every previous behavior; the chip appears on its own.
- Verification: host tests **159/159** pass (`node --test test/host/*.test.mjs`; the 130-test v1.1.0
  baseline plus 29 new tests covering a real throw-away repository per branch state, the cache and
  single-flight, the workspace-id index, the route shape and the mock host's `/branches`), and the
  fixture e2e harness passes every stage including the new `workspace-branch` stage (screenshot
  `17-workspace-branch.png`) in **both** fixture and real-host mode — both modes create a real git
  repository for the run's first-use Workspace, assert the chip matches it, then perform a real
  `git checkout` and assert the chip **repaints** (that assertion caught a real bug: the title-cell
  lookup skipped the cell that already held a chip, so the chip froze on its startup branch and the
  prompt/poll refreshes never reached the DOM).
- Two e2e harness fixes were needed for the newer DSH build (0.2.2-rc.3) and are **harness-only, no
  product change**: the session-header tabs that overflow are folded into a `更多会话视图` menu the
  helper could not read (it returned `null`, failing `issue-bind-subtitle`), and the right-sidebar tab
  close menu (`data-dockkit-tab-menu`) does not exist in that build, so the warm-open stage now
  unmounts the pane by collapsing the sidebar instead. The harness also resolves the `dsh` CLI by
  probing the renamed app bundle (`$DSH_E2E_CLI` first), and builds its first-use Workspace
  repository at the path `workspace-controller` actually registers
  (`<documents>/deepseek-harness/...`) rather than the process cwd.

## 1.1.0 — 2026-10-29

**Opt-in Project item status writes.** v1.1.0 adds the first GitHub write: with the new `allowWrites`
config (default **false**) the project board can move an item between Status lanes (drag, or the
card's `移动到` menu) and the model gets a fourth agent tool (`github_project_item_status`). Existing
users are unaffected — writes stay off by default, the board remains read-only with a hint, and no
other GitHub write exists.

- **Board status writes (opt-in).** Set `allowWrites: true` and the board becomes movable: cards
  expose a drag handle and a keyboard-accessible `移动到` menu listing every Status option plus
  `No status`; custom `other:*` lanes stay read-only. A move repaints the card optimistically, shows
  a toast with **Undo**, and any failure rolls the card back with an error toast. The only GitHub
  mutation is the Project item's `Status` single-select field; comments, labels, Issue state and all
  other Project fields are untouched.
- **Host API.** New `GET /project-meta` (Project node id + `Status` field id/options, a cached read
  only used when writes are allowed) and `POST /item-status` (the only write endpoint:
  `{owner, number, itemId, optionId|null}`, `optionId: null` clears the Status). `GET /config` now
  reports `writes: { allowed }`. While `allowWrites` is false, `/item-status` is refused with 403
  `writes-disabled` and the client never requests `/project-meta`.
- **Fourth agent tool: `github_project_item_status`.** Registered **only** when `allowWrites` is
  true; moves one item of the current session's workspace-bound Project to a named Status option
  (`status: null` clears it), accepting `itemId` or `repo`+`number`. It matches option names
  case-insensitively, writes only the Status field, and renders e.g. `已把 #240 移到 In Progress`.
- **Prerequisite: the `project` scope.** Writes use the same `gh` token as reads; a scope or
  permission error surfaces as `gh-auth` with the hint `gh auth refresh -s project`. Authentication
  still lives entirely in the `gh` CLI — the plugin never reads or stores tokens.
- **Read-only default is unchanged and safe.** With `allowWrites` false (the default) there are no
  drag handles, no `移动到` actions, no `other:*` drop targets, no `/project-meta` calls, and the
  board shows exactly one read-only hint (`只读看板：开启 allowWrites 后才能拖动卡片调整卡片 Status。`);
  a direct `/item-status` POST is 403 `writes-disabled`, and the write tool is not registered.
- No DSH compatibility change (`engines.dsh` still `>=0.2.1-rc.3 <0.3.0`, tested on 0.2.1-rc.3), no
  new runtime dependencies, and **no breaking change** for existing users.
- Verification: host tests **130/130** pass (`node --test test/host/*.test.mjs`; the 92-test baseline
  plus 38 new tests) and `node --check index.js github.js dev/mock-host.js` is OK; authoritative e2e
  **PASS** — fixture **21/21** stages (the write path runs in a second isolated fixture stack with
  `allowWrites: true`, run dir `/tmp/dsh-github-projects-e2e/2026-10-29T00-17-13-691Z`) and real
  **21/21** stages in read-only mode (run dir `/tmp/dsh-github-projects-e2e/2026-10-29T00-17-44-274Z`,
  gh 2.96.0 / `ceasarXuu` / real Project #9), console **0 errors / 0 exceptions / 0 warnings** in both
  modes with exactly one intentionally allowlisted 403 (the read-only `POST /item-status` probe) — the
  real run performs zero GitHub writes. Write-path evidence: a TODO→In Progress move posted
  `{itemId: "PVTI_lAHOAwDbXM4Bocj3zhDFe-U", optionId: "47fc9ee4"}`, Undo re-posted the previous
  `8fc1d6c9` and moved the card back, and the mock failure item `PVTI_mock_write_failure` got 502 with
  a rollback to TODO; new screenshot `16-projects-status-write.png`. The npm publish and
  clean-profile install smoke for 1.1.0 are recorded in `docs/DESIGN.zh.md` §8.10 after publication.

## 1.0.2 — 2026-10-29

**The Project board moves into DSH's right sidebar.** v1.0.2 replaces the conversation-header
`projects` tab with a left-sidebar workspace entry and a right-sidebar tab, extends the local
`/bindings` endpoint with the workspace → Project map behind that entry, and fixes a user-reported
ProjectPicker replay. No DSH compatibility change (`engines.dsh` still
`>=0.2.1-rc.3 <0.3.0`, tested on 0.2.1-rc.3) and no new runtime dependencies.

- **The board opens in the right sidebar, from the left sidebar.** The `projects` conversation view
  is removed (`issue` stays as the plugin's only conversation-header view). Every left-sidebar
  workspace row now carries one small board icon, visible without hovering and highlighted when
  that workspace has a bound Project; click/Enter opens the board as a right-sidebar tab without
  toggling the workspace's expansion, and clicking again focuses the existing tab instead of adding
  a duplicate. The pane adapts to the narrow sidebar (toolbar wraps, board scrolls horizontally,
  list stays usable), and the `issue` tab's unbound `从项目选择` opens the same board with the
  picker. If the host does not offer the `sidebarRight` services the icon is not injected, and the
  `issue` tab and subtitles keep working.
- **`GET /bindings` also returns the workspace → Project map (local only).** `workspaces` joins
  `sessions` in the response so the workspace entry icon can show the bound/highlighted state
  without a `gh` call; host tests were extended (92/92 pass) and `dev/mock-host.js` mirrors the
  shape.
- **Fixed: the ProjectPicker reopened by itself on a bound session (P-001, user report).** Returning
  to a session whose workspace already had a bound Project — after choosing or dismissing the
  picker, after a session switch, a sidebar collapse/expand, or any remount — replayed the one-shot
  `pick` navigation intent and opened the picker again. The client now captures the request locally
  and consumes the intent by rewriting the same tab's navigation to `{ workspaceId }` only, so the
  picker appears only on an explicit request. Verified: an explicit `从项目选择` opens once;
  choosing/dismissing closes it; session switch/return, collapse/expand and repeated remounts do not
  replay it; bindings are kept; one sidebar tab.
- Acceptance evidence for this release: frozen `client.js` sha256
  `684f2953fa6818bc982e51b76b5bb3c3dcc6ec51cdfb12d8338b2d8a43d384e2`; host tests **92/92** pass;
  an independent picker-replay verifier passed all **6 checks**; the authoritative repo-e2e gate is
  **PASS** — fixture **18/18** executed stages (run dir `2026-10-28T22-18-34-867Z`) and real **19/19**
  stages (run dir `2026-10-28T22-20-03-025Z`), console **0/0/0** in both modes, including the new
  `project-picker-replay` stage; the authoritative screenshot set `01`–`14` was re-captured (`11` is
  the maximized right-sidebar pane at 2200×1300). Post-publish gates are also green: npm `1.0.2` is
  live (`latest`), the clean-profile npm install smoke is **PASS**, and the source commit + tag
  `v1.0.2` are pushed (details in `docs/DESIGN.zh.md` §8.9).

## 1.0.1 — 2026-10-28

Bug-fix release for the sidebar issue subtitle and Issue link opening (user reports).

- **Sidebar session row clicks stay navigation-only.** The injected sidebar subtitle is now a plain
  non-interactive `span`; clicking anywhere on a session row — including the subtitle — opens that
  session and never opens the Issue. (Previously the subtitle was a button that stopped propagation
  and opened the Issue.)
- **Issue links open the system default browser in a new tab.** Card/list-row clicks, the header
  subtitle and the Issue view's GitHub link now use
  `window.open(url, '_blank', 'noopener,noreferrer')` (same as DSH's "Open in system browser")
  instead of the built-in right-sidebar browser. The plugin no longer requires the optional
  `sidebarRight`/`sidebarRightTabs` client services.
- **No horizontal overflow in the sidebar.** The subtitle now uses
  `flex:1 1 100%; max-width:100%; padding-inline-start:20px` instead of `flex-basis:100% + margin`,
  so long Issue titles stay inside the session container; this also removes the stray horizontal
  scrollbar rectangle that appeared above the sidebar footer/avatar.
- e2e: `projects-browser` → `projects-external-open` (stubs `window.open`, asserts no sidebar
  browser tab), and `sidebar-subtitle` adds no-overflow + row-click-navigates assertions;
  screenshot `12-browser-open.png` → `12-external-open.png`.

## 1.0.0 — 2026-10-28 — first public release

First public release of **GitHub Projects & Issues** for DeepSeek Harness
(tested against DSH 0.2.1-rc.3, Desktop and `dsh web`). Zero npm runtime
dependencies: the host half uses only `node:*` built-ins and the browser half
only the host-provided `react` / `react-dom`.

- **`projects` tab** — the GitHub Project bound to the current workspace, as a
  status swimlane board (`No status` / `TODO` / `In Progress` / `In Review` /
  `Done`, empty `No status` lane hidden) with a grouped list toggle, milestone
  filter (`全部` / `Backlog` / project milestones), text filter, full-width
  adaptive layout, and the v0.3 component color system.
- **`issue` tab** — the Issue bound to the current session: state, labels,
  milestone-aware header, safe Markdown body, comments, refresh/unbind.
- **Issue subtitle** — every session bound to an Issue shows `#N` chip + Issue
  title under its title in the conversation header **and** in the left sidebar
  session tree (single line, ellipsis, click opens the issue in the built-in
  browser). Agent-tool changes are reflected within ~4 s.
- **Click ≠ bind** — clicking an Issue/PR card or list row opens its GitHub
  page in DSH's built-in right-sidebar browser; binding is an explicit `绑定`
  action.
- **Agent tools** — `github_issue_bind`, `github_issue_switch`,
  `github_issue_unbind` let the model manage the current session's Issue
  binding; the UI updates without a refresh.
- **Fast reads** — one GraphQL call for project lists, paginated GraphQL for
  project items (no separate project view), stale-while-revalidate caches with
  a bounded disk snapshot, and a non-blocking `/config`: warm projects open in
  tens of milliseconds with no skeleton.
- **Local API** — 10 endpoints under `/plugin/github-projects`, loopback only,
  request gating (Origin / content type / body cap), no telemetry, no token
  access (auth stays in the `gh` CLI).

## Internal history (pre-public)

| Version | Highlight |
|---|---|
| 0.1.0 | v1: workspace→Project binding, session→Issue binding, `projects`/`issue` tabs, 8 endpoints, durable state, tests/e2e. |
| 1.x docs | Chinese design doc, zh/en README, frozen HTTP contract, 69 host tests. |
| 0.2.0 | Swimlane board (5 status lanes), milestone filter, view toggle, 69→87 tests. |
| 0.2.1 | Full-width adaptive layout (removed the centered 1000px page cap) + wide-window e2e regression. |
| 0.3.0 | Component color system (status palette, tinted counts, hierarchy) + hide empty `No status` lane. |
| 0.4.0 | Session issue subtitle, built-in-browser clicks, agent bind/switch/unbind tools, GraphQL + SWR fast reads. |
| 0.4.1 | Issue subtitle in the left sidebar session tree via `GET /bindings` polling. |
