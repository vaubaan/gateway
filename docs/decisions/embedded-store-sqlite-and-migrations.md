---
title: The store is SQLite through better-sqlite3 behind asynchronous repositories, with in-house forward-only migrations and invariants held by the schema
status: accepted
date: 2026-10-13
---

# The store is SQLite through better-sqlite3 behind asynchronous repositories, with in-house forward-only migrations and invariants held by the schema

## Context

The gateway is one process in one image with no external service, so it must own and apply its
schema itself; nothing may preclude a hosted Postgres later. Its invariants must be structural:
`RiskId` enumerations cannot hide a wildcard, the audit is immutable (spec §6), and the budget
decision and its decrement are one atomic operation.

## Decision

`better-sqlite3` is referenced only in `apps/gateway/src/server/store/db.ts`; repositories speak SQL
behind asynchronous interfaces, while code inside a transaction stays synchronous. Migrations are
numbered `.sql` files applied at boot, each in one transaction, checksummed and immutable, with no
down migration. Enumerations are rows, tables are `STRICT`, and the audit is protected by triggers
that abort every update and every delete outside the purge window.

## Consequences

- An operator never runs a migration by hand; a fix is a new file, and an image older than the
  schema fails at boot naming the migration.
- Encrypted blobs are sealed before a transaction and opened after it (the `Encryptor` is
  asynchronous); arguments dropped inside a decision are sealed ahead.
- SQLite-only constructs are marked `-- sqlite:` or confined to `db.ts`; a Postgres port replaces
  those and the rate limiter, not the repositories' callers.
- Conventions (ids, timestamps, pragmas, backup): handbook [store](../handbook/store.md).

## Rejected alternatives

### `node:sqlite`

Was experimental with no transaction helper; the swap is confined to `db.ts` once it is stable.

### Drizzle or Kysely

A second schema description that drifts from the SQL a human reads during an incident.

### Audit immutability by convention

In a single-process store the trigger is the only barrier against an ad-hoc `UPDATE`.

### JSON arrays for touched and accepted risks

Rows keep the counters-vs-audit check a plain join and the never-a-sentinel rule uniform.
