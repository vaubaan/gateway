---
title: Supabase provider plugin
tracks:
  - plugins/supabase/src/
  - plugins/supabase/README.md
last_reviewed: 2026-10-27
---

# Supabase provider plugin — handbook

`@vaubaan/plugin-supabase`: Management API plus each project's data plane (auth, storage), one
resource per project, the owner's label as environment.

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
  mission resource.
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
- **Answers that carry secrets** (function secrets, auth config) are redacted by an **allow-list**
  of non-secret fields: any other field with a value, one added upstream tomorrow included, becomes
  `[redacted by Vaubaan]`; `null` / `''` stay so an agent sees whether a secret is set. The
  `service_role` key is never returned; `get_anon_key` strips it.

## Traps

- Known limits by construction: a recognised statement can evaluate an existing function
  (`DEFAULT f()`, `CHECK`); a named relation can be a view over `auth`. Creating either is itself a
  migration, priced on its own.
- Adding a built-in to the inert list is a one-line change in `query-sql.ts`, reviewed like the
  catalog. A new non-secret auth field shows redacted until added to the allow-list.

## Outside the repo

- A Management API **personal access token** (`sbp_…`), scoped (a "Legacy" token has full account
  access). Dashboard permissions per tool group: Project Settings, API Keys, API Key Secrets (the
  data plane reads the service role key), Database, Migrations, Advisors, Storage Config, Auth
  Config, Edge Functions, Secrets; the last three not confirmed endpoint by endpoint.

## Debug

- A migration asks for all five write risks → one statement is off the allow-list; split it.
- `execute_sql` on an application table asks for `read-managed-schemas` → the query is unread.
- "acceptable only in [preview, staging]" → a bulk write on prod (schema changes and RLS only).

## Open questions

- Should `get_anon_key`, which hands out a standing Data API key (public by design, protected by RLS), get its own leaf and risk instead of being priced as `supabase.read-data`?
