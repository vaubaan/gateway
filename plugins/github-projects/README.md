# `@vaubaan/plugin-github-projects`

One GitHub Projects (v2) board of an organization: its fields, views and items, over GitHub's
REST API (`/orgs/{org}/projectsV2/{number}/…`). Separate from the GitHub plugin (ADR
[github-projects-is-its-own-plugin](../../docs/decisions/github-projects-is-its-own-plugin.md)).
Handbook: [`docs/handbook/services/github-projects.md`](../../docs/handbook/services/github-projects.md).

## Data model

One plane, `project`:

```
project[<org>/<number>]        the resource; no environment
  ├─ field[<id>]               a column of the board
  ├─ view[<number>]            a saved view
  └─ item[<id>]                a card: issue, pull request or draft
       ├─ value[<field id>]    the value of one field on this item
       └─ delete               verb leaf: the item removed from the project
```

## Credential and resources

Kind `api-key`, three fields:

| Field          | Pattern                               | Purpose                                         |
| -------------- | ------------------------------------- | ----------------------------------------------- |
| `token`        | `^github_pat_[A-Za-z0-9_]{20,255}$`   | A fine-grained token; a classic one is refused. |
| `organization` | `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$` | The organization that owns the project.         |
| `project`      | `^[1-9][0-9]{0,9}$`                   | The project number, from its address.           |

The guide asks for the organization as resource owner, All repositories with Issues and Pull
requests read (a card shows its issue), and Projects read and write. `verify` reads `GET /user`
and the project. `discoverResources` returns **the one project**, `ref` `<org>/<number>` in
GitHub's spelling, `displayName` its title (one request, no pagination).

## Tools

Twelve tools named `github_projects__<verb>_<noun>`, each taking `project` (optional when the
mission holds one); `list_projects` is excluded. Mapping: handbook, "Tool → slice". Lists answer
`{ items, next, previous }` (at most 100 per page).

## Catalog

| Risk                                  | Action | Notes                                                           |
| ------------------------------------- | ------ | --------------------------------------------------------------- |
| `github-projects.read`                | R      | Every read.                                                     |
| `github-projects.item-add`            | W      | Add an issue, a pull request or a draft.                        |
| `github-projects.item-write`          | W      | Set field values, one slice per field.                          |
| `github-projects.item-delete`         | W      | Remove an item. Irreversible.                                   |
| `github-projects.board-shape`         | W      | Create a field or a view.                                       |
| `github-projects.uncategorized-write` | W      | Fallback; touched by no tool of the plugin, in no macro-action. |

## Macro-actions

| Macro-action | What it covers                         | Its risks                |
| ------------ | -------------------------------------- | ------------------------ |
| `read`       | Read the project, fields, views, items | `read`                   |
| `track`      | Add cards and change their fields      | `item-add`, `item-write` |
| `remove`     | Remove items from the project          | `item-delete`            |
| `shape`      | Create fields and views                | `board-shape`            |

## Tests

`npx vitest run plugins/github-projects`: the SDK kit (well-formed, coverage, slices on the data
model, identifier proof), a mission from the macro-actions, the classifier branch by branch,
`execute`, the token check and discovery against `mockFetch`. No test calls GitHub.
