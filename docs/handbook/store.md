---
title: Store — embedded SQLite, schema v1, repositories
status: current
date: 2026-10-13
tracks:
  - apps/gateway/migrations/
  - apps/gateway/src/server/store/
  - apps/gateway/tests/unit/server/store/
  - apps/gateway/tests/integration/store/
---

# Store — embedded SQLite, schema v1, repositories

The store is the gateway's only persistence: one SQLite file on the mounted volume,
opened by the process, migrated at boot, accessed through repository interfaces.
Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §2 (domain), §3 (budget,
requests, approvals), §6 (encryption at rest, immutable audit), §8 (audit). Decisions:
[embedded-store-sqlite-and-migrations](../decisions/embedded-store-sqlite-and-migrations.md).

## Layout

```
apps/gateway/migrations/
  0001_schema.sql                 schema v1 (28 tables, 4 triggers)
apps/gateway/src/server/store/
  index.ts                        openStore() / openMemoryStore(), Store type, re-exports
  db.ts                           better-sqlite3 handle, pragmas, withImmediateTransaction, backupTo
  migrate.ts                      loadMigrations(), runMigrations(), schema_migrations bootstrap
  ids.ts                          newId() — UUIDv7 as text
  clock.ts                        Clock, systemClock, ManualClock (tests)
  encryptor.ts                    re-exports the crypto module's Encryptor port + sealText/openText helpers
  catalog-index.ts                CatalogIndex interface, SetCatalogIndex, assertKnownRiskIds
  audit-writer.ts                 SqliteAuditWriter implementing @vaubaan/gateway-core's AuditWriter
  errors.ts                       StoreError, NotFoundError, UnknownRiskIdError, InvariantError, MigrationError
  types.ts                        record types (UserRecord, MissionRecord, …)
  testing.ts                      StubEncryptor, TEST_RISK_IDS, openTestStore() — tests only
  repositories/
    context.ts                    RepoContext (db, clock, newId, encryptor, catalog) + row helpers
    users.ts groups.ts connections.ts shares.ts missions.ts sessions.ts
    requests.ts approvals.ts delegations.ts audit.ts config.ts
```

## Opening the store

The composition root does it at boot (`apps/gateway/src/server/compose/store.ts`,
handbook [[configuration]]):

```ts
import { openStore } from '@/server/store/index.ts';

const store = openStore({
  path: config.store.path, // InstanceConfig.store.path, or MEMORY_PATH
  encryptor, // the crypto module's Encryptor built by the composition root
  catalog: new RegistryCatalogIndex(registry), // one source of truth: the plugin registry
});
// store.users, store.groups, store.connections, store.shares, store.missions,
// store.sessions, store.requests, store.approvals, store.delegations, store.audit,
// store.config, store.auditWriter, store.schemaVersion, store.backupTo(),
// store.kind ('sqlite' | 'memory'), store.ping(), store.close()  <- compose/ports.ts Store port
```

`RegistryCatalogIndex` (`compose/registry.ts`) answers `has(riskId)` from
the registry's catalogs: a base id exists when its provider is registered
and the catalog has the entry; an env-qualified id (`acme[prod].thing-write`)
exists when the entry is env-scoped and lists that environment in
`acceptable_in_envs`. With the empty registry of today every write of a
risk id is refused (`UnknownRiskIdError`), which is correct: no plugin, no
mission. `SetCatalogIndex` remains for tests. `root.store` is this object;
`GET /healthz` pings it and reports `kind`.

`openStore()`:

1. opens the file (created if absent) with `busy_timeout` 5 s and refuses SQLite older
   than 3.37 (no `STRICT`);
2. sets `journal_mode = WAL` (file databases), `synchronous = NORMAL`,
   `foreign_keys = ON`, `temp_store = MEMORY`;
3. creates `schema_migrations` if needed, then applies every
   `migrations/NNNN_name.sql` not yet recorded, each in one `BEGIN IMMEDIATE`
   transaction, recording name and SHA-256 checksum. An applied file whose checksum
   changed aborts the boot (`MigrationError`): applied migrations are immutable, fixes
   are new files;
4. builds the repositories over one `RepoContext`.

`openMemoryStore()` does the same on `:memory:` — this is what every test uses
(`openTestStore()` in `testing.ts` adds a `ManualClock`, a `StubEncryptor` and a
five-id catalog).

## Conventions every repository follows

- **Ids** are UUIDv7 text generated in the application (`newId()`); **timestamps** are
  ISO-8601 UTC text produced by the injected `Clock`. SQL never calls
  `CURRENT_TIMESTAMP`.
- **Interfaces are async**, implementations are synchronous better-sqlite3 calls. Only
  the `decide` callback of `decideAndDecrement` is synchronous by contract because it
  runs inside the transaction.
- **Multi-statement writes** go through `withImmediateTransaction(db, fn)` =
  `BEGIN IMMEDIATE … COMMIT`, taking the write lock up front so concurrent writers
  wait (then fail with `SQLITE_BUSY` after the busy timeout) instead of failing at
  commit.
- **Risk ids are checked against the catalog** before any write to
  `share_restrictions` or `mission_policy` (`UnknownRiskIdError` lists the unknown
  ids). The schema additionally rejects `''` and anything containing `*`.
- **Encrypted columns** (`connections.credential_blob`, `requests.args_blob`,
  `instance_config.secret_blob`) are sealed by the injected `Encryptor` (the crypto
  module's port: `encrypt(id, text)` / `decrypt(id, { keyVersion, blob })`) with the
  row id as associated data and stamped with `key_version`. The port is async and
  transactions are sync, so a repository seals before `BEGIN IMMEDIATE` and opens
  after `COMMIT`. Records never expose the ciphertext; `getCredential()`,
  `getArguments()`, `getSecret()` open it on demand and return clear text.
- **Errors**: `NotFoundError` for a missing row named by id, `InvariantError` for a
  domain rule (duplicate policy risk, revoked share revoked again, selected scope
  with no resource…), driver errors (`SqliteError` with `code`) for constraint
  violations the schema catches (`UNIQUE`, `FOREIGN KEY`, `CHECK`).

## Schema v1 (`0001_schema.sql`)

| Area        | Tables                                                                                                                     | Notes                                                                                                                                                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instance    | `instance_config`, `schema_migrations`                                                                                     | key → clear `value` **or** `secret_blob`+`key_version`, never both                                                                                                                                                                                                                 |
| Identities  | `users`, `groups`, `group_members`                                                                                         | `users.subject` unique (IdP), `status active\|removed`; `groups.source idp\|local`                                                                                                                                                                                                 |
| Delegations | `oauth_clients`, `oauth_client_redirect_uris`, `delegations`, `oauth_codes`, `oauth_refresh_tokens`, `oauth_access_tokens` | all secrets stored as hashes by the caller; codes single-use; refresh tokens chain through `replaced_by_id`                                                                                                                                                                        |
| Connections | `connections`, `connection_resources`                                                                                      | owner = `owner_kind` + `owner_user_id`/`owner_group_id` with a CHECK; status `active\|expired\|revoked\|unowned`; resources unique per `(connection_id, ref)` with an `env` label                                                                                                  |
| Shares      | `shares`, `share_restrictions`                                                                                             | target principal like owner; one `risk_id` row per restriction entry                                                                                                                                                                                                               |
| Missions    | `missions`, `mission_connections`, `mission_resources`, `mission_policy`, `mission_tokens`                                 | status `active\|expired\|orphaned\|revoked` (`exhausted` is per risk, computed); `period_anchor` + nullable `period_seconds`; `resource_scope all\|selected`; policy row = `(quota, rate_limit, rate_window_seconds, gate)`; partial unique index = one `active` token per mission |
| Sessions    | `sessions`, `session_counters`, `events`                                                                                   | one session per mission (`mission_id` unique); counters keyed `(session_id, risk_id, period_start)`; events are free-form `kind` + JSON details                                                                                                                                    |
| Requests    | `requests`, `approvals`                                                                                                    | `kind claim\|approval`, `state open\|granted\|refused\|expired`; approval requests carry `tool`, `fingerprint`, encrypted `args_blob`; one approval per request, consumed via `consumed_at`                                                                                        |
| Audit       | `audit`, `audit_risks`, `audit_purge_guard`                                                                                | see below                                                                                                                                                                                                                                                                          |

SQLite-only constructs are marked `-- sqlite:` in the file (`STRICT`, `RAISE(ABORT)`);
the ADR lists the Postgres replacement for each.

## Audit

`store.audit.append(entry)` takes `@vaubaan/gateway-core`'s `AuditEntry` (P0.5 owns
the shape, `packages/gateway-core/src/audit.ts`):

- `CallAuditEntry` — `mission_id`, `session_id`, `connection_id`, `resource_ref`,
  `tool`, `arguments_hash`, `slices_executed` (stored as a JSON snapshot), `decision`,
  `refusal_code`, `refusal_reason`, `approval_id`, `agent_label`,
  `upstream_latency_ms`, `upstream_error`, `client_ip`, `client_user_agent`;
  `accepted_risks_snapshot`, `risks_touched` and `remaining_budget` are unfolded into
  one `audit_risks` row per risk (`accepted`, `touched`, `remaining`) and folded back
  on read, so the record round-trips the entry (plus `id` and the raw `risks` rows);
- `AdminAuditEntry` — `user_id`, `act`, `object: { type, id }`, `before`/`after`
  (JSON), `delegated_client_id`.

Immutability is enforced by triggers: every `UPDATE` on `audit`/`audit_risks` aborts;
a `DELETE` aborts unless `audit_purge_guard` holds a cutoff newer than the row.
`store.audit.purgeOlderThan(cutoff)` is the only path that opens that window, inside
its own transaction; `purgeByRetention(days = 90)` computes the cutoff from the clock.
`countAllowedTouches(mission, risk, since, until)` serves the structural check
"session counters agree with the audit" (spec §10).

`store.auditWriter` is a `SqliteAuditWriter` implementing gateway-core's
`AuditWriter`; `write()` throws on failure (audit is not best-effort: the pipeline
treats a rejected write as an internal error).

## The decision primitive

```ts
const result = await store.sessions.decideAndDecrement(
  { missionId, riskIds: risksTouched, periodStart },
  (ctx) => {
    // ctx.session, ctx.counters (consumed per risk this period), ctx.now
    // ctx.consumeApproval(riskId, fingerprint) -> ApprovalRecord | null   (single use)
    // ctx.createRequest({ kind, riskId, tool?, fingerprint?, prepared?, expiresAt })
    //   prepared = await store.requests.prepareArguments(args), sealed BEFORE the call
    // ctx.recordEvent({ kind, riskId?, actorUserId?, details? })
    return { allow, event: { kind: allow ? 'allowed-call' : 'refused-call' } };
  },
);
// result.outcome (what decide returned), result.session, result.counters (after)
```

Everything inside runs in one `BEGIN IMMEDIATE` transaction: session get-or-create
("born on the first call"), counter read, the callback, the per-risk increment when
`allow` is true, the outcome's event. A thrown callback rolls everything back,
including the session creation. The accounting rules (period arithmetic, quota and
rate comparison, gate) are feature P1.3's callback; this module only guarantees the
atomicity. Rate-limit sliding windows are not stored here (in-memory, P1.3).

## Backup

`store.backupTo('/data/backups/gateway-2026-10-13.sqlite')` runs `VACUUM INTO`: a
consistent, compacted copy taken online, with no `-wal` file to pair. Prefer it over
copying the database file: in WAL mode a plain `cp` of `gateway.sqlite` without its
`gateway.sqlite-wal` loses committed transactions. Block-level volume snapshots that
capture both files atomically are also fine.

## Tests

- `tests/unit/server/store/ids.test.ts` — UUIDv7 shape, embedded timestamp, ordering,
  uniqueness.
- `tests/unit/server/store/migrate.test.ts` — file naming, ordering, duplicate
  versions, idempotent re-run, incremental apply, checksum immutability, rollback of a
  failing file, shipped `0001_schema`.
- `tests/integration/store/schema.test.ts` — all 28 tables, every table `STRICT`,
  the composition `Store` port (`kind`, `ping`, `close`), boot against an empty file
  (WAL, foreign keys, `NORMAL`), reopen without re-migrating, two writers on one file
  serialize (`SQLITE_BUSY` then success), `VACUUM INTO` backup.
- `tests/integration/store/audit.test.ts` — gateway-core call and admin entries
  round-trip, `UPDATE`/`DELETE` abort, purge path and its boundaries, retention
  default, filters, allowed-touch count, schema `CHECK`s, writer contract.
- `tests/integration/store/{identities,connections-shares,missions,sessions,requests-approvals,delegations,config}.test.ts`
  — one suite per repository on `:memory:`, including the catalog check and the
  schema-level wildcard `CHECK`, the N=50 concurrent `decideAndDecrement` on quota 1
  (exactly one allow), in-transaction approval consumption and request drop, the
  counters-vs-audit structural check, argument erasure on decision and expiry.
- `tests/integration/compose/boot.test.ts` (handbook [[configuration]]) — the
  composition root opening this store on a temporary file with the real encryptor
  and the registry-backed catalog index.
