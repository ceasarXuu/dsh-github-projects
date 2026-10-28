# dsh-github-projects

**v1.0.2 — current release.** The GitHub Project and Issue bound to your DSH session: the board in
the right sidebar, the Issue one tab away.

This DSH plugin appends the `issue` view to the conversation header — it shows the Issue bound to the
**session**, with a one-line **issue subtitle** under the session title in the conversation header
**and** under the session row in the left sidebar session tree (v0.4.1). The **project board** — the
GitHub Project bound to the **workspace**, as a status swimlane board by default with a list view and
a milestone filter — moved in v1.0.2 out of the conversation header into DSH's **right sidebar**: one
small board icon in every workspace row of the left sidebar opens it (highlighted when that workspace
is bound). Clicking a card or the header subtitle opens GitHub in your **system default browser**
(new tab); the sidebar subtitle is non-interactive and clicking anywhere on a session row just opens
that session. A separate **Bind** action binds the Issue to the session, and the model can do the
same through three agent tools. Everything is read-only against GitHub — it is a viewing surface, not
a writer.

```
conversation header:  [ 对话 ] [ 轨迹 ] [ issue ] [ … ]
left sidebar:         workspace row  ▣  →  right sidebar tab  [ 项目 / Project ]
```

> Third-party plugin, not an official DeepSeek / DeepSeek Harness component.

![Session header with the `issue` tab, and the board in the right sidebar (v1.0.2 e2e)](artifacts/screenshots/01-tabs.png)

## Release 1.0.2 — board in the right sidebar, picker replay fix

Current release, published as `1.0.2`. The board leaves the conversation header and becomes a
right-sidebar tab opened from the left sidebar; the ProjectPicker replay bug is fixed.

| | |
|---|---|
| npm package | `@ceasarxuu/dsh-github-projects@1.0.2` (public scoped package) |
| Release | [v1.0.2](https://github.com/ceasarXuu/dsh-github-projects/releases/tag/v1.0.2) |
| Changes | right-sidebar board + workspace-row entry icon; `workspaces` in `/bindings`; ProjectPicker no longer reopens |
| Compatibility | no DSH change (`engines.dsh` `>=0.2.1-rc.3 <0.3.0`, tested on 0.2.1-rc.3); no new runtime dependencies |

- **Project board in the right sidebar.** The `projects` conversation tab is removed; `issue` is the
  plugin's only conversation-header view. Each left-sidebar workspace row now has a small board icon
  (`[data-ghp-workspace-entry]`) that opens that workspace's Project as a right-sidebar tab — always
  visible, highlighted when the workspace has a bound Project
  (`data-ghp-workspace-entry-bound="1"`), and click/Enter does not expand/collapse the workspace row.
  Re-clicking focuses the existing tab instead of adding a duplicate. The pane adapts to the narrow
  sidebar (toolbar wraps, board scrolls horizontally, the list stays usable), and the `issue` tab's
  unbound **从项目选择** opens the same board with its picker. If the host has no `sidebarRight`
  services the icon is not injected (no errors); the `issue` tab and both subtitles keep working.
- **`GET /bindings` includes the workspace map.** The local endpoint now returns
  `{sessions, workspaces, updatedAt}` (`workspaces: {<workspaceId>: Project}`, read from
  `state.json` — no `gh` call) so the workspace icon knows which rows are bound.
- **Fixed: the Project picker reopened by itself (user report).** After choosing or dismissing the
  picker — and then switching sessions, returning, collapsing/expanding the sidebar, or any remount —
  the one-shot `pick` navigation intent was replayed and the picker came back on a workspace that was
  already bound. The client now captures the request locally and consumes it by rewriting the same
  tab's navigation to `{ workspaceId }` only. Verified: an explicit **从项目选择** opens exactly
  once; choosing/dismissing closes it; session switch/return, collapse/expand and repeated remounts
  do not replay it; bindings survive; one sidebar tab.
- **Acceptance — pre-publish gate green.** Frozen `client.js` sha256
  `684f2953fa6818bc982e51b76b5bb3c3dcc6ec51cdfb12d8338b2d8a43d384e2`; host tests **92/92** pass; the
  fix passed an independent 6-check picker-replay verifier; the authoritative v1.0.2 repo-e2e run is
  **PASS** — fixture **18/18** executed stages (run dir `2026-10-28T22-18-34-867Z`) and real **19/19**
  stages (run dir `2026-10-28T22-20-03-025Z`), console **0/0/0** in both modes, including the new
  `project-picker-replay` stage and the refreshed screenshot set (`01`–`14`; `11` is the maximized
  right-sidebar pane at 2200×1300). Only post-publish items remain — npm `1.0.2` live (dist-tag
  `latest`), the clean-profile `release-smoke` install and the tag/release confirmation — recorded in
  [the evidence chapter](docs/DESIGN.zh.md#8-验收与验证证据) after publication.

## Release 1.0.1 — sidebar clicks, system-browser links, no overflow

Bug-fix release for four user-reported issues (three fixes); **published as `1.0.1`** (superseded by
1.0.2).

| | |
|---|---|
| npm package | `@ceasarxuu/dsh-github-projects@1.0.1` (public scoped package) |
| Release | [v1.0.1](https://github.com/ceasarXuu/dsh-github-projects/releases/tag/v1.0.1) |
| Fixes | sidebar rows navigate only; links open in the system browser; no sidebar overflow |

- **Sidebar session rows are navigation-only.** The subtitle under a bound session row is now a plain,
  non-interactive `span`; clicking anywhere on the row — subtitle included — opens that session and
  never opens the Issue.
- **Issue links open in your system default browser (new tab).** Card/list-row clicks, the
  conversation-header subtitle and the Issue view's GitHub link use
  `window.open(url, '_blank', 'noopener,noreferrer')`, the same mechanism as DSH's "Open in system
  browser". The plugin no longer uses the built-in right-sidebar browser (`sidebarRight` services are
  not involved in link opening; v1.0.2 reuses `sidebarRight` / `sidebarRightTabs` only for the new
  board tab).
- **No horizontal overflow in the sidebar.** The subtitle uses
  `flex:1 1 100%; max-width:100%; overflow:hidden` with a 20px leading indent, so long Issue titles
  stay inside the session row; the stray horizontal scrollbar rectangle above the sidebar
  footer/avatar is gone. Bound rows still grow 32px→~41px; unbound sessions and workspace rows are
  untouched.

## Release 1.0.0 — first public release

**GitHub Projects & Issues** v1.0.0 was the first public release (the current release is **1.0.2**
above), and is **live on npm** as
[`@ceasarxuu/dsh-github-projects`](https://www.npmjs.com/package/@ceasarxuu/dsh-github-projects).
Source and issue tracker: <https://github.com/ceasarXuu/dsh-github-projects>; release notes:
<https://github.com/ceasarXuu/dsh-github-projects/releases/tag/v1.0.0>. Licensed MIT
([LICENSE](LICENSE)); notable changes per version: [CHANGELOG.md](CHANGELOG.md).

| | |
|---|---|
| npm package | `@ceasarxuu/dsh-github-projects` (public scoped package; 1.0.0 first published version) |
| Plugin Manager name | *GitHub Projects & Issues* / **GitHub 项目与议题** (from `locale/en.json` + `locale/zh.json`) |
| Repository | <https://github.com/ceasarXuu/dsh-github-projects> |
| Releases | [v1.0.2](https://github.com/ceasarXuu/dsh-github-projects/releases/tag/v1.0.2) · [v1.0.1](https://github.com/ceasarXuu/dsh-github-projects/releases/tag/v1.0.1) · [v1.0.0](https://github.com/ceasarXuu/dsh-github-projects/releases/tag/v1.0.0) |
| License | MIT |
| Host engines | `dsh >=0.2.1-rc.3 <0.3.0`; Node ≥ 22 |
| Runtime dependencies | none (host half uses only `node:*`; browser half uses the host-provided `react` / `react-dom`) |

Functionality is unchanged from 0.4.1 — 1.0.0 is the publication/identity release (the package was
renamed from the internal `@local/dsh-github-projects`). The 0.x feature notes below are **pre-public
history**.

## How it works

Binding is two levels deep, matching how GitHub context actually lives:

| Level | Bound to | Chosen from | Persisted |
|---|---|---|---|
| Project | a **workspace** (shared by all its sessions) | workspace-row board icon → right-sidebar board → project picker | `state.json` in your DSH profile |
| Issue | one **session** | an Issue card/row **Bind** button, an **agent tool**, or paste a link in the `issue` tab | `state.json` in your DSH profile |

The board reads the Project's items once (`GET /items`) and derives everything on the client: the
swimlane columns from the Projects v2 `Status` field, the milestone filter from the `milestone` field,
the text/status filters and their counts. It opens as a right-sidebar tab from the board icon in the
workspace row of the left sidebar (v1.0.2; it was a conversation-header `projects` tab through
v1.0.1), so it stays visible next to the conversation instead of taking a header slot. Clicking an
Issue/PR **card body or list row** opens its GitHub page in your **system default browser** as a new
tab (it does **not** bind); the explicit **Bind** action on the card/row binds that Issue to the
current session, updates the `issue` tab and adds the issue subtitle under the session title. `issue`
renders the title, state, body, labels and comments. Neither the board nor the `issue` view replaces
the shipped views: remove the plugin and the interface returns to normal.

All GitHub reads go through your locally authenticated [`gh` CLI](https://cli.github.com/). The
plugin stores no token, sends no telemetry, and never calls GitHub directly.

## Pre-public history (0.x feature notes)

> Historical: these describe the 0.x behavior at the time. **1.0.1 supersedes** the sidebar click and
> link-opening behavior below — Issue links now open in the system default browser, and the sidebar
> subtitle is non-interactive (row clicks open the session). **1.0.2** additionally moved the board
> out of the conversation header into the right sidebar; any `projects` tab references below are
> pre-1.0.2 history.

### What's new in 0.4.1 — issue subtitle in the sidebar session tree

- **The subtitle now also appears under every bound session row in the left sidebar** (selected or not,
  across all workspaces), matching the conversation-header subtitle: a tinted `#N` chip plus the
  issue title on a second line (single line, ellipsis, full `repo#N title` in the tooltip). The row
  grows from 32px to ~41px only while it has a subtitle; the first line (status, title, time, pin,
  actions) is untouched.
- Clicking the sidebar subtitle opened the Issue in DSH's built-in right-sidebar browser **without
  changing the selected session** (superseded in 1.0.1: the subtitle is a non-interactive `span` and
  the whole row opens the session).
- Binding changes — including agent-tool `bind`/`switch`/`unbind` — are reflected in the sidebar
  within **≤4 s** through a new local `GET /bindings` endpoint (poll ~4 s + immediate
  `binding-changed` event), with no `gh` call and no need to reopen the tree.
- Honest note: the shipped sidebar has no subtitle slot, so the client injects a guarded row via a
  `[data-row-key^="session:"]` DOM decorator (`:has()` layout override + MutationObserver); if the
  host DOM changes, the sidebar subtitle degrades to hidden without errors.

### What's new in 0.4.0 — issue subtitle, agent tools, browser-open and faster reads

- **Issue subtitle under the session title.** A session with a bound Issue shows `#N` (tinted chip)
  plus the issue title on one line (ellipsis; full `repo#N title` in the tooltip). Clicking it opened
  GitHub in DSH's built-in right-sidebar browser at the time (since 1.0.1 it opens in the system
  default browser). It updates within ~4 s of an agent-tool change and immediately after the plugin's
  own bind/unbind.
- **Click = open; Bind is explicit.** Clicking an Issue/PR card or list row opened the GitHub page in
  DSH's right-sidebar browser at the time (since 1.0.1 it opens in the system default browser)
  instead of binding. Use the explicit **Bind** button on the card/row to bind to the current session
  and jump to the `issue` tab. PR/Draft rows only open.
- **Agent tools.** The model can manage the current session's Issue binding with
  `github_issue_bind` / `github_issue_switch` / `github_issue_unbind` (args: an Issue URL or
  `owner/repo#123`). They only touch the **current session**, never write to GitHub, and the UI
  reflects the change within ≤4 s. Examples: “bind https://github.com/acme/web/issues/228 to this
  session”, “switch this session to acme/web#240”, “unbind this session's Issue”.
- **Faster reads.** `/projects` is now a single GraphQL call (~1.4 s vs ~3.1 s), `/items` uses
  paginated GraphQL (~3.4 s cold vs ~4.6 s, no separate project-view call), the host serves stale
  data instantly while revalidating in the background (SWR, `staleTtlMs` = 10 min) and persists a
  disk cache across restarts, `/config` never waits on `gh`, and warm projects opens render cached
  data with **no skeleton** (<300 ms host response; guarded by the e2e `projects-warm` stage).

### What's new in 0.3.0 — status color system + smarter lanes

- **A real status color system.** Lanes, list sections, type glyphs and the `issue` view now use a
  deliberate palette: `No status` neutral, `TODO` blue, `In Progress` amber, `In Review` violet,
  `Done` green, custom statuses cyan; Issues green, PRs violet, Drafts neutral; bound/selected uses
  the brand accent. Tints are derived with `color-mix`, so both DSH light and dark themes work — no
  hardcoded dark backgrounds.
- **Color = state, not decoration.** Saturated color is reserved for status/type/bound/primary
  actions; titles, meta, labels and body text stay neutral theme labels (no colored body text, and
  no information conveyed by color alone — every colored dot sits next to its text label).
- **Empty `No status` lane is hidden.** When the filtered `No status` count is 0 the lane no longer
  takes a column; the other four canonical lanes always render (empty ones show “No items”), and a
  custom-status lane only appears when it has items. The board exposes hidden canonical keys via
  `data-ghp-hidden-lanes`.
- **Light and dark both work.** Accent colors are theme-independent; every tint is derived with `color-mix` from the active DSH theme, so light mode keeps the same readable hierarchy (checked with a CDP probe against the light theme: tints/hairlines/dots stay readable with no dark-surface bleed; the probe shots are evidence only and not shipped — the automated harness runs dark only).
- **Hierarchy pass.** Lane heads get a status hairline + tinted count pill, cards are raised surfaces
  on sunken lanes, the toolbar gets a brand-tinted project tile, and empty/error states use a tinted
  icon tile — motion is limited to 120ms color/border transitions and respects
  `prefers-reduced-motion`.

### What's new in 0.2.1 (v1.1.1) — full-width layout

- The `projects` page (board **and** list) and the `issue` page now fill the conversation body width:
  `width: 100%`, **no `max-width` cap**, no centred fixed column. On wide Desktop windows the five
  lanes share the full available width equally instead of being squeezed into a centred ~1000px
  column.
- The 176px lane minimum is only the horizontal-scroll floor for narrow windows (below ~960px); it is
  not a page width cap. Empty-state copy may keep a readable measure — the page itself is full width.
- Regression guard: the new e2e `projects-wide` stage asserts at 2200×1300 that the page fills ≥85%
  of the body width → `artifacts/screenshots/11-projects-wide.png`.

### What's new in 0.2.0 (v1.1)

- **Swimlane board (default view).** Five fixed status columns left→right: `No status`, `TODO`,
  `In Progress`, `In Review`, `Done`. A custom Status the Project defines is never dropped — it gets
  one extra column appended on the right. Columns show the filtered card count; each column scrolls
  vertically and the board scrolls horizontally when the columns don't fit. Read-only: no drag and
  drop.
- **List view.** Toggle back to the earlier grouped layout (sections by status + status chips) with
  **Swimlane / List** in the toolbar (the Chinese UI says 泳道 / 列表).
- **Milestone filter.** `All` / `Backlog` (items without a milestone) / every milestone title found
  in the loaded items, naturally sorted and counted (`全部` in the Chinese UI). It combines with the
  text filter; if the selected milestone disappears after a refresh, the view falls back to `All`
  with a dismissible notice.
- **Whole-card actions.** An Issue card binds to the session (same as list **Bind**); a PR/Draft
  card opens GitHub. Cards are keyboard-activatable.

## Screens

All screenshots below are the **v1.0.2 authoritative e2e set** (refreshed 2026-10-29: fixture 18/18 and
real 19/19 stages PASS, console 0/0/0). `01`–`09` and `12`–`14` are 1280×800 harness captures, `11` is
the maximized right-sidebar pane at **2200×1300**, `10` is a manual real-Desktop capture and `15` is
regenerated by the post-publish release smoke. Stage definitions and the screenshot list live in
[`scripts/e2e/README.md`](scripts/e2e/README.md).

| | |
|---|---|
| ![session header](artifacts/screenshots/01-tabs.png) | ![unbound sidebar board](artifacts/screenshots/02-projects-empty.png) |
| Conversation header keeps `对话 / 轨迹 / issue` (the `projects` tab is gone); the workspace row carries the board icon. | Clicking the board icon opens the right-sidebar `项目` pane: unbound state with **选择 Project**. |
| ![project picker](artifacts/screenshots/03-projects-picker.png) | ![swimlane board](artifacts/screenshots/04-projects-board.png) |
| Project picker inside the right-sidebar pane (grouped by owner, filterable). | Real Project #9 board inside the pane: status colors, empty `No status` lane hidden (4 lanes: TODO 27 / In Progress 1 / In Review 1 / Done 166 = 195). |
| ![list view](artifacts/screenshots/05-projects-list.png) | ![milestone filter](artifacts/screenshots/06-projects-milestone.png) |
| List view: status-colored sections + chips (inside the pane). | Milestone `v1.2.0` filter active (195→19); `No status` stays hidden. |
| ![issue empty state](artifacts/screenshots/07-issue-empty.png) | ![issue detail](artifacts/screenshots/08-issue-detail.png) |
| Unbound session: choose from the board or paste a link. | Bound Issue: green Open badge, sticky header, body, labels. |
| ![issue comments](artifacts/screenshots/09-issue-comments.png) | ![maximized sidebar board](artifacts/screenshots/11-projects-wide.png) |
| Comments with author, relative time and links. | **2200×1300**: maximized right-sidebar board — pane 2199 px = 100 % of the window, `.ghp-page` 2191 px = 99.6 % of the pane, lanes equal. |
| ![external browser](artifacts/screenshots/12-external-open.png) | ![header subtitle](artifacts/screenshots/13-issue-subtitle.png) |
| Clicking an Issue card body opens GitHub in your **system default browser, new tab** — **no binding** is created. Bind via the card button. | Bound session shows an `#N` chip + issue title under the session title (one line, ellipsis; click opens it in the system browser). |
| ![sidebar subtitle](artifacts/screenshots/14-sidebar-subtitle.png) | ![manual Desktop capture](artifacts/screenshots/10-desktop-tabs.png) |
| Bound session row in the left sidebar: second line with `#240` chip + issue title (row 32→41 px, no horizontal overflow); the subtitle is **non-interactive** — clicking the row opens that session; bindings sync via `/bindings`. | Manual capture of the **real Desktop app** after install: three bound rows with their second-line issue subtitles (`#240 …` / `#289 …` / `#240 …`, clipped inside the row) and a clean footer/avatar area (`1438×1370`, sha256 `3860f7b9…988c`; header tabs `对话 / 轨迹 / issue`). |
| ![published install](artifacts/screenshots/15-published-install.png) | |
| Regenerated by the post-publish release smoke (the current file is the v1.0.1 history image until then). | |

`01`–`09` and `12`–`14` are captured by the isolated e2e harness in **real-host mode** against live
`gh` (real Project #9 and Issue #240; 1280×800; `09` needs `--extra-comments`); `11` is the same
harness at **2200×1300** with the right sidebar maximized. `10-desktop-tabs.png` is a manual capture of
the real Desktop app (not harness output). `15-published-install.png` is regenerated after the v1.0.2
publish, so it shows the previous release until then. The board/picker shots (`02`–`06`, `12`) capture
the v1.0.2 right-sidebar pane; `07`/`08`/`13`/`14` are captured with the right sidebar collapsed (plain
conversation), as before.

## Requirements

- **DeepSeek Harness 0.2.1-rc.3** (Web or Desktop; this is the version tested — see
  [Compatibility](#compatibility)). The plugin uses the `conversation.view` slot and the session
  standard props, plus (for the v1.0.2 right-sidebar board) the optional `sidebarRight` /
  `sidebarRightTabs` client services and guarded left-sidebar DOM decoration. These are host APIs and
  may change between DSH versions.
- **GitHub CLI (`gh`)** — a release whose `gh project` commands support GitHub Projects v2 with JSON
  output (`gh project list --format json`, `gh project item-list --format json`); verified with
  **2.96.0** (2026-07-02). It must be on the `PATH` of the DSH process, or configured via
  `ghCommand`.
- A `gh` login with the **`project`** scope; `repo` for private repositories and `read:org` for
  organization-owned Projects:

  ```sh
  gh auth login
  gh auth refresh -s project          # only if `gh auth status` lacks the project scope
  gh auth status                      # expect: Token scopes: ... 'project' ...
  ```

  Don't have `gh`? `brew install gh` on macOS, or see <https://cli.github.com/>. A standalone binary
  works too — put its absolute path in `ghCommand` if DSH can't see your shell `PATH`.

## Install

The plugin is **live on npm** as **`@ceasarxuu/dsh-github-projects@1.0.2`** (`latest` = 1.0.2).
Install it into the DSH profile your app runs (on a default Desktop install the profile is named `desktop`; use
`web` / `headless` if that is what you run). Installing needs write access to the profile directory.

**Plugin Manager (recommended):** Plugins → Add → `@ceasarxuu/dsh-github-projects` → install and
keep it enabled. The card shows the localized name/description from the package's `locale/` metadata
and the plugin icon.

**CLI:**

```sh
# install the published release into the desktop profile (pin @1.0.2)
dsh plugin --profile desktop add @ceasarxuu/dsh-github-projects@1.0.2

# verify it is installed in that profile
dsh plugin --profile desktop why @ceasarxuu/dsh-github-projects

# remove it again
dsh plugin --profile desktop remove @ceasarxuu/dsh-github-projects
```

Installing records the package in the profile and appends it to `dsh.profile.bundles`; the running
Desktop app hot-recomposes and loads both halves without a restart (the window reloads and may return
to the workspace home; sessions are untouched — reopen a session and its `issue` tab and the sidebar
board entry are there).

**Development — local checkout:** to run from this repository instead of npm, link the checkout:

```sh
dsh plugin --profile desktop add /absolute/path/to/dsh-github-projects
```

That records a `link:` dependency (the `link:` prefix may be omitted). Use this for development only;
installed users should use the npm package above.

> The registry also lists an internal staging version (`0.0.0-stage`). Install the release explicitly
> with `@1.0.2`; `latest` already points at 1.0.2.

## Use

1. Open a session and click the small **board icon** in its workspace row in the left sidebar (or, in
   an unbound `issue` tab, click **从项目选择**). The board opens as a tab in the **right sidebar**;
   clicking the workspace icon again focuses that tab instead of opening a duplicate.
2. **Choose a Project** → pick a Project from your account and organizations (or bind manually by
   `owner` + `number` when `gh project list` can't see it).
3. The bound Project opens as a **swimlane board** (default): scan the five status columns, or click
   **List** in the **Swimlane / List** toggle to switch to the grouped list view.
4. Narrow the view with the **milestone** dropdown (`All` / `Backlog` / a milestone) and/or the text
   filter — counts update in both board and list.
5. Click a card body/list row to open the Issue or PR in your **system default browser** as a new tab
   (this does not change the binding). Click the card/row **Bind** button to bind the Issue to the
   current session — the `issue` tab updates and the issue subtitle appears under the session title.
6. Alternatively, in an unbound `issue` tab paste a GitHub Issue URL or `owner/repo#123` and click
   **Bind**. Or just ask the model: “bind https://github.com/acme/web/issues/228 to this session”,
   “switch this session to acme/web#240”, “unbind this session's Issue” (agent tools).
7. The conversation-header issue subtitle can be clicked any time to reopen the Issue in the system
   browser. The sidebar subtitle is non-interactive: clicking anywhere on a session row opens that
   session.

Use **Refresh** to force a fresh read (cached data may be served stale for up to `staleTtlMs` while
it revalidates), **Change** to switch the workspace's Project, and **Unbind** (with confirmation) to
clear a binding. Unbinding a Project does not unbind session Issues.
Button labels above are the English UI copy; the Chinese UI localizes the same actions as
绑定 / 刷新 / 更换 / 解绑, and the view toggle as 泳道 / 列表.

## Configuration

Defaults ship in the bundle's `cordis.patch.yml`. Override them in your profile's
`cordis.patch.yml` under `id: github-projects`; overriding the row **replaces the whole `config`**,
so restate every key you need.

| Key | Default | Meaning |
|---|---|---|
| `ghCommand` | `gh` | `gh` executable. An absolute path is recommended, because a GUI app often has a shorter `PATH` than your terminal |
| `requestTimeoutMs` | `20000` | Timeout of one `gh` invocation |
| `cacheTtlMs` | `60000` | Fresh window of the in-memory cache; `refresh=1` waits for a fresh read |
| `staleTtlMs` | `600000` | Stale-serve window (10 min): expired entries are served immediately with `stale:true` while one background refresh revalidates |
| `diskCache` | `true` | Persist successful read results to `cacheFile` so a restart can render the last data before GitHub answers |
| `cacheFile` | `null` | Disk cache file; `null` resolves to `$DSH_HOME/plugin-data/github-projects/cache.json` |
| `maxProjectItems` | `200` | Upper bound of project items returned by one read |
| `maxComments` | `30` | Upper bound of Issue comments returned by one read |
| `healthCacheTtlMs` | `5000` | TTL of the cached `gh` health snapshot shared by `/config` and `/health` |
| `healthFirstReadTimeoutMs` | `3000` | **Legacy, no longer used** (since 0.4.0 `/config` never waits for a probe); accepted only for older configs |
| `statePath` | `null` | Binding file; `null` resolves to `$DSH_HOME/plugin-data/github-projects/state.json` |

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: github-projects
  name: '@ceasarxuu/dsh-github-projects'
  config:
    ghCommand: /opt/homebrew/bin/gh
    requestTimeoutMs: 30000
    cacheTtlMs: 120000
    staleTtlMs: 600000
    diskCache: true
    cacheFile: null
    maxProjectItems: 200
    maxComments: 30
    healthCacheTtlMs: 5000
    healthFirstReadTimeoutMs: 3000
    statePath: null
```

## Privacy and network

- **Only `gh` talks to GitHub.** The plugin's own network surface is a loopback HTTP route
  (`/plugin/github-projects`) consumed by the DSH web client; nothing is sent to external servers.
- **No token access.** The plugin never reads `GITHUB_TOKEN`/`GH_TOKEN`, never stores a token and
  never logs one. Authentication and its scopes are entirely `gh`'s.
- **No telemetry**, no analytics, no external images or avatars. Issue bodies are rendered as a safe
  Markdown subset (no HTML, no remote images).
- **Local state is tiny:** `state.json` only holds Project/Issue titles, URLs, numbers and state
  summaries, plus binding timestamps. Delete it to reset all bindings.
- **Read-only:** every GitHub call is a read. The plugin has no endpoint that writes to GitHub.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `gh-missing` (“gh CLI not found”) | `gh` not installed, or not on the DSH process `PATH` | Install `gh`; set `ghCommand` to its absolute path (`which gh`) |
| `gh-auth` (“run gh auth login first”) | Not logged in, or missing `project` scope | `gh auth login`; `gh auth refresh -s project` (add `read:org` for org Projects) |
| `gh-failed` (“GitHub read failed”) | Network, GitHub error, or a rate limit | Retry; check `gh project list --owner <you>` in a terminal; wait if rate-limited |
| `timeout` | Slow network / very large Project | Retry; raise `requestTimeoutMs` |
| Board (or the `issue` tab's 从项目选择) says “This session is not in a workspace” | Project bindings belong to a workspace; this session has none | Move the session into a workspace, then bind |
| Board icon missing in workspace rows | Host build without the `sidebarRight` / `sidebarRightTabs` client services, or a changed sidebar DOM | Update DSH/plugin; the `issue` tab and subtitles keep working; see [Known limitations](#known-limitations) |
| “This is a Pull Request” | The bound reference points at a PR, not an Issue | Bind the Issue instead; PR rows open on GitHub |
| Desktop returns to the workspace home right after install | Normal HMR profile recompose | Reopen a session; its data is untouched and the `issue` tab + sidebar board entry are there |
| Tabs/board entry missing after install | Bundle not enabled in the profile, or DSH not recomposed | Check `dsh.profile.bundles`, enable via plugin manager, reload |
| A “gh CLI unavailable” warning flashes right after opening | Cold start: `/config` never waits for `gh` and returns the `error:"pending"` placeholder while a background probe runs | Harmless; it clears once the probe finishes (read `/config` again or reopen the tab) |
| Stale list | 60-second cache | Click **Refresh** |
| “Binding save failed” | `statePath` unwritable (permissions/disk) | Check the path and permissions; or set `statePath` to a writable file |

## Development

Plain ESM JavaScript, **no build step and no bundled npm dependencies** (the browser half uses the
host-provided `react` / `react-dom`). Node ≥ 22.

```sh
node --check index.js && node --check client.js   # syntax check
node --test test/host/*.test.mjs                  # host unit tests (offline, gh fixtures)
node scripts/e2e/run.mjs                          # isolated e2e: temp DSH_HOME + headless Chrome
node scripts/e2e/run.mjs --mode=real              # same, against the real gh CLI
```

Layout:

| File | Role |
|---|---|
| `index.js` | Cordis host plugin: HTTP API, request gating, cache/single-flight |
| `github.js` | `gh` CLI adapter, normalizers, Issue-ref parser |
| `state.js` | Durable binding store (atomic JSON writes) |
| `client.js` | Browser half: `conversation.view` entry (`issue`) + right-sidebar board tab, workspace-row entry icon, React views, safe Markdown renderer |
| `dev/mock-host.js` | Contract-shaped mock host for UI/e2e without `gh` |
| `test/` | Host unit tests + captured `gh` fixtures |
| `artifacts/screenshots/` | e2e acceptance screenshots |

### Local API

The browser half talks to the plugin over a loopback-only JSON API (prefix
`/plugin/github-projects`; `application/json`, `cache-control: no-store`, errors as
`{"error":{"code","message"}}`). Ten endpoints:

| Method + path | Purpose |
|---|---|
| `GET /health` | `gh` availability |
| `GET /config?sessionId=&workspaceId=` | current bindings + cached `gh` health (never waits on `gh`) |
| `GET /bindings` | every durable session→Issue and workspace→Project binding (local only; polled ~4 s for the sidebar subtitle and workspace entry icon) |
| `GET /projects?refresh=1` | accessible Projects, grouped by owner (SWR, `stale` flag) |
| `GET /items?owner=&number=&refresh=1` | one Project's items (paginated GraphQL, `stale` flag) |
| `GET /issue?repo=owner/name&number=N&refresh=1` | one Issue + comments (`stale` flag) |
| `POST /bind-workspace` | bind a Project to a workspace |
| `POST /unbind-workspace` | clear a workspace binding |
| `POST /bind-issue` | bind an Issue to a session |
| `POST /unbind-issue` | clear a session binding |

Only the plugin's own browser half consumes it; POSTs are origin/content-type/size gated, and nothing
writes to GitHub.

The e2e harness runs in an isolated temp `DSH_HOME` and workspace on its own port — it never touches
your running profile or the window you're using. See [`docs/DESIGN.zh.md`](docs/DESIGN.zh.md) for the
Chinese design document and [`docs/CONTRACT.md`](docs/CONTRACT.md) for the frozen interface.

## Compatibility

| | |
|---|---|
| Plugin version | **1.0.2** (right-sidebar project board + ProjectPicker replay fix on top of 1.0.1) |
| Host engine | `engines.dsh`: `>=0.2.1-rc.3 <0.3.0`; Node ≥ 22 |
| Verified DSH | 0.2.1-rc.3 (Desktop + `dsh web`) |
| Verified `gh` | 2.96.0 (2026-07-02) |
| Verified OS | macOS (headless Chrome 156 for e2e) |
| Node (host half) | ≥ 22 |
| Runtime dependencies | none (browser half uses host-provided `react` / `react-dom`) |
| Acceptance | v1.0.2 pre-publish gate **GREEN**: frozen `client.js` sha256 `684f2953…384e2`; host tests **92/92**; independent picker-replay verifier **6/6 checks**; authoritative repo-e2e **PASS** — fixture **18/18** executed stages (run dir `2026-10-28T22-18-34-867Z`), real **19/19** stages (run dir `2026-10-28T22-20-03-025Z`), console **0/0/0**, new `project-picker-replay` stage PASS, refreshed authoritative screenshot set `01`–`14` (`11` at 2200×1300, `10` manual). Remaining post-publish only: npm 1.0.2 live (dist-tag `latest`), clean-profile release-smoke install and tag/release confirmation — recorded in [the evidence chapter](docs/DESIGN.zh.md#8-验收与验证证据) after publication. v1.0.1 shipped with clean-profile install smoke **PASS**, fixture 17/17 + real 18/18 e2e stages PASS, 91/91 host tests and 15 screenshots. |

`engines.dsh` is `>=0.2.1-rc.3 <0.3.0` (verified on DSH 0.2.1-rc.3 only). A DSH upgrade outside that
range — or one that changes the `conversation.view` slot, session standard props, the
`sidebarRight` / `sidebarRightTabs` client services, or the workspace/session sidebar DOM anchors —
may require a plugin update.

## Known limitations

- **Read-only.** No writing to GitHub: no status changes, comments, issue creation or field edits.
- **The board is read-only:** no drag-and-drop between columns, no manual card ordering.
- **Lane visibility follows the filter:** the `No status` lane is hidden when its filtered count is 0
  (the four other canonical lanes always show), and a custom-status lane only appears when it has
  items — so the number of lanes changes with your milestone/text filters.
- **Color is supplementary:** status/type colors are backed by text labels (dots are decorative);
  body text and titles stay neutral, and no information is conveyed by color alone.
- **Board layout:** since v1.0.2 the board renders in DSH's **right sidebar**, so it adapts to that
  narrow pane: the toolbar wraps, the board scrolls horizontally and the list stays usable. Columns
  have a 176px minimum width. A status the board doesn't know gets its own read-only extra column on
  the right; an empty column keeps its header, a 0 count and a “No items” placeholder. (Through
  v1.0.1 the board was a full-width conversation tab with no page width cap; the `issue` page still
  fills the conversation body width.)
- **Host layout is untouched:** the right-sidebar board lives in the host's own sidebar pane; the
  `issue` page fills the conversation body, but DSH's composer keeps the shell's centred width.
- **Right-sidebar board needs the optional host services:** the v1.0.2 board registers a custom tab
  through `sidebarRightTabs` and opens it through `sidebarRight.openTab`, and the workspace icon is
  injected into `[data-row-key^="workspace:"]` rows. If a host build lacks those services the icon is
  simply not injected (no errors) and the board cannot be opened; the `issue` tab and both subtitles
  keep working. A DSH upgrade that changes the sidebar DOM or the custom-tab API needs re-checking.
- **Milestone filter scope:** options and counts come from the loaded items only (capped by
  `maxProjectItems`); milestones of items beyond the cap are not listed.
- **View mode is a local preference:** switching between board and list is remembered per client and
  not written to the profile binding file.
- **One Project per workspace**, one Issue per session.
- **Issue-only detail.** PR and draft rows open on GitHub; PRs cannot be bound to a session.
- **No item state in the list.** The items payload does not include each item's open/closed state, so
  the board/list doesn't show it; the `issue` tab (REST) does.
- **Caps:** up to `maxProjectItems` items (GraphQL pagination stops at the cap) and `maxComments`
  comments (oldest first) per read; there is no client "load more". Long issue bodies are truncated at
  100,000 characters.
- **Issue subtitle and workspace entry are host-DOM fragile:** the shipped header has no subtitle
  slot, so the plugin inserts a guarded portal row under the title; the sidebar has no slot either,
  so guarded decorators inject a second line into `[data-row-key^="session:"]` rows (`:has()` height
  override + MutationObserver) and one board icon into `[data-row-key^="workspace:"]` rows. If a DSH
  upgrade changes these DOMs, the subtitle/icon degrades to hidden (no errors, nothing else breaks)
  and needs re-checking.
- **Sidebar subtitle updates on a ~4 s poll:** the header/sidebar listen to a local `binding-changed`
  event for the plugin's own actions, but agent-tool changes may take up to ~4 s to show in the
  sidebar. Bound rows grow from 32px to ~41px while a subtitle is present; unbound rows stay 32px.
- **Agent tools only target the current session:** there is no parameter to bind/unbind another
  session. They also need a host with `ctx.tools` and an owning agent; the UI reflects tool changes
  via a cheap local poll (≤4 s), not a push channel.
- **External links need popup permission:** Issue links open via
  `window.open(url, '_blank', 'noopener,noreferrer')` (same as DSH's "Open in system browser"), so a
  browser/desktop setting that blocks popups can suppress the new tab. The plugin does not detect the
  block; if nothing opens, allow popups for DSH and retry.
- **Sidebar subtitle is intentionally non-interactive:** it is plain text under the session title —
  clicking the row (including the subtitle) selects that session; it never opens the Issue. Use the
  card/list row, the conversation-header subtitle, or the Issue view's GitHub link to open GitHub.
- **SWR freshness:** for up to `staleTtlMs` (10 min) you may see cached data first while a background
  refresh runs, and a restarted DSH can render the disk cache before GitHub answers. Click **Refresh**
  for a fresh read. The disk cache stores GitHub read results (no tokens) under your DSH profile —
  delete it or set `diskCache: false` if you don't want it.
- **Latency numbers are reference values** measured on this machine (single GraphQL `/projects`
  ~1.4 s, paginated `/items` ~3.4 s cold, warm re-open 27–72 ms with no skeleton); they vary with
  network, project size and `gh` version. The real-data cold board measured 3.70 s, slightly above the
  3.5 s expectation and logged rather than failed.
- **No search across Projects** and no cross-Project view.
- **Bindings are per profile**, not stored with the repository; another machine or profile starts
  unbound.
- **Markdown subset only:** no HTML, images or tables in the rendered body; task-list checkboxes are
  display-only.
- **No polling/push:** GitHub-side changes appear after a refresh.
- **`gh`-dependent:** without a working, authenticated `gh` you can still see bound summaries
  (from local state) but not lists or details.

## License

MIT — see [LICENSE](LICENSE). Changes: [CHANGELOG.md](CHANGELOG.md); release checklist:
[RELEASING.md](RELEASING.md). Source: <https://github.com/ceasarXuu/dsh-github-projects>.
Chinese README: [README.zh.md](README.zh.md).
