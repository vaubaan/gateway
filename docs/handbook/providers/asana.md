---
title: Asana provider plugin
status: current
date: 2026-11-05
last_synced: 2026-11-05
tracks:
  - plugins/asana/src/
  - plugins/asana/tests/unit/
  - plugins/asana/package.json
  - plugins/asana/README.md
---

# Asana provider plugin — handbook

`@vaubaan/plugin-asana`: projects, sections, tasks, subtasks and comments of one Asana account, on
the REST API (`https://app.asana.com/api/1.0`), with a personal access token. One resource per
project; no environment. Rules common to every plugin: [providers README](README.md).

## Start here

- [`src/call.ts`](../../../plugins/asana/src/call.ts) — `readCall`, the one reader shared by
  classify and execute: the project resolved against the mission, every value through its grammar.
- [`src/membership.ts`](../../../plugins/asana/src/membership.ts) — the proof that a task or a
  section is in the project the call names.
- [`src/execute.ts`](../../../plugins/asana/src/execute.ts) — proof first, then the request built
  field by field; `shapeTask` cuts other projects out of an answer.
- [`src/discovery.ts`](../../../plugins/asana/src/discovery.ts) — workspaces, then projects.

## 1. Data model

One plane, `work`: `project` (the resource; `one`, `bounded` for `list_projects`) → `section`
(`one`, `unbounded`) and `task` (`one`, `unbounded`) → `comment` (`one`, `unbounded`), and the verb
leaf `delete` under `task`. A subtask is a `task` under the project it belongs to through its
ancestors. No entity carries an environment (Asana has none); no `envOf`.

## 2. Tool → slice mapping

Read in [`src/classify.ts`](../../../plugins/asana/src/classify.ts) (`slicesOf`); the table is in the
plugin [README](../../../plugins/asana/README.md#tools). Every slice is rooted at
`project[<the project the call names>]`; `list_projects` names all the mission's projects in one
bounded slice; `delete_task` emits two slices (`task[t].W` and `task[t].delete.W`).

## 3. Catalog and macro-actions

Seven named risks and `asana.uncategorized-write`, in `read` (project-read, task-read,
comment-read), `work` (task-create, task-update, comment-create) and `clean-up` (task-delete). The
patterns do not overlap except by design: `task[*].W` does not match `task[t].comment.W` nor
`task[t].delete.W`, so commenting never needs `task-update`; the deletion carries both risks
because the classifier emits both slices. `comment-read` is `pii` (asks at Careful);
`task-update` and `task-delete` are `costly` (ask at Careful and Trusting). The narratives meant
for the `narrative` key are in the README until the loader accepts it.

## 4. Coverage

| Tool                   | Risks touched                            |
| ---------------------- | ---------------------------------------- |
| `asana__list_projects` | `asana.project-read`                     |
| `asana__get_project`   | `asana.project-read`                     |
| `asana__list_sections` | `asana.project-read`                     |
| `asana__list_tasks`    | `asana.task-read`                        |
| `asana__search_tasks`  | `asana.task-read`                        |
| `asana__get_task`      | `asana.task-read`                        |
| `asana__list_comments` | `asana.comment-read`                     |
| `asana__create_task`   | `asana.task-create`                      |
| `asana__update_task`   | `asana.task-update`                      |
| `asana__add_comment`   | `asana.comment-create`                   |
| `asana__delete_task`   | `asana.task-update`, `asana.task-delete` |

No tool reaches the fallback (`fallbackHits` is empty in `plugin.test.ts`).

## 5. Edge cases

- **The project binding is proven in `execute`, not in `classify`.** A task gid says nothing about
  its project and classification is pure, so every task tool takes `project` (checked against the
  mission by `resolveProject`) and `task_gid`, and the slice names the project the caller claims.
  Before anything else is sent or returned, `proveTaskInProject` reads
  `GET /tasks/{t}?opt_fields=projects.gid,memberships.project.gid,parent.gid` and refuses
  (`task '…' is not in project '…'`, an `ExecutorRefusal`) when the project is not among them. The
  same for a `parent` (create a subtask) and, for every `section`, `GET /sections/{s}` →
  `project.gid`. `get_task` asks its display fields in the same read: one request when the task is
  directly in the project. The refusal says nothing about where the object is.
- **Subtasks inherit the projects of their ancestors** (Asana's search: `projects.any` "returns
  tasks that are directly in these projects or inherit them from an ancestor task"). The proof
  walks `parent` up to `MAX_PARENT_DEPTH` (5) levels; deeper is refused. A subtask is created with
  `POST /tasks/{parent}/subtasks` and no `projects`, so it joins the project through its parent;
  `section` and `parent` together are refused (a subtask is in no section).
- **A task in several projects**: the mission may read it through one of them. `shapeTask` removes
  `projects` and keeps only the memberships of the named project, reduced to section names, so the
  names of the other projects and their columns never reach the agent.
- **`list_projects` is answered locally**, from the mission's resources (gid, name, workspace,
  team), like `google_calendar__list_calendars`: no Asana call, and nothing the mission does not
  hold. `GET /workspaces/{w}/projects` serves discovery only.
- **Search is Premium only and rate-limited at 60 a minute** (Asana's search limit, apart from the
  standard 150 or 1,500 a minute). Without Premium Asana answers 402, thrown as `UpstreamHttpError`.
  The workspace gid comes from the resource metadata (refused when missing: refresh the account);
  the project is a filter (`projects.any`), so results stay in the project.
- **401 versus 403**: the SDK maps both to `UpstreamAuthError`, and Asana answers 403 for an object
  the account cannot open as well as for a refused token. The gateway expires a connection on 401
  only, so a 403 on one task leaves the account connected.
- **`me` as assignee** is passed to Asana as the literal `me`, the connected account. Any other
  assignee is a user gid: the classifier never parses an email address.
- **No environment**: no entity is `envScopable`, no risk is env-scoped, no `envOf`. A resource's
  label, if its owner sets one, prices nothing.
- **Comments**: `GET /tasks/{t}/stories` is asked with `resource_subtype=comment_added`, and the
  answer is filtered on that subtype again, since stories also carry system events.

## 6. Credential, discovery, execution, tests

- **Credential**: `api-key`, field `personal_access_token`, pattern `^\S{20,512}$` (Asana: treat
  tokens as opaque). `permissions: []` (a PAT has no scopes); expiry `none` (PATs are "persistent by
  default"). `verify` reads `GET /users/me?opt_fields=name,email,workspaces.name`: account
  `name (email)`, a `CredentialRefusal` when the account belongs to no workspace. Revocation by the
  gateway: none (a pasted token); `manualRevocation` names the developer console.
- **Discovery**: workspaces of `/users/me`, then `GET /workspaces/{w}/projects?archived=false`,
  100 a page, `next_page.offset`, at most `MAX_PROJECTS` (500) in all (a plain `Error` past it).
  Every gid through `asanaGid`; an answer the guards refuse is an `UpstreamProtocolError`.
- **Execution**: `api.ts` wraps `httpJson` (`redirect: 'error'`), the body sent as `{ data: … }`,
  the answer read through `isDataObject` / `isDataList`; the `Retry-After` of a 429 is added to the
  message, never retried (a rejected request still counts against Asana's quota).
- **Identifiers**:
  - `asanaGid`, `^[0-9]{1,32}$` — project, task, section, parent and assignee gids, workspace gid
    from the metadata; lands in a URL path (`/tasks/{t}`) or the body.
  - `offsetToken`, `^[A-Za-z0-9_=.-]{1,1024}$`, not dots alone — `offset`, and every `next_page`
    offset Asana answers; lands in a query string only (`URLSearchParams`).
  - `isoDate` `YYYY-MM-DD` (`due_on`, body); `completedSince` `now` or a timestamp with its zone
    (query); `assigneeIdent` `me` or a gid (body, or the `assignee.any` query of search).
  - `lineText` (no control character: `text` of search ≤ 500, `name` ≤ 1024) and `longText`
    (line breaks allowed: `notes`, comment `text`, ≤ 65 535): body or query, never a path.
- **Undeclared arguments**: requests are built field by field from what `readCall` returned, so an
  argument the tool does not declare is never read nor sent; no `undeclaredArgumentDenial`.
- **Tests**: `npx vitest run plugins/asana`; the samples feed the kit and the identifier proof
  (`routes: world()` so executions reach their writes); `identifiers.test.ts` feeds hostile values
  to every gid position on both sides.

## Tools deliberately left out

- Creating, changing or deleting a project: it changes the resource a mission is cut on.
- Membership and follower management: these are access rights, not work.
- Attachments, upload and download: files are out of the model.
- Tags: workspace-wide objects outside any project.
- Writing custom fields: their definitions are workspace objects a task write would reach.
- Portfolios and goals: they span projects outside a mission.
- Webhooks: a standing subscription outlives the call that creates it.
- The batch API: one call would carry many unclassified requests.
- Listing users: the directory of the workspace is not a project's.
- An assignee by email: a gid or `me` only, so the classifier never parses an address.

## Traps

- `GET /workspaces/{w}/projects` "may timeout for large domains" (Asana); discovery fails then and
  the refresh can be retried.
- Offsets expire "after some time"; an expired one is Asana's 400, thrown as `UpstreamHttpError`.
- `POST /sections/{s}/addTask` removes the task from the other sections of that project; on a
  subtask it makes the subtask a direct member of the project.
- Unverified (check before 1.0): Asana's longest name, notes and comment text (the bounds here are
  ours); whether an Enterprise admin's PAT rules ever set an expiry `verify` could read
  (`POST /-/token_info` reports `exp`, not called).

## Outside the repo

- The person signs in to Asana as the account the agents will act as (a dedicated "bot" account if
  their actions should not read as a person's, as Asana's authentication page advises), opens the
  developer console (`https://app.asana.com/0/my-apps`, or profile photo, My Settings, Apps, Manage
  Developer Apps), chooses **+ Create new token**, names it "Vaubaan Gateway", and pastes it; Asana
  shows it once. To end the account, delete the token there.
- Asana documentation read through Context7 (`/websites/developers_asana`) on 2026-11-05: Personal
  access token; Authentication; Quick start; Rate limits; Pagination; `GET /workspaces/{gid}/projects`;
  `GET /projects/{gid}/sections`; `GET /projects/{gid}/tasks`; `GET /sections/{gid}/tasks`;
  `GET /workspaces/{gid}/tasks/search`; `POST /tasks`; `PUT /tasks/{gid}`; `DELETE /tasks/{gid}`;
  the `task` resource (`memberships`); `GET /tasks/{gid}/stories`; `POST /tasks/{gid}/stories`;
  `POST /sections/{gid}/addTask`; `GET /tasks/{gid}/subtasks`; `POST /tasks/{gid}/subtasks`;
  `POST /-/token_info` (OAuth page). Not read separately: `GET /users/me`, `GET /projects/{gid}`,
  `GET /tasks/{gid}`, `GET /sections/{gid}` (their fields are those the pages above show).

## Debug

- `402` on `search_tasks` → the workspace is not on a Premium plan; use `list_tasks`.
- `429 … (retry after N s)` → Asana's limit per token (150 a minute free, 1,500 paid, 60 searches);
  lower the mission's rate limit.
- `task '…' is not in project '…'` → the task belongs to another project, or is a subtask deeper
  than five levels; check the project in Asana.
- `project '…': its workspace is unknown` → the resource predates its metadata; refresh the account.
