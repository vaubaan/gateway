---
title: Store — embedded SQLite, schema and migrations, repositories
status: current
date: 2026-10-13
last_synced: 2026-10-13
tracks:
  - apps/gateway/migrations/
  - apps/gateway/src/server/store/
  - apps/gateway/tests/unit/server/store/
  - apps/gateway/tests/integration/store/
  - apps/gateway/src/server/compose/store.ts
  - apps/gateway/src/server/compose/registry.ts
  - apps/gateway/src/server/compose/testing.ts
  - apps/gateway/src/server/compose/shipped-plugins.ts
  - apps/gateway/src/server/compose/ports.ts
  - apps/gateway/tests/integration/compose/boot.test.ts
---

# Store — embedded SQLite, schema and migrations, repositories

The store is the gateway's only persistence: one SQLite file on the mounted volume,
opened by the process, migrated at boot, accessed through repository interfaces.
Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §2 (domain), §3 (budget,
requests, approvals), §6 (encryption at rest, immutable audit), §8 (audit). Decisions:
[embedded-store-sqlite-and-migrations](../decisions/embedded-store-sqlite-and-migrations.md).

## Layout

```
apps/gateway/migrations/
  0001_schema.sql                 schema v1 (27 tables + schema_migrations from the runner, 4 triggers)
  0002_audit_risks_purge_guard.sql audit_risks delete guard compares with the purge cutoff (schema version 2)
  0003_web_sessions.sql           web_sessions: the human web-session rows (schema version 3, P1.1)
  0004_connection_resource_curation.sql  connection_resources: metadata, owner metadata, env source,
                                  renamed / hidden / stale flags (schema version 4, P1.4)
  0005_approval_bound_to_tool.sql approvals: the tool joins the key and the lookup index
                                  (schema version 5, P2.1)
  0006_oauth_client_decisions.sql oauth_clients / delegations: registration, decision, revoke reason
                                  (schema version 6, P2.3)
  0007_orphaned_not_stored.sql    missions: stored `orphaned` rows reset to `active`, two triggers
                                  refuse the value (schema version 7, P2.2b)
  0008_events_agent_label.sql     events: the agent label of a call event as a column, backfilled,
                                  and the index of the per-label timeline (schema version 8)
apps/gateway/src/server/store/
  index.ts                        openStore() / openMemoryStore(), Store type, re-exports
  db.ts                           openDb() — better-sqlite3 handle, pragmas, MIN_SQLITE_VERSION,
                                  withImmediateTransaction, backupTo, journalMode
  migrate.ts                      loadMigrations(), runMigrations(), schema_migrations bootstrap
                                  (ensureMigrationsTable, listApplied), checksumOf, DEFAULT_MIGRATIONS_DIR
  ids.ts                          newId() — UUIDv7 as text
  clock.ts                        Clock, systemClock, ManualClock (tests)
  encryptor.ts                    re-exports the crypto module's Encryptor port + sealText/openText helpers
  catalog-index.ts                CatalogIndex interface, SetCatalogIndex, assertKnownRiskIds
  audit-writer.ts                 SqliteAuditWriter implementing @vaubaan/gateway-core's AuditWriter
  errors.ts                       StoreError, NotFoundError, UnknownRiskIdError, InvariantError, MigrationError
  types.ts                        record types (UserRecord, MissionRecord, …)
  testing.ts                      StubEncryptor, TEST_RISK_IDS, openTestStore(), and four fixtures that
                                  reach a state the way production does (grantApprovalRequest,
                                  refuseRequest, issueFirstRefreshToken, makeUnowned) — tests only
  repositories/
    context.ts                    RepoContext (db, clock, newId, encryptor, catalog) + row helpers
    enums.ts                      the closed sets of the shared and gateway-core unions, as lists for parseEnum
    users.ts groups.ts connections.ts shares.ts missions.ts sessions.ts
    requests.ts approvals.ts delegations.ts audit.ts config.ts web-sessions.ts
```

## Opening the store

The composition root does it at boot: `openEmbeddedStore(ctx)` in
`apps/gateway/src/server/compose/store.ts` wraps `openStore()` and is injected
through `RootDeps.openStore` (handbook [configuration](configuration.md)); a
failure becomes a boot error naming `store.path` and its variable, a success
logs `store opened` with `kind`, `path` and `schema_version`. Root tests swap in
`openMemoryStore` through `memoryStoreDeps` (`compose/testing.ts`).
Illustrative call:

```ts
import { openStore } from '../store';

const store = openStore({
  path: config.store.path, // InstanceConfig.store.path, or MEMORY_PATH
  encryptor, // the crypto module's Encryptor built by the composition root
  catalog: new RegistryCatalogIndex(registry), // one source of truth: the plugin registry
});
// store.users, store.groups, store.connections, store.shares, store.missions,
// store.sessions, store.requests, store.approvals, store.delegations, store.audit,
// store.config, store.webSessions, store.auditWriter, store.schemaVersion, store.backupTo(),
// store.kind ('sqlite' | 'memory'), store.ping(), store.close()  <- compose/ports.ts StoreLiveness port
// store.db: raw handle — structural tests and diagnostics only; no production
//           code prepares a statement on it outside this module
```

`RegistryCatalogIndex` (`compose/registry.ts`) answers `has(riskId)` from
the registry's catalogs: a base id exists when its provider is registered
and the catalog has the entry; an env-qualified id (`acme[prod].thing-write`)
exists when the entry is env-scoped and lists that environment in
`acceptable_in_envs`. The registry holds the plugins the image ships
(`compose/shipped-plugins.ts`); a risk id of a provider it does not hold is
refused (`UnknownRiskIdError`). `SetCatalogIndex` remains for tests. `root.store` is this object;
`GET /healthz` pings it and reports `kind`.

`openStore()`:

1. opens the file (created if absent; the directory must exist, a missing one
   fails the boot naming `store.path`) with `busy_timeout` 5 s
   (`DEFAULT_BUSY_TIMEOUT_MS`) and refuses SQLite older than 3.37 (no `STRICT`;
   `isSqliteVersionAtLeast`);
2. sets `journal_mode = WAL` (file databases), `synchronous = NORMAL`,
   `foreign_keys = ON`, `temp_store = MEMORY`;
3. creates `schema_migrations` if needed, then applies every
   `migrations/NNNN_name.sql` not yet recorded, each in one `BEGIN IMMEDIATE`
   transaction, recording name and SHA-256 checksum. An applied file whose checksum
   changed aborts the boot (`MigrationError`): applied migrations are immutable, fixes
   are new files. A database that records a migration the image does not ship (an
   older image on a newer volume) aborts the boot too, naming it (downgrade
   protection). A refused boot closes the handle before rethrowing;
4. builds the repositories over one `RepoContext`.

`openMemoryStore()` does the same on `:memory:` — this is what every test uses
(`openTestStore()` in `testing.ts` adds a `ManualClock`, a `StubEncryptor` and a
five-id catalog).

## Conventions every repository follows

- **Closed sets** (`ConnectionStatus`, `ShareStatus`, `MissionStatus`, `Gate`, `Principal`,
  `RequestKind`, `RequestState` = `RequestStatus`, `Iso` = `Iso8601`) are
  `@vaubaan/shared`'s types re-exported by `types.ts`. The sets that exist only in the
  store (`UserStatus`, `MissionTokenStatus`, which keeps `rotated` apart from `revoked`,
  `ResourceScope`, `DelegationStatus`, `DelegationRevokeReason`, `CodeChallengeMethod`,
  `ResourceEnvSource`, `ClientRegistration`, `TokenEndpointAuthMethod`, `ClientOperatorDecision`) are
  `as const` lists in `types.ts` from which the union is derived. Records are camelCase
  persistence records that stay inside `server/**`: each service builds its own view from
  them, and only missions and counters are translated to the shared snake_case shapes
  (`server/budget/mapping.ts`).
- **No enum column is cast.** Every row mapper reads a closed-set column through
  `parseEnum(list, value, 'table.column')`; a value outside the list throws
  `InvariantError` (`table.column: unexpected value '…'`), so a row the code does not
  understand stops the read instead of flowing into a decision. This covers
  `users.status`, `connections.status`, `connection_resources.env_source`,
  `shares.status`, `missions.status`, `mission_connections.resource_scope`,
  `mission_policy.gate`, `mission_tokens.status`, `requests.kind` / `state`,
  `delegations.status` / `revoke_reason` (no schema `CHECK` either: the list is its only guard),
  `oauth_clients.registration` / `token_endpoint_auth_method` / `operator_decision`,
  `oauth_codes.code_challenge_method` and `audit.kind` / `decision` /
  `act` / `object_type` (the last two have no schema `CHECK`: the list is their only
  guard) and `groups.source`: no enum column is cast any more. The lists of the unions defined outside the store are in
  `repositories/enums.ts`, written from the union through `membersOf`, which fails to
  compile when a member is added to or removed from the union; they are meant to move
  next to their types in `@vaubaan/shared` and `@vaubaan/gateway-core`.
- **One mapper per table.** Each row type has one `…ToRecord` function, used by every
  statement that reads the table; only single-column projections and aggregates are
  read in place.
- **Helpers** in `repositories/context.ts`: `requireRow` (a row just written must exist),
  `requireColumn` (a NOT NULL column of the row kind), `parseEnum` (above), `parseJson`
  returns `unknown` and `parseJsonObject` checks the shape; `openSealedColumn` (`encryptor.ts`) is the one null rule for encrypted
  column pairs. Prepared statements that share a name with a repository method carry the
  `Stmt` suffix. Check-then-act writes (the decision of a request, `shares.revoke`) are one
  conditional `UPDATE` whose `changes` decides, and `transferOwner` / `replacePolicy` /
  `issueToken` run inside the transaction, so they stay atomic on an asynchronous driver.
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
  owning row's identifier as associated data (the connection id, `request:<id>`,
  `instance_config:<key>`) and stamped with `key_version`. The port is async and
  transactions are sync, so a repository seals before `BEGIN IMMEDIATE` and opens
  after `COMMIT`. Records never expose the ciphertext; `getCredential()`,
  `getArguments()`, `getSecret()` open it on demand and return clear text.
- **Errors**: `NotFoundError` for a missing row named by id, `InvariantError` for a
  domain rule (duplicate policy risk, revoked share revoked again, selected scope
  with no resource…), driver errors (`SqliteError` with `code`) for constraint
  violations the schema catches (`UNIQUE`, `FOREIGN KEY`, `CHECK`).

## Schema (`0001_schema.sql` … `0008_events_agent_label.sql`)

Schema version 8. `0001` creates every table and trigger; `0002` only replaces the
`audit_risks` delete trigger (see Audit); `0003` adds `web_sessions`; `0004` adds the
owner-curation columns of `connection_resources` (plain `ADD COLUMN`s); `0005` adds
`approvals.tool` (`NOT NULL DEFAULT ''`: a row written before it matches no call) and
recreates `approvals_lookup` on `(mission_id, risk_id, tool, fingerprint)`; `0006` adds to
`oauth_clients` how the client registered, its token-endpoint authentication method and the
operator's decision, and to `delegations` the reason it ended (`revoke_reason`), plus the
index `delegations_client`; `0007` takes `orphaned` out of what `missions.status` may
hold (see "Missions: `orphaned` is not stored" below); `0008` adds `events.agent_label`,
the label a call event carried (`NULL` for a call without one and for every other kind of
event), backfills it from the stored details of the call events an earlier image wrote, and
creates the index `events_session_label_ts` on `(session_id, agent_label, ts, id)` (see
"The timeline of one agent label" below).

| Area        | Tables                                                                                                                     | Notes                                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instance    | `instance_config`, `schema_migrations`                                                                                     | key → clear `value` **or** `secret_blob`+`key_version`, never both                                                                                                                                                                                                                                                                                                            |
| Web session | `web_sessions`                                                                                                             | `id` = SHA-256 (hex) of the session key — the cookie value is a bearer and is never stored; `value_json`, `expires_at`; repository `store.webSessions` (`repositories/web-sessions.ts`), which is the composition root's `SessionStore` port (handbook [authentication](authentication.md)); expired rows swept on write                                                      |
| Identities  | `users`, `groups`, `group_members`                                                                                         | `users.subject` unique (IdP), `status active\|removed`; `groups.source idp\|local`                                                                                                                                                                                                                                                                                            |
| Delegations | `oauth_clients`, `oauth_client_redirect_uris`, `delegations`, `oauth_codes`, `oauth_refresh_tokens`, `oauth_access_tokens` | all secrets stored as hashes by the caller; codes single-use; refresh tokens chain through `replaced_by_id`; `oauth_clients.operator_decision` (`approved`\|`disabled`, NULL while the registration policy decides), `registration` (`dynamic`\|`metadata-document`); `delegations.revoke_reason`; repository and its replay lookups in [management-door](management-door.md) |
| Connections | `connections`, `connection_resources`                                                                                      | owner = `owner_kind` + `owner_user_id`/`owner_group_id` with a CHECK; status `active\|expired\|revoked\|unowned`; resources unique per `(connection_id, ref)` with an `env` label, its `env_source` (`owner`\|`plugin`), `metadata_json` (provider facts) and `owner_metadata_json` (owner edits), `display_name_edited`, `hidden`, `stale_since` (see Connections below)     |
| Shares      | `shares`, `share_restrictions`                                                                                             | target principal like owner; one `risk_id` row per restriction entry                                                                                                                                                                                                                                                                                                          |
| Missions    | `missions`, `mission_connections`, `mission_resources`, `mission_policy`, `mission_tokens`                                 | status `active\|expired\|revoked` (`orphaned` is derived, `0007` refuses it; `exhausted` is per risk, computed); `period_anchor` + nullable `period_seconds`; `resource_scope all\|selected`; policy row = `(quota, rate_limit, rate_window_seconds, gate)`; partial unique index = one `active` token per mission                                                            |
| Sessions    | `sessions`, `session_counters`, `events`                                                                                   | one session per mission (`mission_id` unique); counters keyed `(session_id, risk_id, period_start)`; events are free-form `kind` + JSON details; `events.agent_label` (`0008`) is a copy of the label of a call event, made at insert, for the per-label timeline                                                                                                             |
| Requests    | `requests`, `approvals`                                                                                                    | `kind claim\|approval`, `state open\|granted\|refused\|expired`; approval requests carry `tool`, `fingerprint`, encrypted `args_blob` (NULL on decision and on expiry); one approval per request, keyed `(mission, risk, tool, fingerprint)`, consumed via `consumed_at`                                                                                                      |
| Audit       | `audit`, `audit_risks`, `audit_purge_guard`                                                                                | see below                                                                                                                                                                                                                                                                                                                                                                     |

SQLite-only constructs are marked `-- sqlite:` in the file (`STRICT`, `RAISE(ABORT)`);
the ADR lists the Postgres replacement for each. Three more are SQLite-only and carry no
mark, because an applied migration is immutable (its checksum is recorded): the `BLOB`
column type (`BYTEA` on Postgres), the trigger body written inline (`CREATE TRIGGER … BEGIN
… END`, a trigger function on Postgres) and `DROP TRIGGER` without `ON <table>` in `0002`.
A Postgres port writes its own schema files for these.

The repositories' SQL itself is portable: positional `?` parameters, `ON CONFLICT … DO
UPDATE` / `DO NOTHING`, plain subqueries and `IN` lists, no SQLite function, no parameter
whose only use is a comparison with `NULL` (Postgres cannot type it; the open-request
lookup is two statements for that reason). What a port has to replace besides `db.ts` is
the driver surface the repositories call directly: the synchronous `prepare().get / all /
run` statements and their `changes` count, `?` placeholders (`$n` for node-postgres), and
the synchronous callbacks of `decideAndDecrement` and `decideClaim`, which rely on a
transaction that never yields.

## Connections and resources

Beyond the P0.3 primitives (`create`, `getById`, `list`, `listOwnedBy`,
`getCredential`, `transferOwner`, `setMetadata`,
`listResources`, `getResource`, `setResourceEnv`), the repository
carries the operations the connect flows need (P1.4, handbook
[connections](connections.md)). All are additive; the state changes are single
conditional `UPDATE`s whose `changes` is the answer:

| Method                                          | Effect                                                                                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `reconnect(id, credential, expiresAt?)`         | new sealed credential, status `active` — only from `active` or `expired` (`RECONNECTABLE_STATUSES`); `false` when `revoked` or `unowned` |
| `refreshCredential(id, credential, expiresAt?)` | new sealed credential, status untouched — only while the connection serves calls (`active` or `unowned`); `false` otherwise              |
| `markExpired(id)`                               | a serving connection (`active` or `unowned`) → `expired`; `false` otherwise                                                              |
| `revoke(id)`                                    | `revoked`, `revoked_at` kept if already set, `credential_blob` / `key_version` / `credential_expires_at` set NULL                        |
| `syncDiscoveredResources(connectionId, list)`   | the discovery merge: provider facts refreshed, owner fields kept, missing refs marked `stale_since`, nothing deleted                     |
| `setResourceDisplayName(id, name \| null)`      | owner rename (`display_name_edited = 1`); `null` hands the name back to discovery                                                        |
| `setResourceHidden(id, hidden)`                 | owner flag                                                                                                                               |
| `setResourceOwnerMetadata(id, object \| null)`  | owner edits overlaid on the discovered metadata                                                                                          |

`setResourceEnv` also sets `env_source = 'owner'`. `ConnectionResourceRecord` exposes
`envSource`, `metadata` (the effective merge `{ ...discovered, ...owner }`),
`ownerMetadata`, `displayNameEdited`, `hidden`, `staleSince`; `listResources` returns
every row, hidden and stale included. `replaceResources`, the P0.3 sync that deleted the
refs it was not given (cascading to `mission_resources`), was removed once its last
callers (test fixtures) moved to `syncDiscoveredResources`. The P0.3 writers that set a
credential, a status or an owner without a condition, which no production code called,
were removed the same way: every writer left names its transition and carries its
condition in the statement.

Ownership and the stored state that follows from authority (P2.2, handbook
[authority](authority.md)), all additive, covered by
`tests/integration/store/ownership-and-orphans.test.ts`:

| Method                                     | What                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connections.markOwnerlessUnowned()`       | `active` → `unowned` for every connection whose owner group has no member; returns the ones changed                                                                                                                                                                                                                                                                                                                                            |
| `connections.listOwnerless()`              | `unowned`, or not revoked with an empty owner group                                                                                                                                                                                                                                                                                                                                                                                            |
| `connections.assignOwnerlessTo(id, owner)` | the connection must be ownerless and a new owner group must have a member, checked in the write transaction; then new owner, `unowned` → `active` (an `expired` one stays `expired`). Answers `{ outcome: 'assigned', previous, connection }` — `previous` is the row read inside the transaction, what the audit entry records as `before` — or `not-ownerless` / `owner-group-empty` with nothing written; `NotFoundError` for an unknown id |
| `connections.markExpired(id)`              | now from any serving status (`active` or `unowned`)                                                                                                                                                                                                                                                                                                                                                                                            |
| `shares.replaceForTarget(input)`           | revokes the active share of the same `(connection, target)` and creates the new one, one transaction                                                                                                                                                                                                                                                                                                                                           |
| `shares.listActiveForTargets(p, connId?)`  | optional connection filter; the statement is compiled once per SQL shape (the door asks it per call)                                                                                                                                                                                                                                                                                                                                           |
| `groups.createLocal(name)`                 | a `local` group, or `null` when any group holds the name                                                                                                                                                                                                                                                                                                                                                                                       |
| `groups.addMember(groupId, userId)`        | idempotent; `true` only when the membership was added, so the caller writes `group-member-added` for an actual addition and nothing for a repeat                                                                                                                                                                                                                                                                                               |

No migration for these: the tables and the status values exist since `0001_schema.sql`.

### Missions: `orphaned` is not stored

Spec §2.3: a mission is `orphaned` while its creator's current authority does not
ground it, "never stored as a verdict". The store holds `active` for such a mission;
every reader derives the state (`MissionGrounds.inspect`, handbook
[authority](authority.md)). Three things keep the value out of the table:

- `MissionsRepo.setStatus(id, status)` takes a `StoredMissionStatus`
  (`Exclude<MissionStatus, 'orphaned'>`), and there is no `markOrphaned`;
- a row is parsed with `STORED_MISSION_STATUSES` (`active`, `expired`, `revoked`): a
  row that carried `orphaned` would be an `InvariantError` at the read, not a silent verdict;
- migration `0007` resets the rows the P2.2 image wrote (`status = 'active'`,
  `closed_at = NULL`; tokens were never retired by an orphaning) and creates
  `missions_orphaned_not_stored_insert` / `_update`, `BEFORE` triggers that abort a
  write of the value. The CHECK of `0001` still lists it: an applied migration is
  immutable, and a table rebuild is not worth one constraint. The trigger bodies are the
  SQLite-only part (a Postgres port writes the same guard as a CHECK).

`MissionRecord.status` keeps the type `MissionStatus`: the same record type carries the
derived value once it went through `inspect`. `closed_at` is set by `revoked` and
`expired` only.

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

`store.audit.appendUnlessLatest(entry, { among, since })` is `append` for a change two
writers may both have observed (`mission-orphaned` / `mission-restored`, handbook
[authority](authority.md)): in one `BEGIN IMMEDIATE` transaction it reads the most recent
administrative entry on the same object whose act is one of `among` and inserts the entry
unless that one carries the same act and was written at or after `since`; it returns the
record, or `null` when the entry was held back. An equal act older than `since` records an
earlier change and holds nothing back. `among` must name the act being written
(`InvariantError` otherwise). The statement is an `IN` list of bound values with a keyset
order, the same on Postgres, where the transaction has to be `SERIALIZABLE` (or hold a
per-object advisory lock) for the read and the insert to stay one step.

Reads: `getById(id)` and `list(filter)` with `AuditFilter { missionId?, kind?,
since?, until?, limit? }` (default limit 1000, ordered by `ts, id`).
`search(query)` is the Audit page's query (P1.8, handbook [audit](audit.md)): a
mandatory `AuditScope` (missions created by one user, connections owned by some
principals, optionally every administrative entry) applied before the filters
(`missionId`, `userIds`, `connectionId`, `tool`, `decision`, `agentLabel`, `kind`,
`since`, `until`),
newest first (`ts DESC, id DESC`), paged by keyset (`before: { ts, id }`, `limit`).
`agentLabels(missionId)` lists the distinct agent labels of a mission's calls with
their count and last timestamp. `agentLabelActivity(missionId, { since, until | null })`
counts a mission's call entries of a span per agent label and per decision, the
unlabelled calls as `label: null`, busiest first. It is two prepared statements, one for a
bounded span (`ts < until`) and one for an open span (`until: null`), each a `GROUP BY` with
`SUM(CASE …)`: no parameter is bound only to be compared with `NULL`, which Postgres cannot
type. It serves the session page's "calls per agent label" and is never a budget.

### The timeline of one agent label

`store.sessions.listRecentEvents(sessionId, { before?, limit, calls? })` is the session
timeline, newest first (`ts DESC, id DESC`), paged by keyset (`before` is the last event of
the previous page). With `calls: { agentLabel }` it returns only the call events
(`CALL_EVENT_KINDS`: `call-allowed`, `call-refused`) that carried that label, and with
`agentLabel: null` the calls that carried none — same order, same keyset, one indexed read
per page (`events_session_label_ts`) however many events of other labels lie in between.
The label is read from the column `events.agent_label`, which `repositories/sessions.ts`
fills at insert with `agentLabelColumn(event)`: the non-empty string in
`details.agent_label` of a call event, `null` otherwise — the rule of the backfill of
migration `0008`. The details stay the source: the column is never returned in an
`EventRecord`. The labelled and the unlabelled reads are separate statements, for the
same Postgres reason as above. `RecentEventsOptions`, `CALL_EVENT_KINDS` and
`agentLabelColumn` are exported by `repositories/sessions.ts`.

Immutability is enforced by triggers: every `UPDATE` on `audit`/`audit_risks` aborts;
a `DELETE` on `audit` or on `audit_risks` aborts unless `audit_purge_guard` holds a
cutoff newer than the entry (migration `0002` made the `audit_risks` trigger look up
its parent entry's `ts`; in `0001` any risk row could go while a window was open).
`store.audit.purgeOlderThan(cutoff)` is the only path that opens the window, inside
its own transaction;
`purgeByRetention(days = DEFAULT_AUDIT_RETENTION_DAYS)` (90, exported) computes the
cutoff from the clock.
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
    // ctx.findApproval({ riskId, tool, fingerprint })    -> ApprovalRecord | null   (non-consuming)
    // ctx.consumeApproval({ riskId, tool, fingerprint }) -> ApprovalRecord | null   (single use)
    // ctx.findOpenRequest({ kind, riskId, tool?, fingerprint? }) -> RequestRecord | null  (reuse on replay)
    // ctx.riskEvents({ kinds, riskIds, since }) -> EventRecord[]   (oldest first; gate openings)
    // ctx.createRequest({ kind, riskId, tool?, fingerprint?, prepared?, expiresAt })
    //   prepared = await store.requests.prepareArguments(args), sealed BEFORE the call
    // ctx.recordEvent({ kind, riskId?, actorUserId?, details? })
    //   stored as given (`UntypedNewEvent`); the gateway's writers build a typed
    //   `NewEvent` and readers use `parseEventDetails` (budget handbook)
    return { allow, event: { kind: allow ? 'call-allowed' : 'call-refused' } };
  },
);
// result.outcome (what decide returned), result.session, result.counters (after)
```

Everything inside runs in one `BEGIN IMMEDIATE` transaction: session get-or-create
("born on the first call"), counter read, the callback, the per-risk increment when
`allow` is true (`riskIds` are deduplicated: one credit per distinct risk per
call), the outcome's event. A thrown callback rolls everything back,
including the session creation. The accounting rules (period arithmetic, quota and
rate comparison, gate) are the `SessionService` callback of
[budget-and-sessions](budget-and-sessions.md); this module only guarantees the
atomicity. `findApproval` / `findOpenRequest` are non-consuming lookups so that callback
can decide on every risk before it consumes an approval or drops a request. Rate-limit
sliding windows are not stored here (in-memory, same handbook).

## The approval decision primitive and what came with it

Additive, for the approval gate (handbook [requests](requests.md), "Approvals"):

- `store.requests.decideApproval(id, decidedByUserId, apply)` — the creator's answer to
  an approval request in one `BEGIN IMMEDIATE` transaction, the sibling of `decideClaim`
  (they share `decideOpenSync`): open and unexpired check (an overdue request is expired
  there), `apply(ctx)` with `createApproval(expiresAt)`, `riskEvents(query)` and
  `recordEvent(event)`, then the conditional update that stores the decision and sets
  `args_blob` / `key_version` to NULL. A thrown `apply` writes nothing.
- `store.requests.getArguments(id)` — `null` unless the request is `open` and unexpired.
- `store.approvals` — `ApprovalKey { riskId, tool, fingerprint }` for `create`
  and the in-transaction lookup and consumption (`DecideContext.findApproval` /
  `consumeApproval`); `getByRequest(requestId)`; an approval with an empty
  tool is never written and never matched.
- `store.missions.issuersOf(missionIds)` — for the missions issued through the
  management door, the delegation and the client behind each (`MissionIssuerRecord`), by a
  join `missions.delegation_id` → `delegations` → `oauth_clients`; a mission issued in the
  interface has no entry. No column was added: the delegation is the one place that names
  the client.
- `store.delegations.rotateSuccessorOf(previousHash, rotatedSince, next)` — the reuse window
  of a refresh rotation: when the named token was rotated at or after `rotatedSince` and its
  successor is still the live head of the family, rotates that head in one transaction and
  returns the new token; `null` otherwise (handbook [management-door](management-door.md)).
- `store.missions.setGate(id, riskId, gate, actorUserId)` — one risk's gate, and the
  `gate-changed` session event in the same transaction when the mission has a session;
  `{ mission, previous }`, or `null` when the risk is not in the policy; the gate the risk
  already has writes nothing.
- `store.audit.latestCall({ missionId, tool, argumentsHash, refusalCode? })` — the most
  recent call entry for a tool and a fingerprint, with its slices and risks.

## The claim decision primitive

`store.requests.decideClaim(id, decidedByUserId, apply)` is the same pattern for the
creator's answer to a claim (P1.7, handbook [requests](requests.md)): one
`BEGIN IMMEDIATE` transaction holding the check that the request is an open, unexpired
claim (an overdue one is flipped to `expired` there and reported `not-open`), the
synchronous `apply(ctx)` callback, and the conditional `UPDATE … WHERE state = 'open'`
that stores the outcome. `ClaimDecisionContext` carries `request`, `session`, `now` and
`mission` — the mission's stored status and expiry (`StoredMissionFacts`), read inside
this transaction, so a rule that depends on them (no reset or extension of a mission
revoked since the page was read, an expiry that never moves backwards on a stale read)
is checked on the row the decision will write next to; `ApprovalDecisionContext` carries
the same `mission`. The claim context offers `counters(periodStart)`,
`resetCounters(periodStart)`, `creditCounter(periodStart, riskId, amount)` (refuses to
take a counter below zero), `setMissionExpiry(iso)` (a mission stored `expired` becomes
`active`, `closed_at` cleared) and `recordEvent(event)`. A thrown callback rolls
everything back.

`sessions`, `session_counters` and `events` have one writer, `repositories/sessions.ts`.
The requests repository does not prepare statements on those tables: its claim context
and its sweeper call `createSessionPrimitives(ctx)` (`sessionOfMission`, `recordEvent`,
`countersOfPeriod`, `resetPeriod`, `creditCounter`), synchronous functions with no
transaction of their own that run inside the caller's `BEGIN IMMEDIATE`. An event is
therefore inserted and mapped by the same code whether it comes from a call decision, a
claim decision or the sweeper, and `recordEvent` always returns the stored row.

`store.requests.sweepExpired()` flips every overdue open request to `expired`, erases
its argument blob and records a `request` event (`state: 'expired'`) on the mission's
session, returning the records.
`store.sessions.listEvents(sessionId, { since?, limit?, kinds?, order? })` filters by
event kind and can return the tail of the timeline first (`order: 'desc'`).

## Delegations, clients, codes and tokens

`store.delegations` (`repositories/delegations.ts`) holds the OAuth clients, the
delegations and the three kinds of secrets issued under them, all as digests computed by
the caller. The rules are in handbook [management-door](management-door.md); what the
store guarantees is that every grant is one transaction:

| Method                                                                                                                             | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registerClient`, `getClient`, `getClientByClientId`, `listClients`, `updateClientDocument`, `decideClient`, `deleteUnusedClients` | the client rows: registration (dynamic, confidential, metadata document), the operator's decision, the clean-up of clients nobody used                                                                                                                                                                                                                                                                                                                                                                                |
| `disableClient(id, decidedBy)`                                                                                                     | the operator's `disabled` decision **and** the revocation of every active delegation of the client with their refresh and access tokens (reason `operator`), in one transaction: a disabled client never keeps a live delegation. Returns `{ client, revoked }`, the delegations this call ended, oldest first                                                                                                                                                                                                        |
| `create`, `getById`, `listForUser`, `listForClient`, `activityOf`                                                                  | the delegation rows and their token activity                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `revoke(id, reason?)`, `revokeIfActive(id, reason)`                                                                                | revoke the consent and every token under it; `revokeIfActive` returns the delegation only to the call that actually revoked it (`null` otherwise), so one caller writes the audit entry                                                                                                                                                                                                                                                                                                                               |
| `createCode(input)`                                                                                                                | the check that the delegation is active and the insert are one transaction: no code under a delegation revoked in between                                                                                                                                                                                                                                                                                                                                                                                             |
| `findCode(codeHash)`, `findRefreshToken(tokenHash)`                                                                                | the row whatever its state, with its delegation — how a replay is recognised                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `redeemCode(codeHash, check, { refresh, access })`                                                                                 | the authorization-code grant as one transaction: the code is spent, the synchronous `check(code, delegation)` judges the request, and the first refresh and access tokens are written. `issued`; `refused` (the code **is spent**, nothing issued: `check` gave a reason, or the delegation is revoked — `REDEEM_DELEGATION_REVOKED`); `replayed` (spent before, nothing changes); `expired`; `unknown`. A write that fails rolls everything back — the code is not spent — and throws: the request can be sent again |
| `rotateRefreshToken(tokenHash, next, access?)`                                                                                     | the presented token must be live; it is revoked and linked to its successor. With `access`, the access token of the renewal is written in the same transaction: a failure of either write leaves the presented token live and nothing issued                                                                                                                                                                                                                                                                          |
| `rotateSuccessorOf(previousHash, rotatedSince, next, access?)`                                                                     | the reuse window of a rotation (below), with the same `access` rule: both rows, or the head is left as it was                                                                                                                                                                                                                                                                                                                                                                                                         |
| `createAccessToken(input)`                                                                                                         | like `createCode`: the active-delegation check and the insert in one transaction                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `findActiveAccessToken(tokenHash)`, `revokeAccessToken(id)`                                                                        | a live access token whose delegation is still active; revocation of one token                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `purgeExpired(expiredBefore)`                                                                                                      | deletes expired codes and tokens; a rotated refresh token is kept as long as its successor lives, so its replay is still recognised                                                                                                                                                                                                                                                                                                                                                                                   |

`TokenToIssue` is a token without its delegation (`{ tokenHash, expiresAt }`); the
transaction takes the delegation from the code or from the rotated token.

## Repository methods at a glance

Every method of the twelve repository interfaces, as declared in `repositories/*.ts`.
Some P0.3 primitives are called by the store suites and the fixtures only (in production a
request or an approval is born inside a decision transaction and a share through
`replaceForTarget`); they are listed all the same: the list is the interface.

| Repository                        | Methods                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users` (`UsersRepo`)             | `upsertFromIdp`, `getById`, `getBySubject`, `findByEmail`, `list`, `markRemoved`                                                                                                                                                                                                                                                                                                                                                             |
| `groups` (`GroupsRepo`)           | `getOrCreate`, `createLocal`, `getById`, `getByName`, `list`, `setMembers`, `syncIdpMemberships`, `addMember`, `removeMember`, `listMembers`, `memberCount`, `groupsOf`                                                                                                                                                                                                                                                                      |
| `connections` (`ConnectionsRepo`) | `create`, `getById`, `list`, `listOwnedBy`, `getCredential`, `transferOwner`, `assignOwnerlessTo`, `markOwnerlessUnowned`, `listOwnerless`, `setMetadata`, `listResources`, `getResource`, `setResourceEnv`, `reconnect`, `refreshCredential`, `markExpired`, `revoke`, `syncDiscoveredResources`, `setResourceDisplayName`, `setResourceHidden`, `setResourceOwnerMetadata`                                                                 |
| `shares` (`SharesRepo`)           | `create`, `getById`, `listForConnection`, `listActiveForTargets`, `replaceForTarget`, `revoke`                                                                                                                                                                                                                                                                                                                                               |
| `missions` (`MissionsRepo`)       | `create`, `getById`, `listForCreator`, `listForConnection`, `issuersOf`, `setStatus`, `setExpiresAt`, `replacePolicy`, `setGate`, `issueToken`, `findTokenByPrefix`, `listTokens`, `revokeTokens`                                                                                                                                                                                                                                            |
| `sessions` (`SessionsRepo`)       | `getByMission`, `getOrCreate`, `decideAndDecrement`, `counters`, `recordEvent`, `listEvents`, `listRecentEvents`                                                                                                                                                                                                                                                                                                                             |
| `requests` (`RequestsRepo`)       | `create`, `prepareArguments`, `getById`, `listOpenForCreator`, `listForMission`, `getArguments`, `decideClaim`, `decideApproval`, `sweepExpired`                                                                                                                                                                                                                                                                                             |
| `approvals` (`ApprovalsRepo`)     | `create`, `getByRequest`, `listActive` (lookup and consumption exist only inside `decideAndDecrement`: `DecideContext.findApproval` / `consumeApproval`)                                                                                                                                                                                                                                                                                     |
| `delegations` (`DelegationsRepo`) | `registerClient`, `getClient`, `getClientByClientId`, `listClients`, `updateClientDocument`, `decideClient`, `disableClient`, `deleteUnusedClients`, `create`, `getById`, `listForUser`, `listForClient`, `revoke`, `revokeIfActive`, `activityOf`, `createCode`, `findCode`, `redeemCode`, `findRefreshToken`, `rotateRefreshToken`, `rotateSuccessorOf`, `createAccessToken`, `findActiveAccessToken`, `revokeAccessToken`, `purgeExpired` |
| `audit` (`AuditRepo`)             | `append`, `appendUnlessLatest`, `getById`, `list`, `search`, `latestCall`, `agentLabels`, `agentLabelActivity`, `countAllowedTouches`, `purgeOlderThan`, `purgeByRetention`                                                                                                                                                                                                                                                                  |
| `config` (`ConfigRepo`)           | `get`, `set`, `getSecret`, `setSecret`, `delete`, `apply`, `keys`                                                                                                                                                                                                                                                                                                                                                                            |
| `webSessions` (`WebSessionsRepo`) | `get`, `set`, `delete`, `count`                                                                                                                                                                                                                                                                                                                                                                                                              |

`MissionsRepo.setStatus` is the mission's (it takes a `StoredMissionStatus`, see above);
no other repository has a method that sets a status it is given. A request is decided
through `decideClaim` or `decideApproval` only, and expires through `sweepExpired` (or
inside a decision that finds it overdue); a session's counters are reset through
`ClaimDecisionContext.resetCounters` only, inside the decision of the claim that grants
the reset.

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
  failing file, downgrade refused (a recorded migration with no file), the eight shipped
  files.
- `tests/unit/server/store/db.test.ts` — `isSqliteVersionAtLeast`.
- `tests/integration/store/schema.test.ts` — all 29 tables, every table `STRICT`,
  the composition `StoreLiveness` port (`kind`, `ping`, `close`), boot against an empty file
  (WAL, foreign keys, `NORMAL`), reopen without re-migrating, two writers on one file
  serialize (`SQLITE_BUSY` then success), `VACUUM INTO` backup.
- `tests/integration/store/audit.test.ts` — gateway-core call and admin entries
  round-trip, `agentLabelActivity` and the search by agent label, `UPDATE`/`DELETE` abort (entries and, since `0002`, their risk rows
  inside an open window), purge path and its boundaries, retention default, filters,
  allowed-touch count, schema `CHECK`s, writer contract.
- `tests/integration/store/{identities,connections-shares,missions,sessions,requests-approvals,delegations,config,web-sessions}.test.ts`
  — one suite per repository on `:memory:` (`web-sessions`: the row key is the
  digest and never the id, a clear-keyed row is not read, TTL and sweep,
  an unreadable value is removed), including the catalog check and the
  schema-level wildcard `CHECK`, the N=50 concurrent `decideAndDecrement` on quota 1
  (exactly one allow), two connections on one file (`SQLITE_BUSY` while the other
  transaction is open, then success), an unknown mission as `NotFoundError`,
  in-transaction approval consumption and request drop, the
  counters-vs-audit structural check, argument erasure on decision and expiry,
  the `listEvents` kind filter and descending order. `decideClaim` and
  `sweepExpired` are exercised by `tests/integration/requests/request-service.test.ts`
  (handbook [requests](requests.md)).
- `tests/integration/store/approval-decisions.test.ts` (16) — migration 0005 (column and
  index), `decideApproval` (decision, erasure and approval in one transaction; a thrown
  apply writes nothing; already decided; overdue; a claim; unknown), `getArguments` on an
  overdue request, the open request of a call by tool and fingerprint, `riskEvents`,
  `setGate`, `latestCall`. `search`, `agentLabels` and `listRecentEvents`
  are exercised by `tests/integration/audit/{audit-query,mission-session,events-agent-label}.test.ts`
  (handbook [audit](audit.md)).
- `tests/integration/store/audit-guarded-append.test.ts` (10) — `appendUnlessLatest`: writes
  when the object has no earlier entry of the guarded acts; holds back the same act
  recorded since the guard instant, that instant included (two writers, one entry); writes
  the other act, and the same act again once the other came between; an equal entry older
  than the guard instant holds nothing back; compared per object and within the guarded
  acts only; a guard that does not name the act being written is refused.
  `agentLabelActivity`: a bounded span counts `[since, until)`, an open span has no upper
  bound, and neither statement binds a parameter that is only compared with `NULL`.
- `tests/integration/store/delegations.test.ts` (20) — clients, consent listing, the rotation
  chain, `rotateSuccessorOf` (the reuse window), `issuersOf`; `redeemCode` (the code spent
  and the first pair written once; a refused check spends the code and writes no token; a
  revoked delegation; an unknown or expired code; a failing token write rolls the whole
  grant back); a rotation with an access token writes both rows or neither;
  `disableClient` (the decision and the revocations, and nothing at all when interrupted
  half-way).
- `tests/integration/store/oauth-clients.test.ts` (16) — migration 0006: client registration
  (dynamic, confidential, metadata document), `updateClientDocument`, `decideClient`,
  `deleteUnusedClients`, `listForClient`, the revoke reason and `revokeIfActive`, `activityOf`,
  `findCode` / `findRefreshToken` after consumption and rotation, `purgeExpired` (a rotated token
  is kept while its successor lives), and the audit scope of a user's own delegations
  (handbook [management-door](management-door.md)).
- `tests/integration/store/ownership-and-orphans.test.ts` (13) — the ownership methods of
  the table above and migration 0007 (handbook [authority](authority.md));
  `ConnectionsRepo.assignOwnerlessTo` under a concurrent membership change is in
  `tests/integration/connections/reassign-and-settle.test.ts` (handbook
  [connections](connections.md)).
- `tests/integration/audit/events-agent-label.test.ts` (3) — migration 0008: the backfill of
  the events an earlier image stored (call events only), the copy made at insert follows
  the same rule, and the calls of one label, or the unlabelled ones, read newest first by
  keyset.
- `tests/integration/store/corrupt-rows.test.ts` — a value outside the closed set of an
  enum column (forced in with the `CHECK`s off, or inserted for the unchecked `audit.act`
  / `audit.object_type`) makes the read throw `InvariantError` naming the column, for
  every repository; a corrupt request aborts `decideClaim` before the callback runs.
- `tests/integration/compose/boot.test.ts` (handbook [configuration](configuration.md)) — the
  composition root opening this store on a temporary file with the real encryptor
  and the registry-backed catalog index.
