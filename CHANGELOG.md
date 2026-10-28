# Changelog

All notable user-facing changes of this plugin. Versions before the first public
release are listed as internal history.

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
