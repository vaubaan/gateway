---
title: Audit — Overview, Record, Timeline, mission log view, retention, administrative entries
tracks:
  - apps/gateway/src/server/audit/
  - apps/gateway/src/server/budget/retention.ts
  - apps/gateway/src/server/store/repositories/audit.ts
  - apps/gateway/src/server/store/repositories/mission-logs.ts
  - apps/gateway/src/app/(app)/activity/
  - apps/gateway/src/app/(app)/missions/[id]/session/
  - apps/gateway/tests/integration/audit/admin-mutations.test.ts
  - packages/gateway-core/src/audit.ts
last_reviewed: 2026-11-25
---

# Audit — handbook

How the record is read (Activity's Overview, Record and Timeline, the activity of one mission), purged, and kept complete for administrative acts. Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §4.2 "Activity", §6, §8; entry shapes and the writer: [gateway-core](gateway-core.md); tables and append-only triggers: [store](store.md). This module only reads, and purges.

## Start here

- [`query-service.ts`](../../apps/gateway/src/server/audit/query-service.ts) — `search`, `scopeOf`, `standingOn`, the views: the Record (`/activity/record`).
- [`store/repositories/audit.ts`](../../apps/gateway/src/server/store/repositories/audit.ts) — `scopePredicate`, the one visibility predicate.
- [`overview.ts`](../../apps/gateway/src/server/audit/overview.ts) — the Overview (`/activity`): per mission of the Timeline's scope, calls, waiting requests, bytes, accounts, key holders, use of the period, what expires soon; the page's links and use per action are `app/(app)/activity/overview-model.ts`.
- [`timeline.ts`](../../apps/gateway/src/server/audit/timeline.ts) — the Timeline (`/activity/timeline`): mission log events of every readable mission, through `MissionLogsRepo.searchEvents`; its words are `missions/[id]/session/event-words.ts`.
- [`paging.ts`](../../apps/gateway/src/server/audit/paging.ts) — the pages of both tabs: `?cursor=` (older), `?after=` (newer), `?at=` (first line's number).
- [`mission-log-view.ts`](../../apps/gateway/src/server/audit/mission-log-view.ts) — the activity of one mission, its mission log (`/missions/<id>/session`, a route that keeps its name): what waits, who called, usage, periods, and its latest events for the mission page.
- [`retention.ts`](../../apps/gateway/src/server/audit/retention.ts) — the sweeper, the audit's only delete path.
- [`admin-mutations.test.ts`](../../apps/gateway/tests/integration/audit/admin-mutations.test.ts) — the guard that every mutation writes an entry.

## Invariants

- **Scope first, in SQL.** `AuditRepo.search` applies the viewer's scope, then the filters, then the keyset, so a filter only narrows. `scopePredicate` is plain `IN` subqueries (portable to Postgres); a dimension the scope lacks is an always-false piece.
- **A filter never widens nor reveals.** An unreadable value is dropped and listed in `problems`; an unknown email matches nothing, like a known user with no entry.
- **Arguments are never readable.** An entry holds only their fingerprint, an unsalted SHA-256 guessable for low-entropy values (threat model, A9), so `standingOn` shows it only to who answers for the call; `withoutArguments` also masks fingerprints and `args`-like keys at any depth of `before`/`after` (defence in depth).
- **A page of Activity is its address.** Pages of 50, keyset `(ts, id)`: `cursor` reads older than a line, `after` reads newer (the store reads ascending, `pageOf` turns it back), so concurrent writes do not shift a page; `at` only numbers the lines ("Lines 51–100") and never decides what is shown. Every page is a server render of one search, authorized like the first. No endpoint or server action returns rows. The filters (`FilterForm`) build the address and follow it; their fields are uncontrolled, so they are re-set from the address when it changes another way (a period, Clear, Back); the box of rows is keyed by its page so a new page starts at its top.
- **The Timeline is scoped like the Record, narrower.** `searchEvents` applies the scope in SQL before filters and keyset: missions the viewer created, current memberships, everything for an operator; nothing for the bootstrap token. An account owner is not in it: a mission log mixes every account of its mission (spec §4.2 "Accounts": only the account's part), so owners read their calls in the Record. A holder filter takes the Record's typed forms (`holdersOf`).
- **Every public service method is classified.** `admin-mutations.test.ts` parses the classes under `server/{accounts,missions,auth,requests,telemetry,instance,authority,shares,groups,users,vaubaan}`; each method is a read, a mutation (driver + expected entry) or an exemption with a reason. A new method fails until classified.
- **A new object type does not compile until labelled**: `objectLabel` is a `switch` over `AdminObjectType` with no `default`. A share is labelled through the account its entry names (`account_id` in `before`/`after`): the store reads a share only with its account.
- **A change reads in words from the keys it holds**, not per act (`changeLines`): an unknown key is printed under its own name, never dropped.
- **The server holds no sentence** for the mission log timeline: typed `MissionLogEventView` fields only (`parseEventDetails`), worded by `eventWords`; a kind from a later version prints as stored.
- **The Overview sums in SQL, once for every mission.** `AuditRepo.callTotals` is one `GROUP BY mission_id, account_id, token_kind, token_holder` over the call entries of the Timeline's scope since the span's start (`missionScopePiece`, the same `IN` subqueries as `searchEvents`), read from the covering partial index `audit_calls_overview` (0038); `totalsByMission` folds it per mission, account and holder. Missions (`listInScope`: running, or called in the span) and waiting requests (`countOpenInScope`) are one statement each. Per mission it reads only what the mission page reads: the record and `MissionService.standing` (derived status and the budget's `stateOf`). Checked with `EXPLAIN` on 100k entries: index-only for a person and for an operator, tens of milliseconds.
- **Bytes are the meter's, on the entry** (`request_bytes`, `response_bytes`, migration 0038, [gateway-core](gateway-core.md)): only forwarded calls carry them; the Overview sums what is known (`COALESCE(SUM(…), 0)`) and older entries add nothing.
- **Usage comes from counters, not the audit.** `consumed` / `remaining` read `mission_log_counters`; a granted claim lowers a counter, so "counted" can go down.
- **The History of a mission is not the audit.** `mission_versions` (spec §4.2 "History") is never swept: it stays as long as the mission ([missions](missions.md), [store](store.md)).
- **The mission log history leaves with the audit.** One `retention_days` for both; per mission log, in one transaction, events of `PERIOD_STATE_EVENT_KINDS` written since the current period started and the current period's counters are kept, whatever their age.

## Traps

- **Orphaned and lost are acts, not state.** Services write `mission-orphaned` / `mission-restored` around the acts that change an authority, through `appendUnlessLatest` (two concurrent acts write one entry). The execution door detects such changes on its own and writes no administrative entry, so a mission's two entries need not come in pairs.
- **Token holders are never crossed.** The `holder` filter takes `member:<id>` / `named:<name>`; an email names a member (token names cannot contain `@`); a token named like a user id is not that member.
- **An Overview figure links with `from` = the span's start** (`recordHref`), so the Record shows the same lines; "today" starts at midnight UTC. `/activity` with any query but `period` is an older Record address and redirects there, query kept.
- **"Expires soon" (`EXPIRING_SOON_DAYS` = 7)** reads a mission's `expiresAt` and, for an account, `expired` or a pasted key's `credentialExpiresAt` (`accountCredentialKind` = `api-key`): an OAuth access token's expiry is refreshed by the gateway and never listed. The fix link is the account page for its owner, Edit mission for the creator; anyone else gets the mission.
- **Timeline label and holder filters** read columns the mission logs repository copies at insert (`agent_label`, `token_kind`, `token_holder`); the view still reads label and holder from the details. The indexes lead with `mission_log_id`: across mission logs (no mission filter) the Timeline sorts the scoped events, fine at a self-hosted volume under the retention; an `events (ts, id)` index is the fix if it is not.
- **A waiting request on the Timeline** is linked (`/waiting/<id>`) for the mission's creator only; anyone else reads whose answer it waits for (`open_requests[].creator`).
- **A resource edit and a discovery name the account as object**, so the account filter and owner visibility need no join; a request decision names the request, resolved to its mission at search.
- **Joins and leaves of future resources name the mission as object** (`mission-resource-joined`, `mission-resource-left`, `after.account_id`), so the mission's creator and members read them; their actor is the human whose act caused them, or `discovery` (`DISCOVERY_ACTOR_ID`, labelled "The gateway’s discovery") for the automatic refresh (hourly or on open; its own `resources-discovered` entries only when it changed something) and the discovery after a creating call — a pseudo-actor like `schedule` and `bootstrap`, never a user row.
- **A migration writes entries too**: actor `migration` (`MIGRATION_ACTOR_ID`, labelled "A gateway upgrade"), a pseudo-actor like `discovery`, written by SQL at boot. Migration 0040 writes one `account-revoked` per duplicate Vaubaan account it revokes (`after.cause` `duplicate-host-account`, `kept_account_id`, `mission_ids`; [services/vaubaan](services/vaubaan.md)). Its id is a UUIDv7 built in SQL.
- **`countersAgreeWithAudit` on a one-off mission older than the retention** reports a mismatch that is the retention, not a fault.
- **The retention timer is single-process**: one sweep awaited at boot before serving, then hourly; a hosted deployment runs `sweep()` from one job. The two purges fail apart and are retried next interval.
- **The audit purge goes by batches** (`AUDIT_PURGE_BATCH`, 5 000 entries per transaction, the event loop let go between two): every allowed call appends its entry under the same write lock, so a first purge of months of entries does not hold the calls back. The unused accepted-risk sets go with the last batch, the one below the size (an empty one after an exact multiple).

## Debug

- **Entry missing** → scope before filters: is the viewer the creator, a current member, an owner (or through a group) of the account, or an operator? For an administrative entry, does its object resolve to the viewer?
- **Old entry still there** → `retention_days` in the boot config, `audit retention:` log lines.
- **A new method breaks `admin-mutations.test.ts`** → classify it in `RULES`; if it changes state for a user, write the entry and add its driver.
- **Call missing from its label's timeline** → `SELECT kind, agent_label, details_json FROM events WHERE id = ?`; a `NULL` column with a label in the details was written outside the mission logs repository.
- **"Ask me first" yet calls pass** → `gate_open_until`: the gate is open for the period; a later `gate-changed` ends it.
- **Usage disagrees with the record** → `countersAgreeWithAudit` ([budget-and-mission-logs](budget-and-mission-logs.md)).
