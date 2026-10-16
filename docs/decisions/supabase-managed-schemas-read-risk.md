---
title: Supabase — reading the schemas the provider manages is a risk of its own, decided by what the SQL names, fail closed
status: accepted
date: 2026-10-13
---

# Supabase — reading the schemas the provider manages is a risk of its own, decided by what the SQL names, fail closed

> Product owner's decision of 2026-10-13 (question 2 of the final pass, finding
> B-M2 of the clean-code review). Spec:
> [gateway-risk-model §7.2](../spec/gateway-risk-model.md). Handbook:
> [providers/supabase, "Reading a query"](../handbook/providers/supabase.md#reading-a-query).

## Context

`supabase__execute_sql` runs free-form SQL on the Management API read-only
endpoint. The database refuses any mutation there, so the classifier emitted
one read slice for any query and the call passed with `supabase.read-data`.

Read-only is not harmless. A project database also holds what Supabase keeps
for itself: `auth.users` with password hashes, `auth.sessions` and
`auth.refresh_tokens`, `vault.decrypted_secrets`, the object rows of `storage`,
the request queue of `pg_net`. A mission issued from the **Read-only analyst**
preset, meant to query application tables, could read all of it. The catalog
even said `auth.read-users` "also covers direct SELECTs on `auth.users`"; no
code made that true.

Whether the role behind the read-only endpoint can select from those schemas
is not settled by the provider documentation: it names the role
(`supabase_read_only_user`) and does not list its grants. The decision does not
depend on the answer.

## Decision

### D1. A separate risk, env-scoped, absent from read presets

`supabase.read-managed-schemas` (catalog v4), matching
`supabase.project[**].schema[managed].row[**].R`, acceptable on `preview`,
`staging` and `prod` — so, like `auth.read-users`, refused on a project the
owner has not labelled. **Read-only analyst** and **Migration operator** do not
carry it. **Staging developer** carries it on `[staging]`: that preset already
lists users and applies any migration there, and D3 would otherwise refuse it
every query that calls an application function.

### D2. The classifier decides by what the SQL names

`execute_sql` always emits `schema[any].row[bulk].R`, and adds
`schema[managed].row[bulk].R` when the query names a sensitive managed schema
as a qualifier, or a sensitive catalog relation by its bare name. `managed` is
a literal marker in the identifier position, like `bulk`; no tool argument can
spell it into a slice.

The lists live in the plugin's data model (`SUPABASE_MANAGED_SCHEMAS`, with a
kind — `sensitive` or `inspection` — and the reserved prefixes) and are shared
with the migration reader, which had its own copy.

### D3. A query that cannot be read with confidence requires the risk

The reader is an allow-list. A query is an application read only when the
tokeniser accepts its text, every statement starts with `SELECT`, `WITH`,
`VALUES`, `TABLE`, `EXPLAIN` or `SHOW`, and every function it calls is on a
list of built-ins that compute from their arguments alone. Anything else is
priced as a read of the managed schemas.

The function rule is what closes the door: a function is how a query reads a
relation it does not name (`query_to_xml`, `set_config('search_path', …)`,
`dblink`, a function defined in the database). A deny-list of such functions
cannot be complete; an allow-list of inert ones can be short and wrong only in
the costly direction.

### D4. Versions

Catalog `4`. Plugin `4.0.0`: a call the previous version allowed is now
refused.

## Consequences

- A mission holding `read-data` alone runs plain queries on application tables
  and nothing else through `execute_sql`. Existing missions do not hold the new
  risk; their creators add it where they want it.
- False positives are by design: a query calling `my_report()`, a built-in the
  list does not hold, a CTE with a column list, a `$1` parameter. The refusal
  names the risk; the handbook says how to read it.
- Not covered, and said so: a view in an application schema defined over a
  managed one, a user-defined operator. Creating either is a migration.
- `auth.read-users` is again what its pattern says: the auth admin API.

## Rejected alternatives

- **Rely on the role's grants.** Unknown from the documentation, different on
  self-hosted projects, and changeable by a migration. A rule that holds only
  while a grant is absent is not a rule of the gateway.
- **A deny-list of dangerous functions.** Incomplete by construction:
  extensions add functions that take SQL as text (`crosstab`), and the
  application defines its own.
- **Scan string literals for schema names.** `'au' || 'th.users'` defeats it,
  and it flags harmless text. A string becomes a relation only through a
  function; checking the function is exact.
- **Require the risk for every `execute_sql`.** Simple, and it removes the
  only thing the analyst preset is for.
- **A real SQL parser.** It would recognise more plain queries; it would not
  see through a function either. Same conclusion as
  `sql-classification-syntactic-only`.
