---
title: Audit — search, mission session view, retention, administrative entries
tracks:
  - apps/gateway/src/server/audit/
  - apps/gateway/src/server/budget/retention.ts
  - apps/gateway/src/server/store/repositories/audit.ts
  - apps/gateway/src/server/store/repositories/sessions.ts
  - apps/gateway/src/app/(app)/activity/
  - apps/gateway/src/app/(app)/missions/[id]/session/
  - apps/gateway/tests/integration/audit/admin-mutations.test.ts
  - packages/gateway-core/src/audit.ts
last_reviewed: 2026-10-27
---

# Audit — handbook

How the record is read (Activity, the activity of one mission), purged, and kept complete for administrative acts. Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §4.2 "Activity", §6, §8; entry shapes and the writer: [gateway-core](gateway-core.md); tables and append-only triggers: [store](store.md). This module only reads, and purges.

## Start here

- [`query-service.ts`](../../apps/gateway/src/server/audit/query-service.ts) — `search`, `scopeOf`, `standingOn`, the views.
- [`store/repositories/audit.ts`](../../apps/gateway/src/server/store/repositories/audit.ts) — `scopePredicate`, the one visibility predicate.
- [`session-view.ts`](../../apps/gateway/src/server/audit/session-view.ts) — the activity of one mission; its words live in the page's `event-words.ts`.
- [`retention.ts`](../../apps/gateway/src/server/audit/retention.ts) — the sweeper, the audit's only delete path.
- [`admin-mutations.test.ts`](../../apps/gateway/tests/integration/audit/admin-mutations.test.ts) — the guard that every mutation writes an entry.

## Invariants

- **Scope first, in SQL.** `AuditRepo.search` applies the viewer's scope, then the filters, then the keyset, so a filter only narrows. `scopePredicate` is plain `IN` subqueries (portable to Postgres); a dimension the scope lacks is an always-false piece.
- **A filter never widens nor reveals.** An unreadable value is dropped and listed in `problems`; an unknown email matches nothing, like a known user with no entry.
- **Arguments are never readable.** An entry holds only their fingerprint, an unsalted SHA-256 guessable for low-entropy values (threat model, A9), so `standingOn` shows it only to who answers for the call; `withoutArguments` also masks fingerprints and `args`-like keys at any depth of `before`/`after` (defence in depth).
- **The Activity list grows through its address.** The number of lines is part of the address (`?lines=`); the server renders the whole list in one `search` from the same position, so later pages are authorized exactly like the first. No endpoint or server action returns rows; the address is replaced, not pushed (Back leaves the page). Keyset `(ts, id)`: concurrent writes do not shift pages.
- **Every public service method is classified.** `admin-mutations.test.ts` parses the classes under `server/{connections,missions,auth,requests,telemetry,authority,shares,groups,users,oauth-as,management}`; each method is a read, a mutation (driver + expected entry) or an exemption with a reason. A new method fails until classified.
- **A new object type does not compile until labelled**: `objectLabel` is a `switch` over `AdminObjectType` with no `default`. A share is labelled through the connection its entry names (`connection_id` in `before`/`after`): the store reads a share only with its connection.
- **A change reads in words from the keys it holds**, not per act (`changeLines`): an unknown key is printed under its own name, never dropped.
- **The server holds no sentence** for the session timeline: typed `SessionEventView` fields only (`parseEventDetails`), worded by `eventWords`; a kind from a later version prints as stored.
- **Usage comes from counters, not the audit.** `consumed` / `remaining` read `session_counters`; a granted claim lowers a counter, so "counted" can go down.
- **The session history leaves with the audit.** One `retention_days` for both; per session, in one transaction, events of `PERIOD_STATE_EVENT_KINDS` written since the current period started and the current period's counters are kept, whatever their age.

## Traps

- **Orphaned and lost are acts, not state.** Services write `mission-orphaned` / `mission-restored` around the acts that change an authority, through `appendUnlessLatest` (two concurrent acts write one entry). The execution door detects such changes on its own and writes no administrative entry, so a mission's two entries need not come in pairs.
- **Token holders are never crossed.** The `holder` filter takes `member:<id>` / `named:<name>`; an email names a member (token names cannot contain `@`); a token named like a user id is not that member.
- **Timeline label and holder filters** read indexed columns the sessions repository copies at insert (`events_session_label_ts`, `events_session_holder_ts`); the view still reads label and holder from the details.
- **A resource edit and a discovery name the connection as object**, so the connection filter and owner visibility need no join; a request decision names the request, resolved to its mission at search.
- **`countersAgreeWithAudit` on a one-off mission older than the retention** reports a mismatch that is the retention, not a fault.
- **The retention timer is single-process**: one sweep awaited at boot before serving, then hourly; a hosted deployment runs `sweep()` from one job. The two purges fail apart and are retried next interval.

## Debug

- **Entry missing** → scope before filters: is the viewer the creator, a current member, an owner (or through a group) of the connection, or an operator? For an administrative entry, does its object resolve to the viewer?
- **Old entry still there** → `retention_days` in the boot config, `audit retention:` log lines.
- **A new method breaks `admin-mutations.test.ts`** → classify it in `RULES`; if it changes state for a user, write the entry and add its driver.
- **Call missing from its label's timeline** → `SELECT kind, agent_label, details_json FROM events WHERE id = ?`; a `NULL` column with a label in the details was written outside the sessions repository.
- **"Ask me first" yet calls pass** → `gate_open_until`: the gate is open for the period; a later `gate-changed` ends it.
- **Usage disagrees with the record** → `countersAgreeWithAudit` ([budget-and-sessions](budget-and-sessions.md)).
