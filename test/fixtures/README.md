# `gh` fixtures

Captured 2026-10-28 from the operator machine (`gh` 2.96.0, account `ceasarXuu`), used to keep the
host adapter and the mock host honest without hitting the network in tests.

| File | Command |
|---|---|
| `project-list.json` | `gh project list --owner ceasarXuu --format json --limit 5` |
| `item-list.json` | `gh project item-list 9 --owner ceasarXuu --format json --limit 3` (Project `Astropath-issues`) |
| `issue.json` | `gh api repos/ceasarXuu/Astropath/issues/240` |
| `issue-comments.json` | `gh api "repos/ceasarXuu/Astropath/issues/240/comments?per_page=10"` |
| `ORGS.txt` | `gh api user/orgs --jq '[.[].login]'` (orgs: `XuyuTech`, `BeanDoor`) |

`item-list.json` items are trimmed to 3 for size; the real Project currently has 195 items.
`issue.json` contains a full issue body (Chinese); it is test data only.
