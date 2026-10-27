# dsh-github-projects

**The GitHub Project and Issue bound to your DSH session, one tab away.**

This DSH plugin appends two views to the conversation header: `projects` shows the GitHub Project
bound to the **workspace**, and `issue` shows the Issue bound to the **session**. Everything is
read-only against GitHub — it is a viewing surface, not a writer.

```
conversation header:  [ 对话 ] [ 轨迹 ] [ projects ] [ issue ] [ … ]
```

> Third-party plugin, not an official DeepSeek / DeepSeek Harness component.

![Session header with the projects and issue tabs](artifacts/screenshots/01-tabs.png)

## How it works

Binding is two levels deep, matching how GitHub context actually lives:

| Level | Bound to | Chosen from | Persisted |
|---|---|---|---|
| Project | a **workspace** (shared by all its sessions) | `projects` tab → project picker | `state.json` in your DSH profile |
| Issue | one **session** | `projects` tab → an Issue row → **Bind**, or paste a link in the `issue` tab | `state.json` in your DSH profile |

The `projects` tab groups the Project's items by their Projects v2 `Status` field and can filter
them. Clicking **Bind** on an Issue row binds that Issue to the current session and switches to the
`issue` tab, which renders the title, state, body, labels and comments. Neither tab replaces the
shipped views: remove the plugin and the header returns to normal.

All GitHub reads go through your locally authenticated [`gh` CLI](https://cli.github.com/). The
plugin stores no token, sends no telemetry, and never calls GitHub directly.

## Screens

| | |
|---|---|
| ![projects tab, unbound](artifacts/screenshots/02-projects-empty.png) | ![project picker](artifacts/screenshots/03-projects-picker.png) |
| Unbound workspace: pick a Project | Project picker: grouped by owner, filterable |
| ![bound project list](artifacts/screenshots/04-projects-list.png) | ![issue empty state](artifacts/screenshots/05-issue-empty.png) |
| Bound Project, grouped by Status | Unbound session: choose from a Project or paste a link |
| ![issue detail](artifacts/screenshots/06-issue-detail.png) | ![issue comments](artifacts/screenshots/08-issue-comments.png) |
| Bound Issue: sticky header, body, labels | Comments with author, relative time and links |

Screenshots 01–06 and 08 are captured by the isolated e2e harness in **real-host mode** against live
`gh` (real Project #9 and Issue #240; 1280×800). `07-desktop-tabs.png` is different: it is a manual
capture of the **real Desktop app** after installing the plugin, showing the tabs on a live session:

![Desktop session header after install](artifacts/screenshots/07-desktop-tabs.png)

## Requirements

- **DeepSeek Harness 0.2.1-rc.3** (Web or Desktop; this is the version tested — see
  [Compatibility](#compatibility)). The plugin uses the `conversation.view` slot and the session
  standard props, which are host APIs and may change between DSH versions.
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

The plugin is a local package (`@local/dsh-github-projects`), not published to npm. Install it into
the DSH profile your app runs (on a default Desktop install the profile is named `desktop`; use
`web` / `headless` if that is what you run).

**CLI (the path verified on DSH 0.2.1-rc.3):**

```sh
# add the local checkout to the desktop profile
dsh plugin --profile desktop add /absolute/path/to/dsh-github-projects

# verify it is installed in that profile
dsh plugin --profile desktop why @local/dsh-github-projects
```

`dsh plugin ... add` records the package as a `link:` dependency **and** appends it to the profile's
`dsh.profile.bundles`; the running Desktop app hot-recomposes and loads both halves without a
restart (the window reloads and may return to the workspace home; sessions are untouched — reopen a
session and the tabs are there). The command also accepts a published package name instead of a
local path. Installing needs write access to the profile directory. Remove it with:

```sh
dsh plugin --profile desktop remove @local/dsh-github-projects
```

**Plugin Manager:** the Plugins → Add UI performs the equivalent profile install for non-CLI use;
the CLI path above is the one exercised on this machine.

## Use

1. Open a session and click the `projects` tab.
2. **Choose a Project** → pick a Project from your account and organizations (or bind manually by
   `owner` + `number` when `gh project list` can't see it).
3. Find an Issue in the grouped list — filter by text or by status chips if the Project is large —
   and click **Bind** next to it.
4. The plugin binds the Issue to the current session and switches to the `issue` tab. The binding
   sticks for that session; other sessions can bind different Issues.
5. Alternatively, in an unbound `issue` tab paste a GitHub Issue URL or `owner/repo#123` and click
   **Bind**.

Use **Refresh** to bypass the 60-second cache, **Change** to switch the workspace's Project, and
**Unbind** (with confirmation) to clear a binding. Unbinding a Project does not unbind session Issues.
Button labels above are the English UI copy; the Chinese UI localizes the same actions as
绑定 / 刷新 / 更换 / 解绑.

## Configuration

Defaults ship in the bundle's `cordis.patch.yml`. Override them in your profile's
`cordis.patch.yml` under `id: github-projects`; overriding the row **replaces the whole `config`**,
so restate every key you need.

| Key | Default | Meaning |
|---|---|---|
| `ghCommand` | `gh` | `gh` executable. An absolute path is recommended, because a GUI app often has a shorter `PATH` than your terminal |
| `requestTimeoutMs` | `20000` | Timeout of one `gh` invocation |
| `cacheTtlMs` | `60000` | In-memory cache TTL for GitHub reads; `refresh=1` bypasses it |
| `maxProjectItems` | `200` | Upper bound of project items returned by one read |
| `maxComments` | `30` | Upper bound of Issue comments returned by one read |
| `healthCacheTtlMs` | `5000` | TTL of the cached `gh` health snapshot shared by `/config` and `/health` |
| `healthFirstReadTimeoutMs` | `3000` | Max wait for the first `/config` health probe; on timeout the response carries `error:"pending"` and the probe continues in the background |
| `statePath` | `null` | Binding file; `null` resolves to `$DSH_HOME/plugin-data/github-projects/state.json` |

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: github-projects
  name: '@local/dsh-github-projects'
  config:
    ghCommand: /opt/homebrew/bin/gh
    requestTimeoutMs: 30000
    cacheTtlMs: 120000
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
| `projects` tab says “This session is not in a workspace” | Project bindings belong to a workspace; this session has none | Move the session into a workspace, then bind |
| “This is a Pull Request” | The bound reference points at a PR, not an Issue | Bind the Issue instead; PR rows open on GitHub |
| Desktop returns to the workspace home right after install | Normal HMR profile recompose | Reopen a session; its data is untouched and the tabs are there |
| Tabs missing after install | Bundle not enabled in the profile, or DSH not recomposed | Check `dsh.profile.bundles`, enable via plugin manager, reload |
| A “gh CLI unavailable” warning flashes right after opening | First `/config` health probe exceeded `healthFirstReadTimeoutMs`, so the response carried `error:"pending"` | Harmless; it clears once the probe finishes (read `/config` again or reopen the tab) |
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
| `client.js` | Browser half: `conversation.view` entries, React views, safe Markdown renderer |
| `dev/mock-host.js` | Contract-shaped mock host for UI/e2e without `gh` |
| `test/` | Host unit tests + captured `gh` fixtures |
| `artifacts/screenshots/` | e2e acceptance screenshots |

The e2e harness runs in an isolated temp `DSH_HOME` and workspace on its own port — it never touches
your running profile or the window you're using. See [`docs/DESIGN.zh.md`](docs/DESIGN.zh.md) for the
Chinese design document and [`docs/CONTRACT.md`](docs/CONTRACT.md) for the frozen interface.

## Compatibility

| | |
|---|---|
| Verified DSH | 0.2.1-rc.3 (Desktop + `dsh web`) |
| Verified `gh` | 2.96.0 (2026-07-02) |
| Verified OS | macOS (headless Chrome 156 for e2e) |
| Node (host half) | ≥ 22 |
| Runtime dependencies | none (browser half uses host-provided `react` / `react-dom`) |
| Acceptance | v1 accepted 2026-10-28: 69/69 host tests, e2e PASS in fixture and real modes — see [the evidence chapter](docs/DESIGN.zh.md#8-验收与验证证据) (Chinese) |

There is no formal `engines.dsh` gate yet: a DSH upgrade that changes the `conversation.view` slot
or session standard props may require a plugin update.

## Known limitations

- **Read-only.** No writing to GitHub: no status changes, comments, issue creation or field edits.
- **One Project per workspace**, one Issue per session.
- **Issue-only detail.** PR and draft rows open on GitHub; PRs cannot be bound to a session.
- **No item state in the list.** `gh project item-list` does not include each item's open/closed
  state, so the list doesn't show it; the `issue` tab (REST) does.
- **Caps:** up to `maxProjectItems` items and `maxComments` comments (oldest first) per read; no pagination or
  "load more". Long issue bodies are truncated at 100,000 characters.
- **No search across Projects** and no cross-Project view.
- **Bindings are per profile**, not stored with the repository; another machine or profile starts
  unbound.
- **Markdown subset only:** no HTML, images or tables in the rendered body; task-list checkboxes are
  display-only.
- **No polling/push:** GitHub-side changes appear after a refresh.
- **`gh`-dependent:** without a working, authenticated `gh` you can still see bound summaries
  (from local state) but not lists or details.

## License

MIT. Chinese README: [README.zh.md](README.zh.md).
