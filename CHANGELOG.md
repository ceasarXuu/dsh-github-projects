# Changelog

All notable user-facing changes of this plugin. Versions before the first public
release are listed as internal history.

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
