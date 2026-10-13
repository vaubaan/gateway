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
  - apps/gateway/src/server/store/repositories/sessions.ts
  - apps/gateway/migrations/0008_events_agent_label.sql
  - apps/gateway/tests/integration/audit/
  - apps/gateway/tests/e2e/v5/audit-session.spec.ts
  - packages/gateway-core/src/audit.ts
  - apps/gateway/src/server/compose/root.ts
---

# Audit — search, mission session view, retention, administrative entries

How what happened is made visible: the Audit page's search, the Mission session page,
the retention sweeper, and the rule that every administrative mutation leaves an entry.
Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §4.2 ("Mission session", "Audit"),
§6 ("Immutable audit", "No secret in logs"), §8 (fields, retention), §3.3 (the session),
§7.9 (several agents: "the session and the audit tell who did what").
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
  session-view.ts   MissionSessionService.get(), eventView(), SessionTimelineFilter
  session-event-detail.ts  eventDetailLines(), isSessionEventKind()  (pure: the Detail column)
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
  (`object_type = 'mission'`), such a connection (`'connection'`), a request of such a
  mission (`'request'`, resolved through `requests.mission_id`), or a share of such a
  connection (`'share'`, resolved through `shares.connection_id`), or a delegation the
  viewer gave (`'delegation'`, through `delegations.user_id`) — so a user finds in their
  audit a delegation of theirs that an operator or the gateway revoked. Entries about a
  group (`'group'`) or an OAuth client (`'oauth-client'`) are the operator's.

So the owner of a connection reads its `share-created` / `share-revoked` /
`connection-transferred` / `connection-reassigned` entries, and the creator of a mission
reads its `mission-orphaned` and `mission-restored` entries (cause, connection, uncovered
risks — [authority](authority.md)).

Those two entries record **human acts**, not the state. `orphaned` is derived from the
creator's current authority on every read and never stored (spec §2.3): the services take
the verdict of each mission before an act that can change an authority and again after it
(`MissionGrounds.watchConnection` / `watchCreator`), and write `mission-orphaned` when
the act removed it, `mission-restored` when the act returned it, naming the human behind
the act (the owner who revoked or shared again, the operator who edited a group or
reassigned a connection, the user whose sign-in changed their groups). `before` and
`after` carry `status` (`active` / `orphaned`) and, on the orphaned side, `cause`,
`connection_id` and `uncovered`. The execution door detects the same change on its own
and writes no administrative entry, in either direction: a change no service watched is
visible as refused, then allowed, call entries only. The two acts of one mission
therefore need not come in pairs.

An operator therefore sees every administrative act but not the calls of other people's
missions. The statement is plain `IN` subqueries over `missions`, `connections`,
`requests`, `shares` and `delegations` (`searchStatement` in
`store/repositories/audit.ts`), the same on Postgres.

## Filters and paging (`filters.ts`)

`parseAuditQuery(searchParams)` → `{ filters, cursor, raw, problems }`. Query parameters
(`AUDIT_PARAMS`): `mission`, `user`, `connection`, `tool`, `decision`, `agent`, `kind`,
`from`, `to`, `cursor`.

| Filter       | Matches                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------- |
| `mission`    | calls of the mission, acts on it, acts on its requests                                    |
| `user`       | an email or a user id: acts performed by that user and calls of the missions they created |
| `connection` | calls through the connection and acts on it                                               |
| `tool`       | exact tool name (calls only)                                                              |
| `decision`   | `allowed` \| `refused` (calls only: administrative entries drop out)                      |
| `agent`      | exact agent label, case-sensitive (calls only): what the caller declared, not an identity |
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
  `connection-unavailable: <connection status>` when the credential was rejected for good,
  `<provider id> stream failed after <N> parts[, HTTP <status>] (<error class>)` when a
  streamed result broke after N parts had been delivered, or
  `<provider id> stream stopped after <N> parts: the caller was gone`
  ([execution-door](execution-door.md), "Streaming"). `upstream_latency_ms` of a streamed
  call covers the whole stream: the entry is written when it ends.
  The error class is the error's `name` when it is identifier-shaped, `Error` otherwise.
  The provider's message goes to the agent that made the call, in the tool result, and is
  stored nowhere ([execution door](execution-door.md), "Upstream stage").
- `AuditCallView` / `AuditAdminView` are explicit field lists built by `toView`; nothing
  else of a record reaches a page.
- `before` / `after` of an administrative entry pass through `withoutArguments`, which
  replaces the value of any key named `args`, `arguments` or `raw_arguments`, at any
  depth, by `[not shown]` — defence in depth against a future writer's mistake.
- The session timeline is built by `eventView`, which surfaces `tool`, `refusal_code`,
  `agent_label`, `remaining`, `risk_ids`, `request_id`, `request_kind`, `request_state`,
  `approvals_consumed` (a count, never the approval ids), `gate`, `gate_before`,
  `gate_open_until`, `tokens_revoked`, `token_prefix`, `credits`, `dimension`,
  `expires_at` and ignores the rest of the event's `details` (the fingerprint, the
  approval ids, the period start).
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

`root.audit.sessions.get(user, missionId, { eventsBefore?, timeline? })` returns `null` for a
mission that does not exist or is not the user's (the same answer, as on the mission
detail page: it goes through `MissionService.get`), otherwise:

| Field             | Content                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `state`           | `deriveMissionState` (active with its current period, expired, revoked, orphaned)                                                                                                                                        |
| `session`         | `{ id, created_at }`, or `null` until the first call                                                                                                                                                                     |
| `risks`           | one row per accepted risk: catalog label and severity `level`, `quota`, `consumed` and `remaining` this period, `exhausted`, `rate_limit`, `gate`, and `gate_open_until` (below)                                         |
| `periods`         | the counters per period, newest first: the current one (listed even before its first action) then up to `PAST_PERIODS_SHOWN` (7) past ones                                                                               |
| `events`          | the timeline, newest first, `SESSION_EVENTS_PAGE_SIZE` (100) per page, keyset-paged with `next_events` (`SessionsRepo.listRecentEvents`)                                                                                 |
| `open_requests`   | requests in state `open` whose expiry is in the future, with their `path`                                                                                                                                                |
| `agent_labels`    | distinct `agent_label` of the mission's call entries with call count and last seen (`AuditRepo.agentLabels`)                                                                                                             |
| `label_activity`  | the calls of the **current period** per agent label — `allowed`, `refused`, `last_seen_at`, the unlabelled calls as `label: null` — busiest first; empty when the mission is not active (`AuditRepo.agentLabelActivity`) |
| `timeline_filter` | the filter `events` was read with (below)                                                                                                                                                                                |

`consumed` and `remaining` are read from `session_counters` as they stand, never
recomputed from the audit: a granted claim (period reset, quota extension —
[requests](requests.md)) lowers the counter, so "counted" can go down within a period.
The `reset` and `extension` events of the timeline carry what was given back per risk
(`credits`), which the page shows as "+N given back"; an expiry extension shows the new
date. `countersAgreeWithAudit` is the check `counted + credited == audited`.

**The gate of a risk is two facts.** `gate` is the mission's own setting (`auto` or
`approval`); `gate_open_until` is the end of the period the creator opened it for
("open the gate for the rest of the period", spec §3.5), `null` otherwise. Both come
from `MissionDetailRisk` ([missions](missions.md)). The Gate cell of the budget table
prints the badge and, under it, "open until <date>": `approval` alone would be wrong
while calls pass. The cell carries `data-testid="gate-<risk id>"`.

### The Detail column (`session-event-detail.ts`)

`eventDetailLines(event, { requestOpen })` turns the typed fields of a `SessionEventView`
into the lines of the Detail column: `{ text, at, mono }`, where `at` is an instant the
page prints after the text in the reader's time zone (`LocalDate`) and `mono` marks an
identifier. It is pure and switches over `SessionEventKind` with no `default`, so a new
kind fails to compile until it says what it shows; the page's badge tones (`EVENT_TONE`)
are a `Record<SessionEventKind, BadgeTone>` for the same reason. A kind written by a
later version (`isSessionEventKind` is false) shows no detail and a neutral badge.

| Kind                       | Detail                                                                                                                                                                                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `call-allowed`             | `approval consumed` when the call used one, nothing otherwise                                                                                                                                                                                                                            |
| `call-refused`             | the link `open claim` / `open approval` while its request is open; then `claim (closed)` / `approval request (closed)`. The kind of the request follows from the refusal code (`budget-exhausted` → claim, `approval-required` → approval request); a `rate-limited` call has no request |
| `request`, dropped         | `claim asked` / `approval request asked`, with the link while open, `… asked (closed)` after                                                                                                                                                                                             |
| `request`, closed          | `claim refused by the creator`, `approval request expired unanswered` (`request_state`)                                                                                                                                                                                                  |
| `approval`                 | `one call approved, usable until <date>`                                                                                                                                                                                                                                                 |
| `gate-opened`              | `gate open until <date>` (the end of the period)                                                                                                                                                                                                                                         |
| `gate-changed`             | `gate set to <gate> (was <gate before>)`                                                                                                                                                                                                                                                 |
| `reset`, quota `extension` | one line per risk: `<risk id> +N given back`                                                                                                                                                                                                                                             |
| expiry `extension`         | `expiry moved to <date>`                                                                                                                                                                                                                                                                 |
| `rotation`                 | `token <prefix>…`                                                                                                                                                                                                                                                                        |
| `revocation`               | `<n> token(s) revoked`                                                                                                                                                                                                                                                                   |

The request page words the same events as sentences (`describeEvent`,
`server/requests/events.ts`, [requests](requests.md)); the two are kept aligned by hand.

The timeline card takes the width of the window like the audit table (`.wide`), its
risk ids wrap (`.wraps`) and its Detail cell wraps (`.detail`), so the six columns are on
screen at 1280 px; the browser suite asserts it, on the seeded day and on a timeline
that holds gate and approval details.

### Agent labels on the session page

A label is what a caller declared about itself (handbook
[execution-door](execution-door.md), "Agent label"): attribution, never an identity, with
no effect on what is allowed or counted. The page says so where it shows one, and both
reads below are informational.

- **Calls per agent label — current period** (`label_activity`). Counts of audit entries
  of the mission with `ts` in the current period (`[period.start, period.end)`, open-ended
  for a one-off mission), grouped by `agent_label` and decision. It is **not a budget**:
  the quota is per risk and shared by every agent (spec §3.2), a call touching two risks
  is one call here and two decrements there, and a granted claim lowers a counter without
  removing a call. The card states it, and the budget table above it is unchanged by any
  filter. Each row links to the timeline of that label and to the Audit page filtered on
  it.
- **Timeline filter**: `/missions/<id>/session?agent=<label>` lists the call events
  (`call-allowed`, `call-refused`) that carried that label, `?unlabelled=1` those that
  carried none (`SessionTimelineFilter`: `all` | `label` | `unlabelled`). Requests,
  resets, rotations and the other events carry no label and are left out of a filtered
  timeline; "Show the whole timeline" brings them back.

The label of a call event is a column, `events.agent_label` (migration `0008`,
[store](store.md)): the sessions repository copies it from the event's details at insert
and the migration backfilled the rows written before. A filtered page is therefore the
same read as the plain timeline — `SessionsRepo.listRecentEvents(sessionId, { before?,
limit, calls: { agentLabel } })`, `agentLabel: null` for the unlabelled calls — with the
same order (`ts DESC, id DESC`), the same keyset and the same page size, served by the
index `events_session_label_ts`. There is no scan and no bound: "Older" is offered when,
and only when, an older matching call exists. The event view still reads the label from
the details (`parseEventDetails`); the column only selects the rows.

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

| Act                                                                     | Written by                                                                                                                                                                                                                                                                            | Object                                                                  |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `connection-created`, `connection-reconnected`, `connection-revoked`    | `ConnectionService` (`start` / `complete` / `revoke`)                                                                                                                                                                                                                                 | the connection                                                          |
| `connection-refused`                                                    | `ConnectionService` (installation not bound to the user)                                                                                                                                                                                                                              | the connection, or `not-created:<provider>`                             |
| `resources-discovered`                                                  | `ConnectionService.discover` — outcome, count, error; success and failure                                                                                                                                                                                                             | the connection                                                          |
| `resource-edited`                                                       | `ConnectionService.updateResource` — `before` / `after`: `resource_id`, `ref`, `display_name`, `env`, `hidden`, `owner_metadata`; nothing when the save changed nothing                                                                                                               | the connection                                                          |
| `connection-transferred`                                                | `ConnectionService.transfer` — `before.owner` / `after.owner`                                                                                                                                                                                                                         | the connection                                                          |
| `connection-reassigned`                                                 | `ConnectionService.reassign` (operator) — `before`: the previous owner and status                                                                                                                                                                                                     | the connection                                                          |
| `share-created`, `share-revoked`                                        | `ShareService.share` / `revoke` — target and restriction; a replaced share writes `share-revoked` (`after.replaced_by`) then `share-created` (`before`: the previous restriction) ([authority](authority.md))                                                                         | the share                                                               |
| `group-created`, `group-member-added`, `group-member-removed`           | `GroupService` (`create` / `addMember` / `removeMember`), Administration → Groups                                                                                                                                                                                                     | the group                                                               |
| `mission-issued`, `mission-rotated`, `mission-revoked`                  | `MissionService` (`issue` / `duplicate`, `rotate`, `revoke`), from the interface or from the management door's `issue_mission`, `rotate_mission_token`, `revoke_mission`                                                                                                              | the mission                                                             |
| `gate-changed`                                                          | `MissionService.setGate` — `before` / `after`: `risk_id`, `gate`; nothing when the gate did not change (P2.1, [missions](missions.md))                                                                                                                                                | the mission                                                             |
| `mission-orphaned`, `mission-restored`                                  | `MissionGrounds` (`watchConnection` / `watchCreator` → `settle(actorId)`), around a share, a revocation, a transfer, a reassignment, a group edit or a sign-in — `before` / `after`: `status` and, on the orphaned side, `cause`, `connection_id`, `uncovered`                        | the mission                                                             |
| `period-reset`, `budget-extended`, `expiry-extended`, `request-refused` | `RequestService.decideClaim` (P1.7, [requests](requests.md))                                                                                                                                                                                                                          | the request                                                             |
| `approval-granted`, `gate-opened`, `request-refused`                    | `RequestService.decideApproval` — `after`: `mission_id`, `risk_id`, `tool`, `fingerprint`, the resolution and its approval or period; never the arguments (P2.1)                                                                                                                      | the request                                                             |
| `delegation-granted`                                                    | `AuthorizationService.decide` — the user approved a consent screen; `after`: `client_id`, `client_name`, `scope`, `redirect_uri`, `resource` (P2.3, [management-door](management-door.md))                                                                                            | the delegation                                                          |
| `delegation-revoked`                                                    | `DelegationService.revoke` (the user), `TokenService` (the client signed out, or a refresh token or code was replayed), `ClientRegistry.decide` (an operator disabled the client) — `after.reason`: `user`, `client`, `refresh-token-replay`, `authorization-code-replay`, `operator` | the delegation                                                          |
| `oauth-client-approved`, `oauth-client-disabled`                        | `ClientRegistry.decide` (Administration → OAuth clients) — `before` / `after`: the status, the client id, name and redirect URIs                                                                                                                                                      | the OAuth client (`oauth-client`)                                       |
| `config-changed`                                                        | the Administration handlers (`saveProviderApp`, `saveIdpSettings`, the telemetry toggle `setEnabled`) and `completeLogin` when the first operator sign-in revokes the bootstrap token                                                                                                 | `instance-config`: `provider-app:<id>`, `idp`, `telemetry`, `bootstrap` |

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

An act that came through the management door keeps the user as its actor and also
carries `delegated_client_id`, the OAuth client that performed it
([management-door](management-door.md)); it is `null` for an act of the interface.
`AuditAdminView.delegated_client_id` exposes it and the Audit page prints "through
client <id>" under the entry.

`AuditAdminView.object` is `{ type, id, label }`. `label` names the object when it still
exists (`objectLabel` in `query-service.ts`, looked up once per page through `NameCache`);
the page prints it after the type, and falls back to the id when it is `null`:

| Object type       | Label                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `mission`         | the mission's name                                                                              |
| `connection`      | the connection's display name (`null` for the `not-created:<provider>` id of a refused connect) |
| `share`           | `<connection display name> → <email of the user, or name of the group, it is shared with>`      |
| `group`           | the group's name                                                                                |
| `oauth-client`    | the name the client declared                                                                    |
| `delegation`      | the name of the client the delegation was given to                                              |
| `request`         | `claim on <mission name>` / `approval request on <mission name>`                                |
| `instance-config` | none: the id is the name (`idp`, `telemetry`, `bootstrap`, `provider-app:<id>`)                 |

`objectLabel` is a `switch` over `AdminObjectType` with one case per member and no
`default`: an object type added to gateway-core does not compile until it has a label
(or says why it has none). A label widens nothing: the store filtered the entries before
they were turned into views, and a label names only the object of an entry the viewer was
given.

The structural test `tests/integration/audit/admin-mutations.test.ts` reads, with the
TypeScript parser, the public methods of every class under
`server/{connections,provider-apps,missions,auth,requests,telemetry,authority,shares,groups,oauth-as,management}`;
each must appear in its
`RULES` table
as a read, a mutation (with the driver that performs it and the entry it must leave) or
an exemption with its reason. Adding a public method to one of those services fails the
test until the method is classified. Exempt today: web-session and per-session transient
state (`SessionService`, `Authenticator`, `PendingConnectStore`, `NoticeStore`,
`AuthorizationService.createPending`), `CredentialBroker.refresh` and `RequestService.sweep`
(performed by the gateway with no human actor; an administrative entry always names a
user), the protocol steps an OAuth client performs with no human actor
(`ClientRegistry.register` and `resolveDocumentClient`, `TokenService.exchangeCode` and
`refresh`: they grant nothing a user did not consent to, and a replay writes
`delegation-revoked`), and `PluginStatsReader.refresh` (a cached copy of public
statistics; nothing of the instance changes). `MissionGrounds.inspect` and
`derive` are classified as reads — they write nothing — and `watchConnection`,
`watchCreator` and `MembershipSettler.watch` as mutations, driven around an act that
removes an authority (`mission-orphaned`) or returns one (`mission-restored`).

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
  `connection`, `request`, `share`, `delegation` (resolved to a mission, a connection or
  a delegation of the viewer), or is the viewer an operator?
- **An old entry is still there** → `retention_days` in the boot log's configuration,
  then the `audit retention:` lines; `root.audit.retention.started` says whether the
  timer runs.
- **A new service method breaks `admin-mutations.test.ts`** → classify it in `RULES`;
  if it changes state on behalf of a user, write the entry and add its driver.
- **Counters on the session page disagree with the audit** → `countersAgreeWithAudit`
  ([budget-and-sessions](budget-and-sessions.md)).
- **A call is missing from the timeline of its label** → the filter reads the column,
  not the details: `SELECT kind, agent_label, details_json FROM events WHERE id = ?`.
  A call event whose `agent_label` column is `NULL` while its details carry a label was
  written outside the sessions repository (the only writer, which fills the column).
- **A gate reads `approval` and calls pass** → `gate_open_until` on the risk row: the
  creator opened the gate for the period; the `gate-opened` event of the timeline says
  until when, and a later `gate-changed` ends it.

## Tests

- `src/server/audit/filters.test.ts` (18) — every filter, repeated and blank values,
  closed sets, unreadable dates, reversed period, single day, oversized value, cursor
  round trip and refusals, `auditQueryString`, `scopeOf` for the three viewers,
  `withoutArguments`.
- `src/server/audit/session-event-detail.test.ts` (8) — the Detail column kind by kind:
  an approval consumed, the request of a refused call (open, closed, none), a request
  asked / refused / expired, an approval and its deadline, a gate opened and a gate
  edited, credits given back and an expiry moved, a rotation and a revocation, nothing
  for malformed details or a kind of a later version.
- `tests/integration/audit/audit-query.test.ts` (24) — visibility (creator, connection
  owner, owning group, operator, bootstrap operator, requests of a mission), "a filter
  never widens the scope", the label of the object of an entry for each of the eight
  object types (and `null` for an object that is gone), each filter (the agent label:
  exact, calls only, inside the scope) and their combination, remaining budget per call,
  keyset paging (page sizes, no repeat, equal timestamps, concurrent write), no raw
  argument for any viewer, filter options.
- `tests/integration/audit/mission-session.test.ts` (20) — creator only, before the
  first call, counters / remaining / exhausted, past periods, one-off mission, open
  requests by link only, decided request, agent labels, calls per label for the current
  period (allowed, refused, unlabelled, past periods left out, nothing when inactive,
  the counters unchanged), the timeline filtered by label and to unlabelled calls, the
  calls of one label paged among more than two thousand events of other labels (order,
  no repeat, none skipped), until when a gate is open and what each approval, gate,
  rotation and revocation event says, timeline content and paging, revoked mission,
  `eventView`.
- `tests/integration/audit/events-agent-label.test.ts` (3) — migration `0008`: the
  backfill of the events an earlier image stored (labelled, unlabelled, empty, not a
  string, not a call, malformed JSON, no details) and its index; the copy made at insert
  (`agentLabelColumn`); `listRecentEvents` filtered on a label and on no label, with the
  keyset.
- `tests/integration/audit/retention.test.ts` (10) — purge of entries older than N days
  and of nothing else (other tables untouched, boundary kept), triggers still forbidding
  update and delete, idempotence, configured days, scheduling (boot sweep, interval,
  stop, failure logged, shared sweep), wiring in the composition root.
- `tests/integration/audit/admin-mutations.test.ts` (43) — the structural test above
  (the classification, the list of acts, then one case per mutating method: 36, the
  three mutating tools of the management door included), an approval request decided
  by each of its three resolutions through either entry point (3), plus `before` /
  `after` of a resource edit and a failed discovery.
- `tests/e2e/v5/audit-session.spec.ts` (4, Playwright on the ephemeral instance) — a day
  of calls on the session page (the calls per agent label beside the shared budget, the
  timeline of one label and back to the whole one) and on the audit page (nine filters
  in one row, the agent label among them); every column of the audit table on screen at
  1280 px with no sideways scroll (the fingerprint cell wraps; the check is a plain
  test, no longer an expected failure); every column of the session timeline on screen
  at 1280 px; 404 for a mission that is not the user's.
- `tests/e2e/v5/approve-action.spec.ts` (1) asserts the rest of this page in a browser:
  the Gate cell reading "open until" while the gate is open, what the `gate-opened`,
  `gate-changed`, `approval`, `call-allowed` and `request` events say in the Detail
  column, and that timeline fitting the window at 1280 px
  ([e2e tests](../tests/e2e-tests.md)).

## References

- Spec [vaubaan-gateway](../spec/vaubaan-gateway.md) §3.3, §4.2, §6, §8, §10.
- ADR [embedded-store-sqlite-and-migrations](../decisions/embedded-store-sqlite-and-migrations.md)
  (append-only audit, purge guard);
  [atomic-budget-accounting](../decisions/atomic-budget-accounting.md) (counters, events).
- Neighbouring handbooks: [store](store.md), [gateway-core](gateway-core.md),
  [budget-and-sessions](budget-and-sessions.md), [missions](missions.md),
  [connections](connections.md), [requests](requests.md), [authentication](authentication.md),
  [configuration](configuration.md).
