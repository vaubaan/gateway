# `@vaubaan/plugin-asana`

Asana for Vaubaan Gateway: the projects an Asana account can see, their sections, tasks, subtasks
and comments, on Asana's REST API (`https://app.asana.com/api/1.0`), with a personal access token.
Agents read projects and tasks, create, change, comment on and delete tasks. No project
administration, no access rights, no attachments.

Handbook (model, edge cases, traps):
[`docs/handbook/providers/asana.md`](../../docs/handbook/providers/asana.md). Kit:
[`plugins/README.md`](../README.md).

## Data model

One plane, `work`. Asana has no environment: no entity carries one, no risk is env-scoped.

```
project[<project gid>]           the resource (one per project the account sees)
  ├─ section[<section gid>]      a section or board column
  └─ task[<task gid>]            a task of the project, or a subtask of one of its tasks
       ├─ comment[<story gid>]   a comment (a story of subtype comment_added)
       ├─ rewrite                verb leaf: overwriting its name or description
       └─ delete                 verb leaf: moving the task to the trash
```

## Credential and resources

Kind `api-key`, one required secret field:

| Field                   | Pattern        | Purpose                                                        |
| ----------------------- | -------------- | -------------------------------------------------------------- |
| `personal_access_token` | `^\S{20,512}$` | A personal access token of the account the agents will act as. |

Asana says to treat its tokens as opaque, so the pattern only bounds the value. A personal access
token has no scopes: it acts as the person on everything they can see, and every write is signed
with their name. Use an account made for the agents if their actions should not read as yours. It
does not expire; it ends when it is deleted in the developer console. `verify` asks
`GET /users/me` who the token is and refuses an account that belongs to no workspace.

`discoverResources` reads the workspaces of `GET /users/me`, then
`GET /workspaces/{gid}/projects?archived=false`, 100 a page, following `next_page.offset`, **at most
500 projects** across all workspaces (more fails the discovery). One resource per project: `ref`
is the project gid, `displayName` is `<team or workspace> / <project>`, metadata
`workspace_gid`, `workspace_name`, `team_name`. Archived projects are left out.

**Tasks that are in no project** (a person's "My tasks" only) are reachable by no tool: a mission
selects projects, and every task tool proves its task is in one.

## Tools

Eleven tools named `asana__<verb>_<noun>`. Every tool but `list_projects` takes `project`, a project
of the mission (it may be left out when the mission holds exactly one). Task tools also take
`task_gid`; before acting, the executor proves the task (or one of its ancestors, for a subtask) is
in that project, and refuses otherwise.

| Tool                   | Asana                                                               | Slice                                                              |
| ---------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `asana__list_projects` | none: answered from the mission                                     | `asana.project[<p1>,<p2>…].R`                                      |
| `asana__get_project`   | `GET /projects/{p}`                                                 | `asana.project[<p>].R`                                             |
| `asana__list_sections` | `GET /projects/{p}/sections` (up to 500)                            | `asana.project[<p>].section[*].R`                                  |
| `asana__list_tasks`    | `GET /projects/{p}/tasks` or `GET /sections/{s}/tasks`              | `asana.project[<p>].task[*].R`                                     |
| `asana__search_tasks`  | `GET /workspaces/{w}/tasks/search?projects.any=<p>`                 | `asana.project[<p>].task[*].R`                                     |
| `asana__get_task`      | `GET /tasks/{t}`                                                    | `asana.project[<p>].task[<t>].R`                                   |
| `asana__list_comments` | `GET /tasks/{t}/stories?resource_subtype=comment_added` (up to 500) | `asana.project[<p>].task[<t>].comment[*].R`                        |
| `asana__create_task`   | `POST /tasks`, or `POST /tasks/{parent}/subtasks`                   | `asana.project[<p>].task.W`                                        |
| `asana__update_task`   | `PUT /tasks/{t}`, then `POST /sections/{s}/addTask`                 | `…task[<t>].W`, plus `…task[<t>].rewrite.W` with `name` or `notes` |
| `asana__add_comment`   | `POST /tasks/{t}/stories`                                           | `asana.project[<p>].task[<t>].comment.W`                           |
| `asana__delete_task`   | `DELETE /tasks/{t}`                                                 | `…task[<t>].W` and `…task[<t>].delete.W`                           |

- `search_tasks` is **Asana Premium only** (a 402 otherwise, returned as the provider's failure)
  and Asana allows **60 searches a minute** per token: `task-read` carries
  `infra_limits.calls_per_minute_max: 60`, so no mission is issued with a faster rate for it.
- `list_tasks` is paged: `limit` (1 to 100, default 50) and `offset`, the `next_offset` of the
  previous answer. `completed_since` is `now` (incomplete tasks only) or an ISO-8601 timestamp.
- An assignee is `me` or a user gid, never an email address. `update_task` takes `null` to
  unassign or to clear the due date.
- Every request is built field by field from the declared arguments; an undeclared argument is
  never read, so never sent.
- A task answer is cut to this project: its other projects and their section names are removed.
  People are named, never addressed: no email is asked.

## Catalog

`src/risk-catalog.yaml`: eight named risks and the fallback.

| Risk                        | Action | Notes                                                                                                                             |
| --------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `asana.project-read`        | R      | Projects and their sections. Metadata.                                                                                            |
| `asana.task-read`           | R      | Listing, searching and reading tasks: text written by others (prompt-injection path). At most 60 a minute (Asana's search limit). |
| `asana.comment-read`        | R      | Conversations between named people (`pii`): asks first at Careful.                                                                |
| `asana.task-create`         | W      | A new task or subtask; assigning someone notifies them.                                                                           |
| `asana.task-update`         | W      | Every change of a task: assignee, dates, completion, section. Reversible: set it back.                                            |
| `asana.task-rewrite`        | W      | The `rewrite` leaf: a new name or description. Costly: Asana keeps no history of the old text.                                    |
| `asana.comment-create`      | W      | Signed by the account, notifies followers.                                                                                        |
| `asana.task-delete`         | W      | The `delete` leaf: the account's trash, 30 days to restore. Costly.                                                               |
| `asana.uncategorized-write` | W      | Fallback (`fallback: true`); touched by no tool, in no macro-action.                                                              |

Writes are layered: `delete_task` emits a write on the task and the `delete` leaf, so a mission
needs `task-update` **and** `task-delete`; `update_task` with `name` or `notes` emits the write
and the `rewrite` leaf, so it needs `task-update` **and** `task-rewrite`.

## Macro-actions

A creator ticks macro-actions at a trust level (Careful / Trusting / Autonomous), risk model §4.6.
Base budgets (quota per period, rate per minute) are a starting point: the trust level multiplies
the quota ×1, ×3, ×10. The gateway adds "Anything else", holding the fallback.

| Macro-action | Its risks (quota, per minute)                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| `read`       | `project-read` (500, 60), `task-read` (2000, 60), `comment-read` (300, 20)                             |
| `work`       | `task-create` (100, 10), `task-update` (300, 20), `task-rewrite` (100, 10), `comment-create` (100, 10) |
| `clean-up`   | `task-delete` (30, 5)                                                                                  |

Each macro-action's `narrative`, the two to four sentences its public page shows, is in
`src/risk-catalog.yaml`.

## Tests

`npx vitest run plugins/asana` — the SDK kit (`assertPluginWellFormed`, `assertNoWildcard`,
`assertCatalogCoverage`, `assertSlicesOnDataModel`, `catalogPathIssues`, `assertIdentifiersRefused`)
on the plugin's `examples` (`src/examples.ts`); the layered deletion and the gates of each trust level; the classifier
branch by branch (`classify.test.ts`); hostile identifiers fed to both sides (`identifiers.test.ts`);
the executor, the membership proof and what is cut from an answer (`execute.test.ts`); discovery
(`discovery.test.ts`); the guide and the check at paste (`credential.test.ts`). No test calls Asana.
