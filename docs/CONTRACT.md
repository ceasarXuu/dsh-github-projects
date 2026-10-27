# CONTRACT — dsh-github-projects v1

Owner: Team Lead. This file is the frozen interface between the host half, the client half,
the e2e harness, and the docs. Do not change it without asking the Lead; propose changes via
`send_message` to `lead`.

Goal (user request, verbatim intent): 给工作区绑定 GitHub Projects，在 session 界面看到 `projects`
页签；并支持给每个对话 session 绑定 issue，在 `issue` 页签直接看到该 issue。

Reference screenshot: the session header has the shipped `对话` / `轨迹` tabs; the plugin adds two
more tabs labelled exactly `projects` and `issue` (lowercase, no translation).

## 1. Product shape

- Two `conversation.view` slot entries, `scope: 'session'`, appended after the shipped views:
  - `id: 'github-projects'`, order `20`, label `projects`
  - `id: 'github-issue'`, order `21`, label `issue`
- `projects` tab: shows the GitHub Project bound to the **workspace** of the current session. Default
  view is a status swimlane board (`No status` / `TODO` / `In Progress` / `In Review` / `Done`,
  left→right), with a toggle to the earlier grouped list; a milestone filter offers `全部`,
  `Backlog` (no milestone) and every milestone present in the Project. Binding/replacing/unbinding
  the workspace Project is done from this tab.
- In `projects`, clicking an Issue/PR card or list row opens its GitHub page in DSH's **built-in
  right sidebar browser**; binding is an explicit `绑定` action on the card/row (v0.4.0).
- `issue` tab: shows the Issue bound to the current **session** (header, body, labels, comments).
  If unbound: empty state that offers `从项目选择` (switches to projects tab) or pasting an Issue
  URL / `owner/repo#123`.
- A session with a bound Issue shows a **subtitle under the session title** in the conversation
  header: a `#228` label chip + issue title (one line, ellipsis), e.g. `#228 修复界面bug` (v0.4.0).
- The model can bind / unbind / switch the current session's Issue through three agent tools
  (`github_issue_bind` / `github_issue_switch` / `github_issue_unbind`, v0.4.0); the UI updates
  without a manual refresh.
- Everything is read-only against GitHub. No writes to GitHub in v1.
- Binding state is durable plugin data, shared by all sessions of a profile (workspace → Project is
  per workspace; session → Issue is per session).

## 2. Repository and files

Repo root: `/Volumes/inwolf-4T/projects/dsh-github-projects`

| File | Owner (write scope) | Purpose |
|---|---|---|
| `index.js` | host-github | Cordis host plugin entry (`export const name`, `export function apply(ctx, config)`) |
| `github.js` | host-github | `gh` CLI adapter, GraphQL/REST queries, normalizers, ref parser |
| `state.js` | host-github | Durable binding store (atomic JSON write) |
| `client.js` | client-ui | Browser plugin: slots, views, UI, fetch client, CSS, locale dicts |
| `package.json`, `cordis.patch.yml`, `icon.svg`, `docs/CONTRACT.md` | Lead | package manifest / bundle patch / identity |
| `dev/mock-host.js` | Lead | contract-shaped mock host for UI/e2e development (fixtures, no `gh`) |
| `test/fixtures/*` | Lead | real `gh` outputs captured 2026-10-28 (provenance in `test/fixtures/README.md`) |
| `test/host/**` | host-github | `node --test` unit tests |
| `scripts/e2e/**`, `artifacts/**` | verifier | isolated `dsh web` + headless Chrome harness, screenshots |
| `README*.md`, `docs/DESIGN.zh.md` | doc-writer | installation + design doc (Chinese) |

Plain ESM JavaScript only. No npm dependencies, no build step. Host half must run on Node ≥ 22 and
may import only `node:*` builtins and its own local files. Client half may `require` **only**
`react` / `react-dom` (platform module table); it must not import `@deepseek-ai/*` packages.

Validated environment facts (installed app, DSH 0.2.1-rc.3):
- Installed runtime JS extraction for API discovery: `/tmp/dsh-runtime2/dsh/node_modules/@deepseek-ai/`
  (`lib/client.js` is the shipped browser code, `lib/index.js` the host code).
- Typed API packages for 0.2.1-rc.3: `/tmp/dsh-types/node_modules/@deepseek-ai/` (`.d.ts`).
- Working reference plugin (host + client halves, verified on this app):
  `/Volumes/inwolf-4T/projects/dsh-session-cost/{index.js,client.js,cordis.patch.yml,package.json}`.
- Source checkout (older 0.1.7 docs; use only for concepts): `/Volumes/inwolf-4T/projects/deepseek-harness-desktop`.

## 3. Host plugin

`index.js` exports `name = 'github-projects'`, `inject = ['webServer', 'tools']`, and `apply(ctx, config)`.
The `inject` export is mandatory: rows inserted by a bundle patch or a `--patch` overlay can activate
before the `webServer` fiber (which waits for `webStartup`), and an un-awaited service would silently
mount no routes. (Loader-delayed activation also means `apply` may run long after boot; do not assume
`ctx.get('webServer')` is undefined-safe — it must be present by activation contract.)

- Read `ctx.get('webServer')` after activation (`ctx.get` may be undefined for optional services).
  Register **one prefix route** `/plugin/github-projects` with
  `webServer.register({ kind: 'prefix', path, handler })`, owned by `ctx.effect(...)` so it is
  removed on unload. The handler owns the full `node:http` request/response.
- `config` may be absent/partial when loaded through a bare `--patch` overlay: apply defaults in
  code (`resolveConfig`), do not rely on Schemastery.
- Logs: keep quiet by default (one info line at load is fine); errors go to `console.warn` only for
  unexpected programming faults. Never log tokens or full issue bodies.
- Everything else lives in `github.js` (gh adapter + normalizers) and `state.js` (bindings).

### 3.0 Config keys

`cordis.patch.yml` ships these defaults; a profile patch for row id `github-projects` replaces the
whole `config` object, so restate every key you need there.

| Key | Default | Meaning |
|---|---|---|
| `ghCommand` | `gh` | `gh` executable (absolute path recommended). |
| `requestTimeoutMs` | `20000` | One `gh` invocation deadline (1 s – 10 min). |
| `cacheTtlMs` | `60000` | Fresh window of the SWR read cache (`refresh=1` waits for a fresh read). |
| `staleTtlMs` | `600000` | How long expired entries may still be served immediately as `stale: true` while one background refresh revalidates them. |
| `diskCache` | `true` | Persist successful reads to `cacheFile` and load them at plugin start (restart-friendly). |
| `cacheFile` | `$DSH_HOME/plugin-data/github-projects/cache.json` | Bounded atomic cache snapshot (`null` resolves the default; ≤40 entries / ≤8 MiB). |
| `maxProjectItems` | `200` | Upper bound of items returned by one `/items` read (GraphQL pages of 100). |
| `maxComments` | `30` | Upper bound of comments returned by one `/issue` read. |
| `healthCacheTtlMs` | `5000` | TTL of the cached `gh` health probe; `/config` never waits for it, `/health` awaits a fresh probe. |
| `healthFirstReadTimeoutMs` | `3000` | Legacy key still accepted so old profile patches load; unused by v0.4.0 (config is non-blocking). |
| `statePath` | `$DSH_HOME/plugin-data/github-projects/state.json` | Durable binding file (`null` resolves the default). |

### 3.1 HTTP API (prefix `/plugin/github-projects`)

All responses are `application/json; charset=utf-8`, `cache-control: no-store`, UTF-8.
Errors are a non-2xx status plus `{"error":{"code":"...","message":"human message"}}`.

| Method + path | Purpose | 2xx body |
|---|---|---|
| `GET /health` | `gh` availability | `{"ok":true,"gh":GhHealth}` |
| `GET /config?sessionId=&workspaceId=` | current bindings + cached `gh` health (see notes) | `{"gh":GhHealth,"workspace":WorkspaceBinding,"session":SessionBinding}` |
| `GET /projects?refresh=1` | accessible Projects, grouped by owner | `{"owners":[Owner],"projects":[Project],"fetchedAt":ISO,"stale":bool,"errors":[OwnerError]}` |
| `GET /items?owner=&number=&refresh=1` | one Project's items | `{"project":Project,"items":[ProjectItem],"fetchedAt":ISO,"truncated":bool,"stale":bool}` |
| `GET /issue?repo=owner/name&number=N&refresh=1` | one Issue + comments | `{"issue":IssueDetail,"fetchedAt":ISO,"stale":bool}` |
| `POST /bind-workspace` | bind Project to a workspace | `{"ok":true,"workspace":WorkspaceBinding}` |
| `POST /unbind-workspace` | clear workspace binding | `{"ok":true}` |
| `POST /bind-issue` | bind Issue to a session | `{"ok":true,"session":SessionBinding}` |
| `POST /unbind-issue` | clear session binding | `{"ok":true}` |

Types (exact field names; extra fields are allowed but should be avoided):

```ts
type GhHealth = {
  available: boolean
  version: string | null       // e.g. "gh version 2.96.0 (2026-07-02)"
  account: string | null       // "gh api user --jq .login"
  error: string | null         // short message when unavailable/unauthenticated
}

type Owner = { login: string, type: 'user' | 'organization' }

type Project = {
  owner: string
  ownerType: 'user' | 'organization'
  number: number
  title: string
  url: string | null           // github.com/users/<owner>/projects/<number> for user owners
  itemCount: number | null
  closed: boolean
  description: string | null   // gh `shortDescription` (truncated to 500 chars)
}

type ProjectItem = {
  id: string
  type: 'issue' | 'pr' | 'draft'
  number: number | null
  repo: string | null          // "owner/name"
  title: string
  url: string | null
  state: 'OPEN' | 'CLOSED' | 'MERGED' | null
  status: string | null        // Projects v2 Status field value, e.g. "In Progress"
  labels: string[]
  milestone: string | null
}

type IssueSummary = {
  repo: string                 // "owner/name"
  number: number
  title: string
  url: string
  state: 'open' | 'closed' | string   // GitHub REST spelling; UI upper-cases
}

type IssueComment = {
  id: string
  author: string | null        // login, null for ghost
  createdAt: string            // ISO-8601
  body: string
  url: string | null
}

type IssueDetail = IssueSummary & {
  author: string | null
  createdAt: string
  updatedAt: string
  labels: string[]             // label names only
  assignees: string[]          // logins
  body: string
  bodyTruncated: boolean
  commentCount: number
  comments: IssueComment[]     // oldest first; at most config.maxComments
  commentsTruncated: boolean   // commentCount > comments.length
}

type WorkspaceBinding = {
  workspaceId: string
  project: Project | null
}

type SessionBinding = {
  sessionId: string
  issue: IssueSummary | null
  workspaceId: string | null
}
```

Request bodies (POST, `content-type: application/json`, ≤ 64 KiB):

```jsonc
// POST /bind-workspace
{ "sessionId": "session-…", "workspaceId": "uuid", "workspacePath": "/abs/path",
  "project": { "owner": "ceasarXuu", "ownerType": "user", "number": 9,
               "title": "Astropath-issues", "url": "...", "itemCount": 195, "closed": false,
               "description": null } }
// -> { "ok": true, "workspace": { "workspaceId": "uuid", "project": Project } }

// POST /bind-issue — two accepted forms
{ "sessionId": "session-…", "workspaceId": "uuid",
  "issue": { "repo": "ceasarXuu/Astropath", "number": 240, "title": "…", "url": "…", "state": "open" } }
{ "sessionId": "session-…", "workspaceId": "uuid",
  "ref": "https://github.com/ceasarXuu/Astropath/issues/240" }   // or "ceasarXuu/Astropath#240"
// -> { "ok": true, "session": { "sessionId": "...", "issue": IssueSummary, "workspaceId": "uuid" } }
```

Behaviour rules:
- `bind-workspace` requires `workspaceId`; `sessionId` is accepted for client convenience and may be
  omitted. It stores the Project summary as given (client normally gets it from `/projects`).
- `bind-issue` requires `sessionId`. With `issue` it stores it; missing `title`/`url` may be filled
  from a `gh` read. With `ref` it must resolve and fetch the issue via `gh` (404 → `issue-not-found`,
  bad ref → `bad-request`).
- `/config` reads local bindings: `workspaceId`/`sessionId` come from the query; missing/unknown ids
  yield `project: null` / `issue: null` (not errors). It NEVER waits for GitHub: the `gh` field is the
  last cached health snapshot, or `{available:false,version:null,account:null,error:'pending'}` on a
  cold start, while one background probe refreshes it (`healthCacheTtlMs`). A failed probe never
  fails the endpoint. (v0.4.0 supersedes the earlier bounded first read.)
- `/items` and `/issue` never write GitHub. Without `gh`, all GitHub reads fail with `gh-missing`
  (503) or `gh-auth` (503) while `/config` still works.
- Caching (v0.4.0): SWR in-memory cache per key (`projects`, `items:<owner>/<number>`,
  `issue:<repo>#<number>`) with `cacheTtlMs` as the fresh window and `staleTtlMs` (default 600000) as
  the stale-serve window. A stale entry returns immediately with `stale: true` and one background
  refresh revalidates it (single-flight); `refresh=1` waits for a fresh read (`stale: false`); a cold
  key waits. Successful values also persist best-effort to
  `$DSH_HOME/plugin-data/github-projects/cache.json` (bounded, atomic; disable with
  `diskCache: false`) and load at plugin start. See §3.5.
- Error codes: `bad-request` 400, `not-found` 404, `issue-not-found` 404,
  `project-not-found` 404, `gh-missing` 503, `gh-auth` 503, `gh-failed` 502, `timeout` 504,
  `state-write-failed` 500, `internal` 500. Gate-level answers use their own codes:
  `forbidden` 403 (Origin), `unsupported-media-type` 415 (POST content type), `payload-too-large`
  413 (body cap).
- Request gating: reject a POST when an `Origin` header is present and is not `dsh-app://app` or a
  loopback authority (`http(s)://127.0.0.1[:port]` / `http(s)://localhost[:port]` / `[::1]`) (403);
  a missing `Origin` is allowed (the Desktop shell forwards same-origin requests without one).
  Reject non-JSON POST content types (415). Cap body size (413). GET routes are read-only and
  unauthenticated (loopback server only). Never echo environment variables or tokens.

### 3.2 `gh` adapter (`github.js`)

Use `child_process.execFile` (promisified) with `{ env: process.env, timeout: config.requestTimeoutMs,
maxBuffer: 32 * 1024 * 1024 }`. Spawn the configured `ghCommand`; capture stdout; on nonzero exit
classify stderr: contains `auth login` / `authenticate` / `401` → `gh-auth`; `ENOENT` → `gh-missing`;
timeout → `timeout`; else `gh-failed`. Keep the last 500 chars of stderr in the thrown error message
but never include stdout bodies in errors.

Queries (verified 2026-10-28, `gh` 2.96.0 — fixtures in `test/fixtures/`):

1. Identity: `gh api user --jq {login}` and `gh api user/orgs --jq [...]` (orgs for owners list).
2. Projects per owner: `gh project list --owner <owner> --format json --limit 100`
   → `{ "projects": [ { closed, id, number, owner:{login,type}, public, readme,
   shortDescription, title, url, items:{totalCount} } ] }`.
   `ownerType` = `lowercase(owner.type)` (`User` → `user`, `Organization` → `organization`).
   Aggregate current user (`gh api user`) first, then every org from `gh api user/orgs`; owners whose
   `gh project list` fails contribute an entry in `errors` and do not fail the whole response.
3. Project items: `gh project item-list <number> --owner <owner> --format json --limit <max>`
   plus one concurrent `gh project view <number> --owner <owner> --format json` to fill the
   response's `project` field (a 404 from either read maps to `project-not-found`).
   → `{ "items": [ { id, title, status, labels: string[], milestone: {title}|null,
   repository: "<html url>", content: { type: "Issue"|"PullRequest"|"DraftIssue", number,
   repository: "owner/name", title, url, body } } ], "totalCount" }`.
   Map `type`: Issue → issue, PullRequest → pr, DraftIssue → draft. `state` is not in this payload;
   leave `state: null` for items (or `CLOSED` only when a future payload carries it).
   `truncated` = `totalCount > items.length`.
4. Issue detail: REST is the contract:
   `gh api repos/<owner>/<repo>/issues/<number>` → issue JSON; then
   `gh api "repos/<owner>/<repo>/issues/<number>/comments?per_page=<maxComments>"`.
   `body` is truncated client-side by the host to 100_000 chars (`bodyTruncated`).
   Reject when the REST payload has `pull_request` (PRs are not Issues for binding): use
   `issue-not-found` with message "这是 Pull Request".
5. `parseIssueRef(text)` accepts `https://github.com/<owner>/<repo>/issues/<n>` (also `http`, trailing
   slash/query), `github.com/...`, `owner/repo#123`, `owner/repo 123`. Returns `{repo, number}` or
   `null`.

### 3.3 Binding store (`state.js`)

Path: `config.statePath ?? path.join(process.env.DSH_HOME ?? path.join(homedir(), '.dsh'),
'plugin-data', 'github-projects', 'state.json')`. Create parent dirs recursively.
File format (JSON, version 1), written atomically (`state.json.tmp` + `renameSync` within the same
directory):

```json
{
  "version": 1,
  "updatedAt": "2026-10-28T04:00:00.000Z",
  "workspaces": {
    "<workspaceId>": {
      "project": { "owner": "...", "ownerType": "user", "number": 9, "title": "...",
                   "url": "...", "itemCount": 195, "closed": false, "description": null },
      "boundAt": "2026-10-28T04:00:00.000Z"
    }
  },
  "sessions": {
    "<sessionId>": {
      "issue": { "repo": "ceasarXuu/Astropath", "number": 240, "title": "...",
                 "url": "...", "state": "open" },
      "workspaceId": "uuid",
      "boundAt": "2026-10-28T04:00:00.000Z"
    }
  }
}
```

Reads tolerate a missing/corrupt file (return empty store); writes serialize through one queue and
keep the previous file if the write fails (throw `state-write-failed`). Methods (pure-ish, no ctx):
`createStateStore(path)` → `{ read(), getWorkspace(workspaceId), getSession(sessionId),
bindWorkspace(workspaceId, project), unbindWorkspace(workspaceId), bindIssue(sessionId, issue,
workspaceId), unbindIssue(sessionId), snapshot() }`.

### 3.4 Agent tools (v0.4.0)

The host plugin registers three tools on `ctx.tools`, so the model can bind / unbind / switch the
current session's Issue without the UI. `exec.agent.session.id` is the current session; tools never
address another session. Definitions use plain JSON-Schema (`parameters`, `output.schema`,
`output.render`); `execute` validates `ref` with `parseIssueRef`, resolves the issue through `gh`,
writes the binding store, and returns the canonical value.

| Tool | Args | Behaviour / output |
|---|---|---|
| `github_issue_bind` | `ref: string` (issue URL or `owner/repo#123`) | bind the Issue to the current session; output `{"bound":true,"issue":IssueSummary,"previous":IssueSummary\|null}`; refuses when already bound (use switch) |
| `github_issue_switch` | `ref: string` | replace the binding; `not bound` error when nothing is bound yet; output `{"switched":true,"issue":IssueSummary,"previous":IssueSummary}` |
| `github_issue_unbind` | — | clear the binding; output `{"unbound":true,"previous":IssueSummary\|null}` |

Rules: tools require an owning agent (`no current session` error otherwise); `gh`/ref failures surface
as the contract error codes; after a write the client reflects the binding within ≤4 s (subtitle +
`issue` tab) without a manual refresh; `output.render` returns one text block such as
`已绑定 #240 [v1.2.0]…`. Registration is owned by `ctx.effect` so disabling the plugin removes it.

### 3.5 Caching and latency (v0.4.0)

The user opens the projects tab often; the read path must not block on GitHub after the first load.

- `/config` never waits for a `gh` probe (see §3.1); a cold boot returns the `pending` snapshot.
- `/projects` uses ONE `gh api graphql` call (viewer projects + viewer organizations' projects),
  keeps only `closed === false` entries, and preserves the per-owner `errors` array.
- `/items` uses `gh api graphql` paginated at 100 nodes/page; `project` metadata comes from the same
  payload (no separate `gh project view`); pages are fetched sequentially until `totalCount` or
  `maxProjectItems` is reached; `truncated` reflects the cap.
- Client: module-level SWR caches render cached data immediately and revalidate in the background;
  a `stale: true` response triggers one retry after ~1.2 s; `config` and `items` load in parallel
  (remembered workspace→Project mapping); the bound Issue detail is prefetched after config; a cold
  skeleton appears only when no cached data exists.
- Acceptance: warm projects open renders cached data with no skeleton (<300 ms host response); cold
  first board load on a 195-item Project is logged and expected ≤3.5 s.

## 4. Client plugin (`client.js`)

Pattern proven on this exact app (see `/tmp/dsh-hello-plugin/client.js` and session-cost):

```js
window.__ModuleLoader__.load({
  id: '@local/dsh-github-projects',
  factory(require) {
    const React = require('react')
    // ... module body, components, dictionaries, css string ...
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register('githubProjects', { zh, en }), '…')
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'github-projects',
        order: 20,
        locale: 'githubProjects',
        label: () => 'projects',
      }, ProjectsView))
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'github-issue',
        order: 21,
        locale: 'githubProjects',
        label: () => 'issue',
      }, IssueView))
    }
    return { inject: ['slots', 'locale'], apply }
  },
})
```

Component props (verified in DSH 0.2.1-rc.3; slot catalog in
`/tmp/dsh-runtime2/.../dsh-cordis-client-runner/lib/client.js` around `key: "conversation.view"`):
- owner share: `inspectCall`, `viewRequest`, `openView(view, focus)`, `completeViewRequest()`
- session standard kit: `sessionId`, `useSession`, `useProjection`, `useConversation`, ...
- global standard kit: `useSessions`, `useWorkspaces`, `useSessionStatus`, ...; plus `t` because the
  registration declares `locale`.
- Resolve the session's workspace:
  `const workspace = useWorkspaces(snapshot => snapshot.items.find(w => w.sessionIds.includes(sessionId)))`
  (`WorkspaceView` = `{ workspaceId, path, title, sessionIds, ... }`).
- Switch tabs after a bind: `openView('github-issue', 'bound')`.

### 4.1 API client

One small `fetch` wrapper: base `/plugin/github-projects`; JSON in/out; on `!response.ok` read
`{error:{code,message}}` and throw a `GhpError` carrying `code`/`message`; support
`AbortController` and a request timeout (~20 s). Never throw unhandled rejections; render error
states with a retry button and a hint mapped from `code`:
`gh-missing` → "未找到 gh CLI，请先安装 GitHub CLI"；`gh-auth` → "请先运行 gh auth login"；
`timeout`/`gh-failed` → "GitHub 读取失败，请重试"。

### 4.2 `projects` view requirements

States: loading skeleton → error (retry) → unbound empty state → bound board or list.

- Unbound: centred empty state: icon, title `绑定 GitHub Project`, one-line explanation, primary
  button `选择 Project` opening the picker, and a muted hint that the binding is per workspace
  (show workspace title/path).
- Picker: in-view overlay (portal modal scoped to the view rect, close on Esc/backdrop), list from
  `GET /projects` grouped by owner, text filter, 30-row cap with internal scroll, each row shows
  title, owner/number, item count; selecting calls `POST /bind-workspace` then reloads config.
  Also a manual row: owner input + number input + `绑定` (for Projects the gh listing cannot see).
  Loading/error states inside the picker.
- Bound toolbar: project title (link to GitHub), owner/number, total item count, view-mode toggle
  (`泳道` / `列表`), milestone filter, `刷新`, `更换`, `解绑` (确认后 unbound). On `解绑`:
  `POST /unbind-workspace` and show empty state.
- **View modes.** `board` (泳道视图) is the DEFAULT; `list` (列表视图) is the previous grouped
  layout. The mode may persist per client (e.g. localStorage) but a first mount defaults to board.
  - `board`: five canonical status columns, left→right: `No status`, `TODO`, `In Progress`,
    `In Review`, `Done`. Items are assigned by case-insensitive status match
    (`null`/blank → No status; `todo`; `in progress`; `in review`; `done`). Any other custom status
    gets one extra column appended to the right carrying its raw name — never silently dropped.
    **`No status` is hidden when its filtered item count is 0** (v0.3.0); the other four canonical
    columns always render (even empty, showing `无条目`), and an unknown-status column only renders
    when non-empty. The board exposes the hidden canonical keys on
    `[data-ghp-board][data-ghp-hidden-lanes="no-status"]` (empty string when nothing is hidden), and
    the lane order is always a subsequence of `no-status,todo,in-progress,in-review,done` plus
    trailing `other:<raw>` lanes.
    Column header shows the label plus the count of the currently filtered items; each column body
    scrolls vertically; cards render top-down. The board scrolls horizontally when the columns do
    not fit (min column width ≈ 176px), and columns share the width on wide views. Read-only:
    no drag-and-drop, no reordering writes.
  - `list`: unchanged grouped sections (sections in first-seen status order, empty status →
    `未分类`, each with a count) and status filter chips (`全部` + distinct statuses with counts).
- **Milestone filter (both modes).** A toolbar dropdown: `全部` (all), `Backlog` (items with no
  milestone), then each distinct milestone title present in the loaded items, sorted naturally
  (e.g. `v1.1.0` < `v1.2.0` < `vNext`), each with a count. The selection applies together with the
  text filter (and, in list mode, the status chips). Options derive from the unfiltered loaded item
  set; if the selected milestone disappears after a refresh, fall back to `全部` and show a notice.
- **Cards (board).** Title clamped to 2 lines, `repo#number`, labels (max 2 + `+N`), milestone chip.
  Clicking the card body (or a list row) opens the Issue/PR GitHub page in DSH's **built-in right
  sidebar browser** (`sidebarRight.openTab('browser', { params: { url } })`, fallback `window.open`)
  — it does NOT bind (v0.4.0). Each Issue card has an explicit bind action
  (`[data-ghp-card-action="bind"]`, label `绑定` / `已绑定`) that binds the Issue to the current
  session and switches to the `issue` view; the list row `绑定` button behaves the same. Bound cards
  show the `已绑定` badge. Cards keep a focus-visible outline and are keyboard-activatable
  (Enter/Space = open in browser).
- Text filter: title / repo / number / labels (same fields in both modes). Column counts and list
  section counts reflect the filtered set.
- Refresh button sets `refresh=1`; both modes keep previous data while refreshing with a subtle
  indicator; `truncated` shows a footer notice.

- **Layout width (v1.1.1).** The project view fills the conversation body width: the page element has
  `width: 100%` and **no max-width cap / no centered fixed column**, on any window width. The five
  lanes share the full available width equally (`flex: 1 1 0` with the 176px min only as a
  horizontal-scroll floor). This applies to both board and list modes and to the issue view (its
  page also fills the width). Empty states may centre their copy but the page itself must not gain
  fixed side margins on wide windows. A wide-window regression is an acceptance failure (e2e
  `projects-wide` stage).

#### 4.2.0 Visual system (v0.3.0)

The plugin must look like a deliberate product surface inside the shipped dark/light theme, not a
grey debug table. Rules:

- **Color = state, not decoration.** Only these roles get saturated color: status lanes/list
  sections, issue type glyphs, bound/active accents, primary actions, error/success states. Titles,
  meta, labels and body text stay neutral (`label-primary` / `label-secondary` / `label-tertiary`).
- **Status palette** (theme-independent accents; tints via `color-mix` so both DSH light and dark
  themes work, no hardcoded dark backgrounds):

  | Key | Accent | Role |
  |---|---|---|
  | `no-status` | `var(--dsw-alias-label-tertiary)` (neutral) | lane dot, rail, count |
  | `todo` | `var(--dsw-static-blue-500)` (`#3b82f6`) | lane dot, rail, count tint |
  | `in-progress` | `var(--dsw-static-amber-500)` (`#f59e0b`) | lane dot, rail, count tint |
  | `in-review` | `#8b5cf6` (violet) | lane dot, rail, count tint |
  | `done` | `var(--dsw-alias-state-success-primary)` | lane dot, rail, count tint |
  | `other:<raw>` | `#06b6d4` (cyan) | lane dot, rail |
  | Issue type | `var(--dsw-alias-state-success-primary)` | 8px type dot |
  | PR type | `#8b5cf6` | 8px type dot |
  | Draft type | `var(--dsw-alias-label-tertiary)` | 8px type dot |
  | Bound / selected | `var(--dsw-alias-state-business-primary)` | border, chip, ring |

- **Hierarchy.** Lane/section: 2px accent hairline at the header's bottom (status color at ~45%
  mix), 12px/600 neutral label, colored 8px dot, count pill (11px tabular, status-tinted background,
  secondary text). Cards: raised surface (`bg-layer-2`) on a sunken lane (`bg-layer-1`), 1px
  `border-l1`, 12px/500 primary title clamped to 2 lines, 11px tertiary meta, labels as neutral
  chips with 5px hash-colored dots (max 2 + `+N`), violet-tinted milestone chip, `已绑定` brand chip.
  Hover: `border-l3` + `bg-layer-3` + 120ms transition; no layout shift. Toolbar: 34px brand-tinted
  project icon tile, 15px/600 title, 12px tertiary meta, neutral count pill, secondary buttons;
  `解绑` uses error tint only on hover; primary `选择 Project` keeps the host contrast button style.
  Issue view: green-tinted `Open` / neutral `Closed` badge, 20px/600 title, author/hash-colored
  comment initials, brand links. Empty/error: 48px tinted icon tile (brand / error), 16px/600 title,
  13px secondary copy, one primary action.
- **Motion & a11y.** 120ms color/border transitions only; `prefers-reduced-motion` respected for
  non-essential animation; focus uses `--dsw-focus-ring-color` 2px ring; every colored dot is
  decorative (`aria-hidden`) with the text label always present; no color-only information.
- **Contrast.** Text always uses theme label tokens; colored elements are graphics/chips (≥3:1
  against their surface where they carry meaning). Never set colored body text.

#### 4.2.1 Test hooks (stable selectors the e2e harness depends on)

These are part of the contract, not incidental markup. Keep them on the named elements.

| Attribute | Where | Meaning |
|---|---|---|
| `data-ghp-view-mode="board"\|"list"` | projects view root | currently active mode |
| `[data-ghp-action="view-board"]` / `[data-ghp-action="view-list"]` | toolbar buttons | switch mode |
| `[data-ghp-action="milestone"]` | toolbar toggle | opens the milestone dropdown |
| `[data-ghp-milestone-option="all"\|"backlog"\|<title>"]` | dropdown options | select a filter; `data-active="true"` marks the current one |
| `[data-ghp-board]` | board container | present in board mode |
| `[data-ghp-column="no-status"\|"todo"\|"in-progress"\|"in-review"\|"done"]` (unknown: `other:<raw>`) | each column | column identity; `data-ghp-count` carries the filtered count |
| `[data-ghp-card]` | each board card | card element; `data-issue="owner/repo#N"` on Issue cards |
| `[data-ghp-card-action="open"]` | card body | opens the GitHub page in the built-in browser |
| `[data-ghp-card-action="bind"]` | bind button | binds the card's Issue to the current session |
| `[data-ghp-session-subtitle]` | session header subtitle row | present only when the session has a bound Issue |
| `[data-ghp-subtitle-chip]` | subtitle `#N` chip | bound issue number |
| `[data-ghp-subtitle-title]` | subtitle title text | truncated issue title (`title` attr has the full text) |
| `[data-ghp-list]` | list container | present in list mode |

### 4.3 `issue` view requirements

States: loading → error → unbound empty state → bound detail.

- Unbound: empty state title `为当前会话绑定 Issue`; primary `从项目选择` (calls
  `openView('github-projects', 'pick')`), secondary inline input with placeholder
  `粘贴 Issue 链接或 owner/repo#123` + `绑定` button (POST `/bind-issue` with `ref`); show error inline.
- Bound: sticky header card inside the view: repo chip, `#number`, state badge (`Open`/`Closed`),
  title (large), meta line (author · opened date · N comments), labels, action row
  (`刷新`, `解绑`, `在 GitHub 打开`). Body renders a **safe subset of Markdown** as React elements:
  fenced code blocks, inline `code`, headings, bullet/ordered lists, blockquotes, blank-line
  paragraphs, autolinks and `[text](url)`; never `dangerouslySetInnerHTML`. Comments below with
  author, relative time, same markdown renderer, and a `还有 N 条评论` footer when truncated.
- On mount, read `props.viewRequest`: if it targets `github-issue`, acknowledge with
  `completeViewRequest()` after applying (the `focus` is opaque; re-read config from the server).
- `解绑` → POST `/unbind-issue` → unbound empty state.
- Long issue body/comments scroll inside the view (the page/composer must stay untouched).

### 4.4 Style, layout, i18n, a11y

- All class names prefixed `ghp-`; one CSS string injected once from `apply` via a
  `<style data-plugin="github-projects">` effect (same pattern as session-cost).
- Use shipped theme tokens with fallbacks, e.g.
  `var(--dsw-alias-label-primary, #e6e6e6)`,
  `var(--dsw-alias-label-secondary, #999)`,
  `var(--dsw-alias-bg-layer-1, #1a1a1a)`,
  `var(--dsw-alias-bg-layer-2, #222)`,
  `var(--dsw-alias-border-1, #333)`,
  `var(--dsw-alias-brand-primary, #4f7cff)`,
  `var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06))`.
  Inspect more token names with
  `grep -o "\-\-dsw-[a-z0-9-]*" /tmp/dsh-runtime2/dsh/node_modules/@deepseek-ai/dsh-client-ui-*/lib/client.js | sort -u`.
- View root: `height: 100%; min-height: 0; overflow: auto;` with comfortable padding
  (`24px 32px`, responsive down to `16px`). No fixed widths; no horizontal page scroll.
- Locale: dictionary namespace `githubProjects` with `zh` + `en`; the plugin registers both; tab
  labels stay literal `projects` / `issue`. Content strings Chinese first, English complete.
- A11y: buttons are `<button type="button">` with visible labels or `aria-label`; dialog role for the
  picker; Esc closes; focus outline retained; images avoided (no external avatar fetches).
- Relative time: `刚刚` / `N 分钟前` / `N 小时前` / `N 天前` / `YYYY-MM-DD`.

### 4.5 Session issue subtitle (v0.4.0)

When the current session has a bound Issue, the conversation header shows a second line under the
session title:

- Layout: `<chip>#N</chip> <issue title>`. The chip is a small tinted label (brand tint, 11px/16px,
  radius 6px, tabular numerals); the title is 12px/18px `label-secondary`, single line,
  `text-overflow: ellipsis`, with the full `repo#N title` in the `title` attribute. The row aligns
  with the title text start, spans the remaining header width, and is hidden when unbound or while
  the Session is blank (header chrome hidden).
- Updates within ≤4 s after an agent-tool binding change (cheap local `/config` poll, no `gh`), and
  immediately after this plugin's own bind/unbind actions.
- Clicking the row opens the Issue GitHub page in the built-in right sidebar browser (fallback
  `window.open`).
- Implementation guard: the shipped header has no subtitle slot, so the client inserts one owned row
  into `header[data-window-drag]` after the title row and re-ensures it after host re-renders
  (React portal). If the anchor is absent the feature degrades to no subtitle and never throws; it
  must not break sessions without a binding.

## 5. e2e harness (verifier)

Isolated environment, never the user's `~/.dsh` profile or port:
1. temp root under `/tmp/dsh-github-projects-e2e/<run>/` with `home/` and `workspace/` dirs;
2. `DSH_HOME=<temp>/home` + installed CLI
   `/Applications/DeepSeek Harness 2.app/Contents/Resources/runtime/cli/bin/dsh web --no-open --port 0`
   (run with `cwd=<temp>/workspace`), parse the printed
   `dsh web: http://127.0.0.1:<port>/?token=<token>` URL;
3. plugin entry: a `--patch <overlay.yml>` file with an `insert` row named by **absolute path** to
   `<repo>/index.js` (real host) or `<repo>/dev/mock-host.js` (fixtures-only mode), pointing at the
   same package so the client bundle is still served;
4. headless Chrome (`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, v156) with
   `--headless=new --remote-debugging-port=0` + a temp `--user-data-dir`; drive CDP over a raw
   WebSocket (Node 24 global `WebSocket`); navigate to the tokenized URL;
5. create/select a workspace + session through the real UI (one mock-LLM turn so the view tabs
   exist), then assert and screenshot the following (1280×800). Stage names are stable:
   - `boot` — plugin `/health` answers (real mode: live `gh`);
   - `app`, `session` — shell ready, one real turn completes;
   - `tabs` — `["对话","轨迹","projects","issue"]`; `01-tabs.png`;
   - `projects-empty` — unbound state; `02-projects-empty.png`;
   - `projects-picker` — picker open, binds `Astropath-issues` #9; `03-projects-picker.png`;
   - `projects-board` — board is the default mode: `data-ghp-view-mode="board"`, rendered lane keys
     are a subsequence of `no-status,todo,in-progress,in-review,done` (plus trailing `other:*`),
     `No status` present iff not listed in `[data-ghp-board][data-ghp-hidden-lanes]` and hidden when
     its filtered count is 0, the four non-No-status canonical lanes always present, ≥1 card;
     `04-projects-board.png`;
   - `projects-browser` — the overlay enables the Web-disabled shipping row
     (`- id: ui-sidebar-browser / disabled: false`) so the browser tab type exists. Click an Issue
     card body (`[data-ghp-card-action="open"]`): assert DSH's built-in right sidebar browser opens
     (`[data-sidebar-browser-frame]` iframe whose `src` contains `github.com/<repo>/issues/<N>`, and
     the browser tab/address bar is present) and no binding was created; `12-browser-open.png`; close
     the browser tab afterwards. In Web the iframe itself cannot render github.com
     (`X-Frame-Options: DENY`) — that refusal is an expected, documented console error in the
     harness allowlist and does not fail the run; Desktop uses an Electron `<webview>` and renders
     the page natively;
   - `projects-list` — toggle to list: `[data-ghp-list]`, grouped sections; `05-projects-list.png`;
   - `projects-milestone` — open the milestone dropdown: options include `全部` + `Backlog` + real
     project milestones; select an existing milestone (e.g. `v1.2.0`), assert card/row counts shrink
     and `data-active="true"` moves; `06-projects-milestone.png`; then reset to `全部`;
   - `projects-wide` — resize the browser viewport to ~2200×1300 (CDP
     `Emulation.setDeviceMetricsOverride`), keep the bound projects view open in board mode, assert
     the projects page fills the conversation body (`.ghp-page` width ≥ 85% of the available body
     width, no centred max-width column), lanes render under the hidden-No-status rule and share the
     width equally; `11-projects-wide.png`; restore 1280×800;
   - `issue-empty` — `issue` tab renders the unbound empty state (`为当前会话绑定 Issue`, `从项目选择`,
     reference input); `07-issue-empty.png`;
   - `issue-bind-subtitle` — back in projects, click `[data-ghp-card-action="bind"]` on the #240 card;
     assert the client switches to the `issue` view and the session subtitle appears
     (`[data-ghp-session-subtitle]` with `[data-ghp-subtitle-chip]` text `#240` and a non-empty
     `[data-ghp-subtitle-title]` whose `title` attribute carries the full text);
     `13-issue-subtitle.png`;
   - `issue-detail` — assert the fully loaded detail; `08-issue-detail.png`; optional
     `issue-comments` → `09-issue-comments.png`;
   - `projects-warm` — switch to chat and back to `projects`; assert the cached board renders without
     a skeleton within 1500 ms and log the measured duration (the cold duration was already logged in
     `projects-board`); no screenshot;
   - `console` — zero browser console errors/exceptions, zero plugin HTTP ≥400, zero plugin network
     failures;
   - `10-desktop-tabs.png` is NOT produced by the harness: it is the manual Desktop-app evidence
     captured by the Lead after the final install; `11-projects-wide.png`, `12-browser-open.png` and
     `13-issue-subtitle.png` are harness output.
6. Cleanup: kill the web child and Chrome; print a machine-readable summary (JSON lines) and exit
   nonzero on assertion failure. Must be re-runnable (`node scripts/e2e/run.mjs`).

Keep the harness deterministic: run against the real `gh` CLI (already authenticated as `ceasarXuu`)
but only read. Fixture mode (`dev/mock-host.js`) is the fallback when `gh` is unavailable and must
serve enough status/milestone variety (Todo / In Progress / In Review / Done / no status, backlog +
at least one milestone) for the board and filter stages.

## 6. Definition of done

- `node --test test/host/*.test.mjs` passes (host logic, fixtures).
- e2e harness exits 0 with screenshots 01–09 (+ optional), `11-projects-wide.png`,
  `12-browser-open.png`, `13-issue-subtitle.png`, in fixture mode and (once) real-host mode, covering
  the board (incl. the hidden-empty-No-status rule), list, milestone-filter, wide-layout,
  built-in-browser-open and session-subtitle stages plus the warm-open latency assert.
- Host unit tests cover the three agent tools (fake `ctx.tools` capture + fake `exec.agent.session`)
  and the GraphQL normalizers / cache SWR behaviour using the GraphQL fixtures.
- Plugin loads with zero console errors in the browser and one `projects` + one `issue` tab.
- Docs: install steps (Plugin Manager / `dsh plugin add`), `gh` prerequisites, config table,
  design doc in Chinese, known limitations, verification evidence.
- Installed into the user's Desktop profile (`~/.dsh/profiles/desktop`) by the Lead, verified with a
  live screenshot of the session header showing the two tabs, with the profile restorable.
