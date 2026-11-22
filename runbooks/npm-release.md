# Releasing to npm (Trusted Publishing)

Verified 2026-11-22 by publishing 1.4.1 from GitHub Actions with no token and no 2FA prompt.

## How a release works now

1. Bump the version in `package.json`, add the `CHANGELOG.md` section, update the README pins
   (`@ceasarxuu/dsh-github-projects@<version>`) and `market/index.json`.
2. Commit and push to `main`.
3. Publish either by pushing a matching tag, or by dispatching the workflow:

```bash
git tag -a v1.4.1 -m "1.4.1"          # the tag must equal package.json's version
git push origin v1.4.1

# or, without a tag:
gh workflow run publish.yml --ref main
```

4. Watch it: `gh run list --workflow=publish.yml --limit 1`

The registry takes ~2 minutes to show a new version ("Your package is being processed"); poll
`https://registry.npmjs.org/@ceasarxuu/dsh-github-projects` rather than believing the first 404.

## What the workflow does

`.github/workflows/publish.yml` runs tests, checks `tag == package.json`, then `npm publish`.
`permissions: id-token: write` lets the runner mint a workflow-scoped OIDC token that npm exchanges
for a short-lived publish credential. Nothing secret is stored anywhere.

Provenance is attached automatically because the repository is public. Verify it after a publish:

```bash
curl -s https://registry.npmjs.org/@ceasarxuu/dsh-github-projects/1.4.1 \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['dist']['attestations'])"
```

## The npm side (already configured)

`npmjs.com` → package → Settings → Trusted Publisher → GitHub Actions:

| Field | Value |
|---|---|
| Organization or user | `ceasarXuu` |
| Repository | `dsh-github-projects` |
| Workflow filename | `publish.yml` |
| Environment name | *(blank — the workflow declares none)* |
| Allow npm publish | checked |
| Allow npm dist-tag | unchecked |

The connection's provider and fields are fixed once created; changing any of them means deleting the
connection and adding it again. Adding or removing a connection requires a 2FA prompt in the browser.

## Traps that cost time

- **Never set `registry-url` on `actions/setup-node`.** It writes an `.npmrc` containing
  `_authToken=${NODE_AUTH_TOKEN}`, and that empty token shadows OIDC: the publish fails with
  `ENEEDAUTH` even though the trust relationship is correct.
- **The workflow filename is part of the OIDC claim.** Renaming the file silently breaks publishing
  until the npm-side connection is updated.
- **npm must be ≥ 11.5.1 on node ≥ 22.14.** The workflow upgrades npm in-job so the runner image's
  bundled version cannot regress this.
- **The tag must match `package.json`.** npm rejects a republish of an existing version, so a
  mismatched tag wastes a run; the workflow checks it before publishing.
- A part of the suite leaves an un-awaited background refresh running on purpose, so temp-dir removal
  can race it and throw `ENOTEMPTY` on Linux. `rmSync` needs `maxRetries` there (fixed in 1.4.1).

## Retracting a version

Trusted publishing covers `npm publish` only — it does not cover `npm unpublish`, and there is no
web UI for it. Retraction needs an interactive, 2FA-authenticated session on the operator machine:

```bash
npm login --auth-type=web      # opens a browser approval URL
npm unpublish @ceasarxuu/dsh-github-projects@<version>
```

Unpublishing a version published more than 72 hours ago is refused by policy; after that the only
options are deprecating it or publishing a fixed version. Published tarballs cannot be edited, so a
leak in a published version is only fixable by unpublishing inside that window or by shipping the
next version.
