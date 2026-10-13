---
title: Audit — search, mission session view, retention, administrative entries
status: current
date: 2026-10-13
last_synced: 2026-10-13
tracks:
  - apps/gateway/src/server/audit/
  - apps/gateway/src/app/(app)/audit/
  - apps/gateway/src/app/(app)/missions/[id]/session/
  - apps/gateway/src/server/store/repositories/audit.ts
  - apps/gateway/tests/integration/audit/
  - apps/gateway/tests/e2e/v5/audit-session.spec.ts
  - packages/gateway-core/src/audit.ts
  - apps/gateway/src/server/compose/root.ts
---

# Audit — search, mission session view, retention, administrative entries

How what happened is made visible: the Audit page's search, the Mission session page,
the retention sweeper, and the rule that every administrative mutation leaves an entry.
Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §4.2 ("Mission session", "Audit"),
§6 ("Immutable audit", "No secret in logs"), §8 (fields, retention), §3.3 (the session).
The entry shapes and the writer contract are gateway-core's
([gateway-core](gateway-core.md), `packages/gateway-core/src/audit.ts`); the tables, the
append-only triggers and the purge path are the store's ([store](store.md)); the session,
its counters and its events are written by the budget
([budget-and-sessions](budget-and-sessions.md)). This module only reads them — and purges.

## Layout

```
apps/gateway/src/server/audit/
  index.ts          createAuditModule() → { query, sessions, retention }, barrel
  filters.ts        parseAuditQuery(), parseInstant(), encodeCursor()/decodeCursor(), auditQueryString()  (pure)
  query-service.ts  AuditQueryService.search() / filterOptions(), scopeOf(), withoutArguments(), the views
  session-view.ts   MissionSessionService.get(), eventView()
  retention.ts      AuditRetentionSweeper (start / stop / sweep)
apps/gateway/src/app/(app)/
  audit/page.tsx                  /audit
  audit/audit.module.css          shared by both pages
  missions/[id]/session/page.tsx  /missions/<id>/session
```

`root.audit` is the module (`compose/root.ts`). The pages are server components with no
client code: the filters are a plain `GET` form, paging is a link.

## Who sees what (`scopeOf`, `AuditRepo.search`)

`scopeOf(viewer)` turns the person behind the request into the store's `AuditScope`:

| Viewer                       | `missionCreatorUserId` | `connectionOwners`                  | `allAdmin` |
| ---------------------------- | ---------------------- | ----------------------------------- | ---------- |
| user                         | their id               | themselves and each of their groups | `false`    |
| user matching the admin rule | their id               | themselves and each of their groups | `true`     |
| bootstrap operator           | `null`                 | none                                | `true`     |

`AuditViewer` is structurally the `Principal` of `server/auth`, so a page passes
`currentPrincipal().principal` as is; the groups are the current ones, never a snapshot.

`store.audit.search(query)` applies the scope **first**, in SQL, then the filters, then
the keyset position, so a filter can only narrow what the scope allows:

- a **call** entry is visible when its `mission_id` is a mission the viewer created or its
  `connection_id` is a connection the viewer (or one of their groups) owns;
- an **administrative** entry is visible when `allAdmin`, or its object is such a mission
  (`object_type = 'mission'`), such a connection (`'connection'`), or a request of such a
  mission (`'request'`, resolved through `requests.mission_id`).

An operator therefore sees every administrative act but not the calls of other people's
missions. The statement is plain `IN` subqueries over `missions`, `connections` and
`requests` (`searchStatement` in `store/repositories/audit.ts`), the same on Postgres.

## Filters and paging (`filters.ts`)

`parseAuditQuery(searchParams)` → `{ filters, cursor, raw, problems }`. Query parameters
(`AUDIT_PARAMS`): `mission`, `user`, `connection`, `tool`, `decision`, `kind`, `from`,
`to`, `cursor`.

| Filter       | Matches                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------- |
| `mission`    | calls of the mission, acts on it, acts on its requests                                    |
| `user`       | an email or a user id: acts performed by that user and calls of the missions they created |
| `connection` | calls through the connection and acts on it                                               |
| `tool`       | exact tool name (calls only)                                                              |
| `decision`   | `allowed` \| `refused` (calls only: administrative entries drop out)                      |
| `kind`       | `call` \| `admin`                                                                         |
| `from`, `to` | a day `YYYY-MM-DD` read as UTC, or a full ISO instant; `to` includes its day              |

A value that cannot be read (unknown decision, impossible date, `from` after `to`,
oversized value, unreadable cursor) is dropped and listed in `problems`, which the page
shows; it never widens the search. An unknown email matches nothing, exactly like a known
user with no entry, so the filter does not reveal who has an account.

Order is `ts DESC, id DESC`. `AuditQueryService.search(viewer, filters, cursor, pageSize
= AUDIT_PAGE_SIZE /* 50 */)` asks the store for one row more than the page; when it comes
back, `next` is the `(ts, id)` of the last entry shown, and the "Older" link carries it as
`cursor` (`encodeCursor`: base64url of `<ts>|<id>`). The store resumes with
`ts < ? OR (ts = ? AND id < ?)`: an entry written while paging does not shift the
following pages, and entries with the same timestamp are neither repeated nor skipped.

## No raw arguments

- An audit entry never holds arguments: `arguments_hash` is
  `fingerprintArguments(args)` (sha256 of the canonical JSON, 64 hex — the fingerprint that
  also binds approvals) and nothing else is stored (gateway-core).
- `upstream_error` never holds the provider's text. A provider error can echo the call's
  input (a SQL fragment, an object id) and plugins quote the start of the provider's body
  in the error they throw, so the entry stores a summary the host builds instead, cut at
  `UPSTREAM_ERROR_SUMMARY_MAX_LENGTH` (200) characters. It is one of:
  `<provider id> answered HTTP <status> (<error class>)` when the error carries a status,
  `<provider id> call failed (<error class>)` when it does not, or
  `connection-unavailable: <connection status>` when the credential was rejected for good.
  The error class is the error's `name` when it is identifier-shaped, `Error` otherwise.
  The provider's message goes to the agent that made the call, in the tool result, and is
  stored nowhere ([execution door](execution-door.md), "Upstream stage").
- `AuditCallView` / `AuditAdminView` are explicit field lists built by `toView`; nothing
  else of a record reaches a page.
- `before` / `after` of an administrative entry pass through `withoutArguments`, which
  replaces the value of any key named `args`, `arguments` or `raw_arguments`, at any
  depth, by `[not shown]` — defence in depth against a future writer's mistake.
- The session timeline is built by `eventView`, which surfaces `tool`, `refusal_code`,
  `agent_label`, `remaining`, `risk_ids`, `request_id`, `request_kind`, `token_prefix`,
  `credits`, `dimension`, `expires_at` and ignores the rest of the event's `details`.
  It reads them through `parseEventDetails` (`@vaubaan/shared`, see
  [budget and sessions](budget-and-sessions.md)): each field comes from the kinds that
  carry it, and an event whose stored details do not have the shape of its kind is listed
  with its kind, time, risk and actor, every detail field `null`.
- Open requests are those `isDecidable` (`server/requests/state.ts`) says are still open
  as of now: the same rule as the inbox, not a second comparison of dates.
- Open requests are listed **by link** to the creator's view of the request
  (`inboxRequestPath(id)` of `server/requests/url.ts` = `/requests/<id>`): kind, risk,
  opened, expires. The sealed arguments of an approval request stay with the requests
  feature ([requests](requests.md)).

## Mission session view (`session-view.ts`)

`root.audit.sessions.get(user, missionId, { eventsBefore? })` returns `null` for a
mission that does not exist or is not the user's (the same answer, as on the mission
detail page: it goes through `MissionService.get`), otherwise:

| Field           | Content                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`         | `deriveMissionState` (active with its current period, expired, revoked, orphaned)                                                                 |
| `session`       | `{ id, created_at }`, or `null` until the first call                                                                                              |
| `risks`         | one row per accepted risk: catalog label and severity `level`, `quota`, `consumed` and `remaining` this period, `exhausted`, `rate_limit`, `gate` |
| `periods`       | the counters per period, newest first: the current one (listed even before its first action) then up to `PAST_PERIODS_SHOWN` (7) past ones        |
| `events`        | the timeline, newest first, `SESSION_EVENTS_PAGE_SIZE` (100) per page, keyset-paged with `next_events` (`SessionsRepo.listRecentEvents`)          |
| `open_requests` | requests in state `open` whose expiry is in the future, with their `path`                                                                         |
| `agent_labels`  | distinct `agent_label` of the mission's call entries with call count and last seen (`AuditRepo.agentLabels`)                                      |

`consumed` and `remaining` are read from `session_counters` as they stand, never
recomputed from the audit: a granted claim (period reset, quota extension —
[requests](requests.md)) lowers the counter, so "counted" can go down within a period.
The `reset` and `extension` events of the timeline carry what was given back per risk
(`credits`), which the page shows as "+N given back"; an expiry extension shows the new
date. `countersAgreeWithAudit` is the check `counted + credited == audited`.

For a mission that is not active, `consumed` / `remaining` are `null` and the stored
periods are listed as past (the 8 most recent). The mission detail page links to the session page; the session
page links to the audit filtered on the mission.

## Retention (`retention.ts`)

`AuditRetentionSweeper` calls `store.audit.purgeByRetention(config.retentionDays)` —
the store's only delete path, bounded by its cutoff and guarded by the triggers. The
composition root awaits `root.audit.retention.start()` before the instance serves (one
sweep at boot), a timer repeats it every `RETENTION_SWEEP_INTERVAL_MS` (one hour), and
`root.close()` stops the timer and waits for a sweep in flight before closing the store.
`retention_days` / `VAUBAAN_RETENTION_DAYS` is the only setting
([configuration](configuration.md)); an entry exactly N days old is kept.

A purge that fails is logged (`audit retention: purge failed`, with `retention_days` and
the error) and retried at the next interval; it never stops the instance. A purge that
removes something logs `audit retention: entries purged` with the count. The timer is
`// single-process only`: a hosted deployment runs `sweep()` from one scheduled job.

Only `audit` and `audit_risks` are purged. Session events and counters are not covered by
`retention_days`.

## Administrative entries: who writes what

| Act                                                                     | Written by                                                                                                                                                              | Object                                                     |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `connection-created`, `connection-reconnected`, `connection-revoked`    | `ConnectionService` (`start` / `complete` / `revoke`)                                                                                                                   | the connection                                             |
| `connection-refused`                                                    | `ConnectionService` (installation not bound to the user)                                                                                                                | the connection, or `not-created:<provider>`                |
| `resources-discovered`                                                  | `ConnectionService.discover` — outcome, count, error; success and failure                                                                                               | the connection                                             |
| `resource-edited`                                                       | `ConnectionService.updateResource` — `before` / `after`: `resource_id`, `ref`, `display_name`, `env`, `hidden`, `owner_metadata`; nothing when the save changed nothing | the connection                                             |
| `mission-issued`, `mission-rotated`, `mission-revoked`                  | `MissionService` (`issue` / `duplicate`, `rotate`, `revoke`)                                                                                                            | the mission                                                |
| `period-reset`, `budget-extended`, `expiry-extended`, `request-refused` | `RequestService.decideClaim` (P1.7, [requests](requests.md))                                                                                                            | the request                                                |
| `config-changed`                                                        | the Administration handlers (`saveProviderApp`, `saveIdpSettings`) and `completeLogin` when the first operator sign-in revokes the bootstrap token                      | `instance-config`: `provider-app:<id>`, `idp`, `bootstrap` |

A resource edit and a discovery name the **connection** as their object so that the
connection filter and the owner's visibility find them with no join; the resource is in
`before` / `after`. A request decision names the request; the search resolves it to its
mission through `requests.mission_id`.

The actor of an administrative entry is stored as `user_id`: a user id, or
`BOOTSTRAP_ACTOR_ID` (`'bootstrap'`, `packages/gateway-core/src/audit.ts`) for the holder
of the bootstrap token, who has no user row. `AuditAdminView.actor` is
`{ id, email, label }`, built by `actorView` (`query-service.ts`); `label` is what the
Audit page prints: the user's email, else `BOOTSTRAP_ACTOR_LABEL` ("Bootstrap operator")
when the id is `BOOTSTRAP_ACTOR_ID` (its `email` is `null`), else the raw id (a user
whose row is gone).

The structural test `tests/integration/audit/admin-mutations.test.ts` reads, with the
TypeScript parser, the public methods of every class under
`server/{connections,provider-apps,missions,auth,requests}`; each must appear in its
`RULES` table
as a read, a mutation (with the driver that performs it and the entry it must leave) or
an exemption with its reason. Adding a public method to one of those services fails the
test until the method is classified. Exempt today: web-session and per-session transient
state (`SessionService`, `Authenticator`, `PendingConnectStore`, `NoticeStore`),
`CredentialBroker.refresh` and `RequestService.sweep` (performed by the gateway with no
human actor; an administrative entry always names a user).

## How to use it

```ts
const { root, principal } = await currentPrincipal();
const query = parseAuditQuery(await searchParams);
const page = await root.audit.query.search(principal, query.filters, query.cursor);
// page.entries: AuditEntryView[]  — page.next: AuditCursor | null
const view = await root.audit.sessions.get(user, missionId); // MissionSessionView | null
const removed = await root.audit.retention.sweep(); // number, or null when the purge failed
```

## How to debug

- **An entry is missing from the page** → check the scope before the filters: is the
  viewer the mission's creator, or an owner (directly or through a group) of the entry's
  `connection_id`? For an administrative entry, is its `object_type` one of `mission`,
  `connection`, `request`, or is the viewer an operator?
- **An old entry is still there** → `retention_days` in the boot log's configuration,
  then the `audit retention:` lines; `root.audit.retention.started` says whether the
  timer runs.
- **A new service method breaks `admin-mutations.test.ts`** → classify it in `RULES`;
  if it changes state on behalf of a user, write the entry and add its driver.
- **Counters on the session page disagree with the audit** → `countersAgreeWithAudit`
  ([budget-and-sessions](budget-and-sessions.md)).

## Tests

- `src/server/audit/filters.test.ts` (18) — every filter, repeated and blank values,
  closed sets, unreadable dates, reversed period, single day, oversized value, cursor
  round trip and refusals, `auditQueryString`, `scopeOf` for the three viewers,
  `withoutArguments`.
- `tests/integration/audit/audit-query.test.ts` (21) — visibility (creator, connection
  owner, owning group, operator, bootstrap operator, requests of a mission), "a filter
  never widens the scope", each filter and their combination, remaining budget per call,
  keyset paging (page sizes, no repeat, equal timestamps, concurrent write), no raw
  argument for any viewer, filter options.
- `tests/integration/audit/mission-session.test.ts` (14) — creator only, before the
  first call, counters / remaining / exhausted, past periods, one-off mission, open
  requests by link only, decided request, agent labels, timeline content and paging,
  revoked mission, `eventView`.
- `tests/integration/audit/retention.test.ts` (10) — purge of entries older than N days
  and of nothing else (other tables untouched, boundary kept), triggers still forbidding
  update and delete, idempotence, configured days, scheduling (boot sweep, interval,
  stop, failure logged, shared sweep), wiring in the composition root.
- `tests/integration/audit/admin-mutations.test.ts` (20) — the structural test above,
  plus `before` / `after` of a resource edit and a failed discovery.
- `tests/e2e/v5/audit-session.spec.ts` (2, Playwright on the ephemeral instance) — a day
  of calls on the session page and on the audit page, filters in one row, 404 for a
  mission that is not the user's.

## References

- Spec [vaubaan-gateway](../spec/vaubaan-gateway.md) §3.3, §4.2, §6, §8, §10.
- ADR [embedded-store-sqlite-and-migrations](../decisions/embedded-store-sqlite-and-migrations.md)
  (append-only audit, purge guard);
  [atomic-budget-accounting](../decisions/atomic-budget-accounting.md) (counters, events).
- Neighbouring handbooks: [store](store.md), [gateway-core](gateway-core.md),
  [budget-and-sessions](budget-and-sessions.md), [missions](missions.md),
  [connections](connections.md), [requests](requests.md), [authentication](authentication.md),
  [configuration](configuration.md).
