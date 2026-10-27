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

## v0.4.0 GraphQL fixtures (captured 2026-10-28, `gh` 2.96.0)

| File | Command |
|---|---|
| `graphql-items-page1.json` | `gh api graphql -f query="$(cat /tmp/q-items2.graphql)" -F owner=ceasarXuu -F number=9 -F limit=100` (page 1 of 2) |
| `graphql-items-page2.json` | same query with `-F cursor=<endCursor from page 1>` (page 2, `hasNextPage=false`) |
| `graphql-projects.json` | `gh api graphql -f query="$(cat /tmp/q-projects.graphql)"` (viewer projects + viewer organizations projects) |

The GraphQL query shapes are reproduced in `github.js`; these fixtures pin the
normalizers (status field, milestone, labels, type, issue state, draft content)
and the pagination contract.

The GraphQL query documents used by `github.js` are kept in `queries/`:
`queries/items.graphql` (project items + status field + content, paginated by
`$cursor`) and `queries/projects.graphql` (viewer projects + viewer
organizations' projects).
