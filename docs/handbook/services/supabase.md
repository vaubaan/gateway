---
title: Supabase plugin
tracks:
  - plugins/supabase/src/
  - plugins/supabase/README.md
last_reviewed: 2026-11-26
---

# Supabase plugin — handbook

`@vaubaan/plugin-supabase`: Management API plus each project's data plane (auth, storage), one
resource per project, the owner's label as environment; one resource per preview branch too,
labelled `preview` by the plugin.

## Start here

- [`src/classify.ts`](../../../plugins/supabase/src/classify.ts) — pure; readers shared with execute.
- [`src/migration-sql.ts`](../../../plugins/supabase/src/migration-sql.ts),
  [`src/query-sql.ts`](../../../plugins/supabase/src/query-sql.ts),
  [`src/sql-tokens.ts`](../../../plugins/supabase/src/sql-tokens.ts) — the SQL allow-list readers.
- [`src/execute.ts`](../../../plugins/supabase/src/execute.ts) and
  [`src/redact.ts`](../../../plugins/supabase/src/redact.ts) — requests, redaction.

## Invariants

- **One project resolution**: `execute` builds every URL from `resolveProjectRef` and never reads
  `args.project_ref`. The ref must be a host label (it becomes `https://{ref}.supabase.co`) and a
  mission resource. `project_ref` also takes a project's exact name (the resource's display name),
  answered as its ref: the name never reaches a slice or a URL. A name two mission projects share is
  refused (ask for the ref); a ref wins over a name that spells it.
- `list_projects` (6.3.0) answers the mission's projects of the account from the resources the
  gateway passes (`missionProjects`): ref, name, environment, region, URL; no request reaches
  Supabase, and a project outside the mission is never named. It is priced as reading the settings
  of every project it names (`project[ref].project-settings.R`, as `get_project`) and refused when
  the mission holds none. Every project refusal (ambiguous, not a mission resource, shared name)
  also names them as `name (ref)`, ten at most, and points to `list_projects`.
- Every argument landing in a path, query, host, header or plugin-written SQL is read by
  `readIdentifiers` / `tableSchemas`, refused when out of grammar, never escaped:
  `encodeURIComponent` leaves `..`, so `delete_function` with `..` would hit the project endpoint
  ([ADR](../../decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md)).
  `content_base64` is required because `String(undefined)` is valid base64.
- Cardinality markers are literal (`row[bulk]`, `object[one]`, `user[one]`): single-object and
  single-user writes emit the marker alone, the id never a slice segment (an id spelled `bulk` would
  read as the marker). An id with a character a slice cannot carry is validated, sent, and written
  `[*]`.
- `deploy_function` always touches deploy **and** body-write: a deployment replaces the code and its
  exposure (`verify_jwt`, entrypoint).
- **Reading a migration** (`readMigrationSql`): an allow-list, not a parser. It strips comments and
  literals, splits on `;`, and recognises a statement only by its leading keywords, nothing in it
  able to embed a command. **Anything else makes the whole migration unrecognised and emits all five
  write slices** (`DO`, `$$`, functions, triggers, views, CTEs, bare `SELECT`, `SET`, `COPY`,
  prefixed strings, a backslash in a string, a write to a managed schema such as `auth.users`).
- A line comment ends at `\n` **or** `\r`, as in PostgreSQL; waiting for `\n` alone would hide what
  follows a bare carriage return.
- A column type change is a bulk row write (it rewrites every row; `USING` can overwrite values).
- **Reading a query** (`readQuerySql`): `execute_sql` runs on the read-only endpoint (as do
  `list_tables`, `list_migrations`); the reader decides **by what the SQL names, never by the role's
  grants** (undocumented). A qualifier is folded to lower case (`"AUTH".users` is `auth`). Unread,
  so priced as a managed-schema read: anything the tokeniser refuses, a first keyword outside
  `SELECT` / `WITH` / `VALUES` / `TABLE` / `EXPLAIN` / `SHOW`, and **any function outside the inert
  list** (a function is how a query reads a relation it does not name: `query_to_xml`, `set_config`,
  `dblink`). The managed-schema list lives once, in `src/data-model.ts`.
- `read-managed-schemas` (macro-action `query`) asks first at Careful: reading identities and
  secrets is deliberate, a person approves it.
- **Preview branches** ([ADR](../../decisions/preview-branches-are-discovered-resources.md)):
  discovery lists `GET /projects/{ref}/branches` for every project, after the projects, under the
  same cap. A branch is a resource of its own (its `project_ref`), `env: 'preview'` unless
  `persistent` (then the owner labels it), metadata `parent_project_ref`, `git_branch`,
  `pr_number`. The default branch (`is_default`, the project itself) is never a resource. A
  project whose branches cannot be listed (branching off, a token without Branching) adds none
  and fails nothing.
- **A branch is judged as itself**: `get_branch`, `delete_branch`, `reset_branch` and every other
  tool take the branch's own ref, so the call lands in the branch's set and environment, never
  the parent's. `list_branches` alone takes the parent. `branchParentOf` (classify) refuses the
  branch tools on a resource without a valid `parent_project_ref`; `delete_branch` and
  `reset_branch` then ask Supabase again (`confirmBranch`: listed under that parent, not default).
- `list_branches` is the plugin's `resourceRevealingTools`: after it, the host runs one discovery,
  so a branch opened since the last refresh is reachable seconds later.
- **Answers that carry secrets** (function secrets, auth config) are redacted by an **allow-list**
  of non-secret fields: any other field with a value, one added upstream tomorrow included, becomes
  `[redacted by Vaubaan]`; `null` / `''` stay so an agent sees whether a secret is set. The
  `service_role` key is never returned; `get_anon_key` strips it. `get_branch` redacts the
  branch's `db_pass` and `jwt_secret` the same way.

## Traps

- A recreated branch (closed and reopened pull request) has a **new ref**: the old resource goes
  stale, the new one is a new resource. Find it by `git_branch` (`list_branches`, `list_projects`).
- The branch `status` of `GET /projects/{ref}/branches` is deprecated upstream ("list action
  runs"); still answered as Supabase sends it. Whether `reset` replays the seed is not documented:
  check a branch's migrations after a reset.
- A mission reaches a new branch only through a `preview` set with future resources on (or an
  edit): a branch is never reached through its parent.

- A project's name is the discovered display name, `Organization / project`
  (`discoverSupabaseResources`), not Supabase's bare project name: `app` does not match `Acme / app`.
- `get_anon_key` stays priced as `supabase.read-data` (decided 2026-11-01): the anon key is public by
  design and opens only what RLS allows; a leaf of its own would price a public value as a secret.
- Known limits by construction: a recognised statement can evaluate an existing function
  (`DEFAULT f()`, `CHECK`); a named relation can be a view over `auth`. Creating either is itself a
  migration, priced on its own.
- Adding a built-in to the inert list is a one-line change in `query-sql.ts`, reviewed like the
  catalog. A new non-secret auth field shows redacted until added to the allow-list.

## Outside the repo

- A Management API **personal access token** (`sbp_…`), scoped (a "Legacy" token has full account
  access). Dashboard permissions per tool group: Project Settings, API Keys, API Key Secrets (the
  data plane reads the service role key), Database, Migrations, Advisors, Branching (also read by
  discovery), Storage Config, Auth Config, Edge Functions, Secrets; the last three and Branching
  not confirmed endpoint by endpoint (the OpenAPI names `branching_development_*`).

## Debug

- A migration asks for all five write risks → one statement is off the allow-list; split it.
- `execute_sql` on an application table asks for `read-managed-schemas` → the query is unread.
- "acceptable only in [preview, staging]" → a bulk write on prod (schema changes and RLS only).
- A preview branch refused `resource-not-in-mission` → the mission has no `preview` set with
  future resources, or the branch is not discovered yet: `list_branches` on its project.
