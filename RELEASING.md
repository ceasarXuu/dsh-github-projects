# Releasing

Target: publish this bundle as the public npm package
**`@ceasarxuu/dsh-github-projects`** and, optionally, list it in a DSH
plugin-market index.

## One-time prerequisites

- npm account that owns the `@ceasarxuu` scope, logged in locally:
  `npm login` (then `npm whoami`).
- GitHub repository `ceasarXuu/dsh-github-projects` (public). The package
  metadata and README already point at it, so create it before announcing the
  npm package:
  `gh repo create ceasarXuu/dsh-github-projects --public --source=. --push`.

## Release checklist

```sh
# 1. Version: bump for every published change (npm rejects a reused version)
npm version patch --no-git-tag-version     # or minor/major

# 2. Tests, syntax, packed file list
node --test test/host/*.test.mjs
node scripts/e2e/run.mjs --mode fixture --keep
node --check index.js && node --check client.js
npm pack --dry-run                         # confirm files/size/no private data

# 3. Publish (scoped packages are restricted by default)
#    This account uses 2FA for publishing and has no authenticator app, so use
#    npm's browser verification from a pseudo-TTY (without a TTY npm exits EOTP
#    immediately and prints only a redacted URL):
script -q /tmp/npm-publish.log npm publish --access public
#    npm prints "Authenticate your account at: https://www.npmjs.com/auth/cli/<id>"
#    and waits. Open that URL (the command also offers ENTER to open it), approve
#    in the browser, and npm continues: "Your package is being processed..." then
#    "+ @ceasarxuu/dsh-github-projects@<version>". No OTP/authenticator is needed.
#
#    A plain `npm login --auth-type=web` token is NOT enough for publish (npm
#    still returns EOTP); the browser verification must happen inside the waiting
#    publish process as above.

# 4. Source repository + tag
git push
git tag "v$(node -p "require('./package.json').version")"
git push --tags
```

Post-publish checks:

- `npm view @ceasarxuu/dsh-github-projects version dist-tags` shows the new
  version under `latest` (allow a few minutes for new packages; the registry
  may list an internal `0.0.0-stage` alongside real versions — always pin the
  published version explicitly).
- Clean DSH profile: Plugin Manager → Add →
  `@ceasarxuu/dsh-github-projects`, or
  `dsh plugin --profile smoke add @ceasarxuu/dsh-github-projects`; after a
  restart the session header must show the `projects` / `issue` tabs and
  `/plugin/github-projects/health` must answer.
- Plugin Manager card shows the localized title/description
  (`locale/en.json`, `locale/zh.json`) and the icon.
- If `engines.dsh` changed, re-run the install smoke test on the oldest
  supported DSH version.

## Compatibility policy

- `engines.dsh` allows `>=0.2.1-rc.3 <0.3.0`: the plugin was verified on DSH
  0.2.1-rc.3 only. Widen the range only after actually installing and running it
  on the older version; narrow/raise it when a DSH client change breaks the
  `conversation.view` slot, header/sidebar DOM anchors, or `/plugin` routing.
- The plugin uses only public DSH seams: Cordis host plugins (tools, webServer),
  the browser `__ModuleLoader__` client-plugin entry, `conversation.view` slot
  entries, locale registration, and guarded DOM decoration for subtitles. A
  removal of any of these is a breaking upstream change: bump the minor version
  and state the tested DSH version.

## Plugin market index (optional)

`market/index.json` is a format-1 index with one npm entry;
`market/icons/github-projects.svg` is its icon. Regenerate the timestamp after
publishing:

```sh
python3 - <<'PY'
import json, time
p = 'market/index.json'
data = json.load(open(p))
data['plugins'][0]['versions'][0]['publishTimestamp'] = int(time.time())
json.dump(data, open(p, 'w'), indent=2, ensure_ascii=False)
open(p, 'a').write('\n')
PY
```

Host the `market/` directory on any static HTTPS host (GitHub Pages, object
storage) and users add `https://<host>/index.json` as an index source in
Plugins → Discover.

## Rollback

- Wrong metadata but correct code: publish a patch version.
- Broken release: `npm deprecate @ceasarxuu/dsh-github-projects@<version>
  "reason"` and publish a fixed version. `npm unpublish` within the registry's
  grace window is possible but disruptive; prefer a forward fix.
