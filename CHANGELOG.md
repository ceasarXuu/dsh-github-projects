# Changelog

All notable user-facing changes of this plugin. Versions before the first public
release are listed as internal history.

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
