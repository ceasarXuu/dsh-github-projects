# The GitHub Pages site

`docs/` is the site source. GitHub Pages serves it from **Settings → Pages → Source: Deploy from a
branch → `main` → `/docs`**, which yields `https://ceasarxuu.github.io/dsh-github-projects/`.
`docs/.nojekyll` keeps Pages from filtering anything.

The site is **not** shipped to npm: `package.json` `files` whitelists only `docs/DESIGN.zh.md` from
that folder. Keep it that way unless the whole site should be in the package.

## Working copy

Author in `../site-gh-projects/` (workspace root), not in `docs/` — that folder is the deploy target
and should only ever receive a finished build:

```sh
cd /Volumes/inwolf-4T/projects/dsh-mods
cp site-gh-projects/{index.html,styles.css,page.js} dsh-github-projects/docs/
cp site-gh-projects/assets/{board.png,branch.png,autobind.png,panel-loop.mp4} dsh-github-projects/docs/assets/
```

## The gate

```sh
SK=~/.agents/skills/design-taste-frontend
node $SK/scripts/lint.mjs index.html styles.css page.js
node $SK/scripts/inspect.mjs index.html
```

`inspect.mjs` needs 0 FAIL at 1440 / 768 / 390. As of 2026-11-20 it reports one WARN (`size-count` at
390px) which is the five fluid steps landing on their clamp minima plus inline `code` at `0.86em`;
that is expected and deliberate.

## Chrome will not start without `--no-sandbox` here

`inspect.mjs` launches Chrome itself and works. Any hand-rolled CDP script does not, unless the
wrapper below is used — the same failure as in the Remotion runbook: an **empty** Chrome log and
`Timed out while trying to connect`.

```sh
REAL="/Volumes/inwolf-4T/projects/dsh-mods/github-projects-promo/node_modules/.remotion/chrome-headless-shell/mac-arm64/chrome-headless-shell-mac-arm64/chrome-headless-shell"
cat > /tmp/chrome-nosandbox.sh <<EOF
#!/bin/sh
exec "$REAL" --no-sandbox --disable-dev-shm-usage "\$@"
EOF
chmod +x /tmp/chrome-nosandbox.sh
```

## Screenshots that are not lying

`scripts/shot.mjs` captures full-page or single-section shots over CDP:

```sh
CHROME=/tmp/chrome-nosandbox.sh node scripts/shot.mjs index.html 1440 shots/full.png
CHROME=/tmp/chrome-nosandbox.sh node scripts/shot.mjs index.html 1440 shots/sec.png --section=panel
```

It sets `prefers-reduced-motion: reduce` before navigating. **That is not a convenience.** The page
reveals sections from a scroll pass, so a capture taken at scroll 0 renders every not-yet-passed
section at `opacity: 0` — a full-page shot then looks like a blank page with headings on it. Under
reduced motion no `.rise` class is ever added, so the shot shows what a reader without motion sees.
If you ever need the animated render, set `SHOT_MOTION=1` and scroll the page properly first.

## Content that must stay in sync

The page quotes the plugin's real behaviour. When these change, change the page:

| On the page | Where it really comes from |
| --- | --- |
| the off/on table rows | `allowWrites` gate in `sidebar-api.js` (`403 writes-disabled`) and the action list in the same file |
| `maxProjectItems` 200 / `maxComments` 30 | `cordis.patch.yml` defaults |
| `engines.dsh` range | `package.json` |
| "published npm release is 1.3.0" | `npm view @ceasarxuu/dsh-github-projects version` — update it when the next one ships |
| the derivation steps | `git-remote.js`, `auto-bind.js` |

## Before launch

- The panel fragments are built in HTML at true size, not screenshots: they are representative, and
  their view names (`All items`, `This sprint`, `Table`) and item titles are sample content.
- The install line says the panel management is on `main` and not in the published release. Update it
  once a release actually carries the sidebar.
