# `gh` fixtures

Captured 2026-10-28 from the operator machine (`gh` 2.96.0, account `acme`), used to keep the
host adapter and the mock host honest without hitting the network in tests.

| File | Command |
|---|---|
| `project-list.json` | `gh project list --owner acme --format json --limit 5` |
| `item-list.json` | `gh project item-list 9 --owner acme --format json --limit 3` (Project `web-issues`) |
| `issue.json` | `gh api repos/acme/web/issues/240` |
| `issue-comments.json` | `gh api "repos/acme/web/issues/240/comments?per_page=10"` |
| `ORGS.txt` | `gh api user/orgs --jq '[.[].login]'` (orgs: `acme-labs`, `northwind`) |

`item-list.json` items are trimmed to 3 for size; the real Project currently has 195 items.
`issue.json` contains a full issue body (Chinese); it is test data only.

## v0.4.0 GraphQL fixtures (captured 2026-10-28, `gh` 2.96.0)

| File | Command |
|---|---|
| `graphql-items-page1.json` | `gh api graphql -f query="$(cat /tmp/q-items2.graphql)" -F owner=acme -F number=9 -F limit=100` (page 1 of 2) |
| `graphql-items-page2.json` | same query with `-F cursor=<endCursor from page 1>` (page 2, `hasNextPage=false`) |
| `graphql-projects.json` | `gh api graphql -f query="$(cat /tmp/q-projects.graphql)"` (viewer projects + viewer organizations projects) |

The GraphQL query shapes are reproduced in `github.js`; these fixtures pin the
normalizers (status field, milestone, labels, type, issue state, draft content)
and the pagination contract.

The GraphQL query documents used by `github.js` are kept in `queries/`:
`queries/items.graphql` (project items + status field + content, paginated by
`$cursor`) and `queries/projects.graphql` (viewer projects + viewer
organizations' projects).

## v1.1.0 write-path fixtures (2026-10-29, `gh` 2.96.0)

| File | Provenance |
|---|---|
| `graphql-project-meta.json` | **Captured live, read-only** with `gh api graphql -f query="$(cat test/fixtures/queries/project-meta.graphql)" -F owner=acme -F number=9` (Project `web-issues`, `PVT_kwHOAwDbXM4Bocj3`). Pins the real Project node id, the `Status` field id (`PVTSSF_…`) and the real option ids/names (`TODO` `8fc1d6c9`, `In Progress` `47fc9ee4`, `In Review` `edd18149`, `Done` `98236657`). |
| `graphql-update-item-status.json` | **Synthesized** mutation response: `updateProjectV2ItemFieldValue` succeeds and echoes the item node (`{"data":{"updateProjectV2ItemFieldValue":{"projectV2Item":{"id":"PVTI_…"}}}}`). It is the documented GitHub GraphQL success shape; the mutation was **not** executed against the live Project (the write path must stay opt-in and the fixtures are for tests/mock-host only). |
| `graphql-clear-item-status.json` | **Synthesized** `clearProjectV2ItemFieldValue` success response, same shape/provenance as the update fixture. |

The mutation query documents mirroring `github.js` are kept in
`queries/update-item-status.graphql` and `queries/clear-item-status.graphql`.
`graphql-items-page1/2.json` also feed the v1.1.0 `findProjectItem` resolution
tests (the item ids are the real `PVTI_…` values).
