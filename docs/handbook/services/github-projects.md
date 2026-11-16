---
title: GitHub Projects plugin
tracks:
  - plugins/github-projects/src/
  - plugins/github-projects/README.md
last_reviewed: 2026-11-16
---

# GitHub Projects plugin — handbook

`@vaubaan/plugin-github-projects`: one GitHub Projects (v2) board of an organization — its
fields, views and items. One account is one project, opened by a fine-grained personal access
token over its organization. Separate from the GitHub plugin
([ADR](../../decisions/github-projects-is-its-own-plugin.md)). No risk is env-scoped. Rules common
to every plugin: [services README](README.md).

Written from GitHub's REST reference (docs.github.com, read 2026-11-16, not through Context7):
"REST API endpoints for Projects" (projects, fields, items, drafts, views), "Permissions required
for fine-grained personal access tokens" (organization permission "Projects"), "API versions".
Organization endpoints only, `/orgs/{org}/projectsV2/{project_number}/…`; no GraphQL.
**No call was made against GitHub**: the plugin has not met a real token yet (Traps).

## Start here

- [`src/call.ts`](../../../plugins/github-projects/src/call.ts) — every grammar and
  `readProjectCall`, the one reader of `classify` and `execute`.
- [`src/classify.ts`](../../../plugins/github-projects/src/classify.ts) — what a checked call
  touches.
- [`src/execute.ts`](../../../plugins/github-projects/src/execute.ts) — requests built field by
  field, list cursors, discovery.
- [`src/credential.ts`](../../../plugins/github-projects/src/credential.ts) — the token, a copy of
  the GitHub plugin's, adapted.

## Data model

One plane, `project`: `project[<org>/<number>]` (the resource), `field[<id>]`, `view[<number>]`,
`item[<id>]`, `item[<id>].value[<field id>]` (one field on one item), and the verb leaf
`item[<id>].delete`. Repositories are not entities: an item links an issue or a pull request the
GitHub plugin models.

## Tool → slice

`project` is `<org>/<number>`; absent, the mission's single project. Ids are positive integers,
as a JSON number or its digits.

| Tool                      | Request                          | Slice                                          | Risk          |
| ------------------------- | -------------------------------- | ---------------------------------------------- | ------------- |
| `get_project`             | `GET …/{n}`                      | `project[p].R`                                 | `read`        |
| `list_project_fields`     | `GET …/{n}/fields`               | `project[p].field[*].R`                        | `read`        |
| `get_project_field`       | `GET …/{n}/fields/{id}`          | `project[p].field[f].R`                        | `read`        |
| `list_project_items`      | `GET …/{n}/items`                | `project[p].item[*].R`                         | `read`        |
| `get_project_item`        | `GET …/{n}/items/{id}`           | `project[p].item[i].R`                         | `read`        |
| `list_project_view_items` | `GET …/{n}/views/{number}/items` | `project[p].view[v].R`, `project[p].item[*].R` | `read`        |
| `add_project_item`        | `POST …/{n}/items`               | `project[p].item.W`                            | `item-add`    |
| `add_project_draft`       | `POST …/{n}/drafts`              | `project[p].item.W`                            | `item-add`    |
| `update_project_item`     | `PATCH …/{n}/items/{id}`         | `project[p].item[i].value[f].W`, one per field | `item-write`  |
| `delete_project_item`     | `DELETE …/{n}/items/{id}`        | `project[p].item[i].delete.W`                  | `item-delete` |
| `create_project_field`    | `POST …/{n}/fields`              | `project[p].field.W`                           | `board-shape` |
| `create_project_view`     | `POST …/{n}/views`               | `project[p].view.W`                            | `board-shape` |

Excluded (`excludedTools`): `list_projects` — it reads every project of the organization, outside
the account's one project. Macro-actions: `read` (read), `track` (item-add, item-write), `remove`
(item-delete), `shape` (board-shape). No tool lands on the fallback.

## Invariants

- **The write patterns do not overlap**: adding (`item.W`), changing (`item[**].value[**].W`) and
  removing (`item[**].delete.W`) are three decisions, and a removal touches `item-delete` alone.
  A new write slice under `item` needs its own entry, or it lands on the fallback.
- **One slice per field written**: a mission can be narrowed to `item[**].value[<Status id>].W`
  ("move cards, nothing else"); a call that also writes another field is refused.
- **Removal is priced irreversible** (row 4, asks first or stays out): `DELETE` deletes a draft
  with its text and drops an issue's values on the board, and the classifier cannot tell which
  without a read.
- **Identifiers**: `project` by `projectRef` (organization `^[A-Za-z0-9][A-Za-z0-9-]{0,38}$`, a
  number without leading zero), then compared exactly with the mission's refs; item, field, view
  ids by `positiveId` (digits only, safe integer); `owner`/`repo` of an added issue by the GitHub
  plugin's grammars. Ids land in the path as digits, the organization through
  `encodeURIComponent`; `q`, `fields` and cursors go through `URLSearchParams`.
- **Requests are built field by field** from the checked call: an undeclared argument, or an
  extra key in a `fields` entry, is ignored, never sent.
- Lists answer `{ items, next, previous }`, the cursors read from GitHub's `Link` header.

## Traps

- **Not yet met a real token.** Three facts are the documentation's word only: that the
  Projects endpoints answer under `X-GitHub-Api-Version: 2026-03-10` (the GitHub plugin sends
  `2022-11-28`, supported until 2028-03-10); that item contents need Issues / Pull requests read
  on their repository; and the body of `create_project_field`, whose reference marks
  `issue_field_id`, `single_select_options` and `iteration_configuration` all required while its
  examples omit them, and writes option `name`/`description` as strings in the parameters and
  `{ raw, html }` in an example. The plugin follows the parameters (strings). The first real
  account settles all three.
- The project ref is compared exactly: discovery stores GitHub's spelling of the organization
  (`Acme/12`); an agent writing `acme/12` is refused, as a ref outside the mission.
- GitHub's API has no list or delete for views and fields: a created one is removed by hand.

## Outside the repo

- **Fine-grained token** only (`github_pat_…`; a classic `ghp_` is refused by the pattern).
  Resource owner: the organization. Repository access: All repositories, with Issues and Pull
  requests: Read. Organization permissions: Projects: Read and write. Checked at paste:
  `GET /user` (login, expiry header), then `GET /orgs/{org}/projectsV2/{n}` (404 →
  `CredentialRefusal`).
- **One project per account**: the form asks the organization and the project number (the end of
  `github.com/orgs/<org>/projects/<number>`). Another project is another account. The token
  itself opens every project of the organization: the gateway is what keeps a mission to one.
- The gateway cannot change or revoke the token: delete it on GitHub's token page.

## Debug

- 403 at paste or on every call → the token lacks Projects, or the organization requires an
  administrator to approve fine-grained tokens and has not approved this one.
- `project 'acme/12' is not selected in this mission` → the mission holds the project under
  GitHub's spelling (`Acme/12`): call with it, or omit `project`.
- An item read without its issue's title or body → the token lacks Issues / Pull requests read on
  that repository.
