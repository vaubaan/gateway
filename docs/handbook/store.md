---
title: Store — embedded SQLite, migrations, backup and restore
tracks:
  - apps/gateway/migrations/
  - apps/gateway/src/server/store/
  - apps/gateway/src/server/compose/store.ts
  - apps/gateway/src/server/restore/
  - apps/gateway/src/server/backup/
  - apps/gateway/src/server/crypto/backup-file.ts
last_reviewed: 2026-10-27
---

# Store — handbook

The gateway's only persistence: one SQLite file on the volume, migrated at boot, reached through
repositories. Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §2, §3, §6, §8. ADRs:
[embedded-store-sqlite-and-migrations](../decisions/embedded-store-sqlite-and-migrations.md),
[scheduled-encrypted-backup-to-object-storage](../decisions/scheduled-encrypted-backup-to-object-storage.md).

## Start here

- [`store/index.ts`](../../apps/gateway/src/server/store/index.ts) — `openStore`, the repositories.
- [`store/db.ts`](../../apps/gateway/src/server/store/db.ts) — pragmas, `BEGIN IMMEDIATE`; the raw
  handle no production code outside the store prepares a statement on.
- [`repositories/context.ts`](../../apps/gateway/src/server/store/repositories/context.ts) — the
  helpers every mapper uses (`parseEnum`, sealed columns).
- [`restore/restore.ts`](../../apps/gateway/src/server/restore/restore.ts) — command and first boot.

## Invariants

- Applied migrations are immutable: a changed checksum aborts the boot, and so does a database
  recording a migration the image does not ship (downgrade). A fix is a new file.
- Every closed-set column is read through `parseEnum`: an unknown value throws `InvariantError`
  (`corrupt-rows.test.ts`). Some columns have no schema `CHECK` (`audit.act`…): the list is their
  only guard.
- Check-then-act writes are one conditional `UPDATE` whose `changes` decides; no writer sets a
  credential, status or owner without a condition.
- A mission token, a share and a request's held arguments are reached with their parent only
  (`MissionTokenKey`, `ShareKey`, `RequestKey`): no repository method takes their id alone, and one
  of another parent reads as missing (**[inv: lookups-keyed-by-parent]**).
- Single writers: sessions, counters and events only through `repositories/sessions.ts`; a
  request is decided only by `decideClaim` / `decideApproval`, a counter lowered only in a claim.
- Derived, never stored: a mission's `orphaned` ([authority](authority.md); type, read and `0007`
  triggers refuse it) and a resource's inherited `default_env` (applied at every read).
- Sealed columns are listed in `SEALED_COLUMNS` (`sealed-blobs.ts`), the push subscriptions of
  `notification_devices` (0030) and the URLs of `notification_addresses` (0031) included: a new
  sealed column joins that list, or `reseal`, the boot probe and the restore check never see it.
  `notification_mail` (0032) holds no secret: a row is a person who switched mail on.
- Audit tables are immutable by trigger; `purgeOlderThan` is the only path that opens the delete
  window. The audit writer throws: audit is not best-effort.

## Traps

- The `Encryptor` port is async and transactions are sync: a repository seals **before**
  `BEGIN IMMEDIATE` and opens **after** `COMMIT`. Decision callbacks (`decideAndDecrement`,
  `decideClaim`, `decideApproval`) must stay synchronous: they run inside the transaction.
- One key per account, derived from the master key: ADR
  [per-org-encryption-app-level](../decisions/per-org-encryption-app-level.md) (slug kept from v4).
- Postgres portability: no parameter whose only use is a `NULL` comparison (untypable there; two
  statements instead); `appendUnlessLatest` would need `SERIALIZABLE` or an advisory lock.
- `0019_local_accounts` enforces no foreign keys: removing a sign-in account deletes its secrets
  itself.
- **Migration 0036 renamed the store in place** (ADR one-word-per-thing-account-service-plugin):
  `accounts`, `account_resources`, `mission_accounts`, `sign_in_accounts`, every `account_id`
  column, and the stored acts, refusal codes and JSON fields of the audit, the session events and
  the decisions of requests. Ids, associated data and the KDF context `vaubaan/connection-key/v1:`
  (`crypto/aead.ts`) never move: change one byte and no stored credential opens. A test that
  seeds an older version writes the old names and stops before 0036; `SEALED_COLUMNS` reads a
  restored copy's accounts table under its pre-0036 name (`pre-rename-backup.test.ts`).
- **Migration 0037 renamed provider in place** (same ADR, rename R2): `accounts.service`,
  `accounts.service_grant`, and `sign_in_provider` on `groups`, `administrators`,
  `sign_in_accounts` and `local_links`. Its rewrite of the audit's JSON goes by the sense of the
  act: an act of sign-in, people or administration says `sign_in_provider`, `config-changed` is
  left as written (an OAuth broker's `providers`), any other says `service…`; the web sessions
  are rewritten too, so nobody is signed out (`pre-service-rename-backup.test.ts`). A test that
  seeds a version before 0037 writes `provider`.
- `issueToken` re-checks membership and mission status inside the insert transaction
  (`TokenNotIssuableError`), because hashing the secret leaves time for a revocation.

## Procedures

### Backup

- Never `cp gateway.sqlite`: in WAL mode, without its `-wal` it loses committed transactions.
  `store.backupTo` uses `VACUUM INTO`; an atomic snapshot of both files is fine.
- `vaubaan-entrypoint node /app/apps/gateway/backup.mjs [<name>]`: **not encrypted**, carries the
  sign-in configuration ([authentication](authentication.md)), opens only with the master-key
  versions it prints (keep them with it). Off Railway: `deploy/railway.md` §6.
- Scheduled (`backup.s3.*`, [configuration](configuration.md#configuration-keys)): each run
  encrypts, dry-runs a restore of the result and uploads nothing if it fails.

### Restore

- `restore.mjs [<source>] --sha256 … [--dry-run] [--force]`, or at first boot `restore.from` +
  `restore.sha256` on an absent or empty store. The source is never printed.
- Verified before replacing: hash, integrity, every recorded migration ships here (older passes,
  newer is refused), every sealed blob opens. What is in the way becomes `<name>.replaced-<time>`.
- It never re-seals (`deploy/railway.md`, "Moving an instance"); with no key file, setup mode
  receives the copy's key first ([configuration](configuration.md)).

## Debug

- **Boot fails naming `store.path`** → missing directory, SQLite < 3.37, or a migration refusal.
- **Restore exits 65 / 75** → a check failed / the store is in use (codes: `restore/cli.ts`).
