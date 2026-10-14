---
title: Audit — search, mission session view, retention, administrative entries
status: current
date: 2026-10-13
last_synced: 2026-10-14
tracks:
  - apps/gateway/src/server/budget/retention.ts
  - apps/gateway/src/server/audit/
  - apps/gateway/src/app/(app)/activity/
  - apps/gateway/src/app/(app)/missions/[id]/session/
  - apps/gateway/src/server/store/repositories/audit.ts
  - apps/gateway/src/server/store/repositories/sessions.ts
  - apps/gateway/migrations/0008_events_agent_label.sql
  - apps/gateway/migrations/0010_mission_members_and_token_holders.sql
  - apps/gateway/tests/integration/audit/
  - apps/gateway/tests/e2e/v5/audit-session.spec.ts
  - packages/gateway-core/src/audit.ts
  - apps/gateway/src/server/compose/root.ts
---

# Audit — search, mission session view, retention, administrative entries

How what happened is made visible: the search of the Activity page (`/activity`), the
activity of one mission (`/missions/<id>/session`),
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
  session-view.ts   MissionSessionService.get(), eventView(), SessionTimelineFilter, holderParam() / parseHolderParam()

  retention.ts      AuditRetentionSweeper (start / stop / sweep)
apps/gateway/src/app/(app)/
  activity/page.tsx               /activity   ("Activity": the record)
  activity/when.tsx               the time of a line (client: the reader's own clock after hydration)
  activity/activity.module.css
    missions/[id]/session/page.tsx  /missions/<id>/session   ("Activity of <mission>")
  missions/[id]/session/event-words.ts  eventWords()  (pure: what a row of the timeline says)
```

`root.audit` is the module (`compose/root.ts`). The pages are server components: the
filters are a plain `GET` form, paging and the detail of a line are links.

## Who sees what (`scopeOf`, `standingOn`, `AuditRepo.search`)

`scopeOf(viewer)` turns the person behind the request into the store's `AuditScope`
(spec §4.2 "Audit", §8; ADR
[audit-visibility-members-and-operators](../decisions/audit-visibility-members-and-operators.md)):

| Viewer                       | `missionCreatorUserId` | `missionMemberUserId` | `connectionOwners`                  | `allAdmin` | `allCalls` |
| ---------------------------- | ---------------------- | --------------------- | ----------------------------------- | ---------- | ---------- |
| user                         | their id               | their id              | themselves and each of their groups | `false`    | `false`    |
| user matching the admin rule | their id               | their id              | themselves and each of their groups | `true`     | `true`     |
| bootstrap operator           | `null`                 | `null`                | none                                | `true`     | `false`    |

- A **member** of a mission reads its entries — calls, acts on it, acts on its requests
  — for as long as they are a member: the store reads `mission_members` rows whose
  `removed_at` is null, so a removed member reads none of them, past ones included.
- An **operator** reads every entry of the instance, calls included.
- The **bootstrap operator** reads the administrative entries and no call: it is a shared
  token, not a person, and exists before the first user does.

**Nobody reads arguments.** An entry never holds them. What it holds is their
fingerprint, an unsalted SHA-256, which can be guessed for low-entropy arguments
(threat model, A9). `standingOn(viewer, mission, connection)` says what the viewer is
to an entry they were given:

| Standing      | Who                                                             | Fingerprint                                   |
| ------------- | --------------------------------------------------------------- | --------------------------------------------- |
| `responsible` | the creator of the entry's mission, an owner of its connection  | shown                                         |
| `reader`      | anybody else the scope gave the entry to: a member, an operator | not shown: `arguments_hash: null` in the view |

It is decided entry by entry, from the mission and the connection as they are now, so
an operator who also created a mission reads the fingerprints of its calls, and a member
who also owns the connection a call went through reads that call's. For a `reader`,
`withoutArguments(value, 'reader')` also masks the keys `fingerprint`,
`arguments_hash` and `arguments_fingerprint` of an administrative entry's `before` /
`after` (the entries of an approval request carry one). The detail of a line then says "never stored · their fingerprint is shown to the creator of the mission and to the owners of the account only" (`ACTIVITY_WORDS.fingerprintHidden`).

`AuditViewer` is structurally the `Principal` of `server/auth`, so a page passes
`currentPrincipal().principal` as is; the groups are the current ones, never a snapshot.

`store.audit.search(query)` applies the scope **first**, in SQL, then the filters, then
the keyset position, so a filter can only narrow what the scope allows:

- a **call** entry is visible when `allCalls`, or its `mission_id` is a mission the viewer
  created or is a current member of, or its `connection_id` is a connection the viewer
  (or one of their groups) owns;
- an **administrative** entry is visible when `allAdmin`, or its object is a mission the
  viewer created or is a member of (`object_type = 'mission'`), a request of such a
  mission (`'request'`, resolved through `requests.mission_id`), a connection they own
  (`'connection'`), or a share of such a
  connection (`'share'`, resolved through `shares.connection_id`), or a delegation the
  viewer gave (`'delegation'`, through `delegations.user_id`) — so a user finds in their
  audit a delegation of theirs that an operator or the gateway revoked. Entries about a
  group (`'group'`), an OAuth client (`'oauth-client'`) or a user (`'user'`: a
  deactivation, a reactivation) are the operator's.

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
`connection_id` and `uncovered`. Written through `AuditRepo.appendUnlessLatest`: when two
acts under way at once see the same change, the entry is written once and names the act
that settled first ([store](store.md), "Audit"). The execution door detects the same change on its own
and writes no administrative entry, in either direction: a change no service watched is
visible as refused, then allowed, call entries only. The two acts of one mission
therefore need not come in pairs.

The scope is one predicate, `scopePredicate` in `store/repositories/audit.ts`: plain
`IN` subqueries over `missions`, `mission_members`, `connections`, `requests`, `shares`
and `delegations`, the same on Postgres. Each piece carries its own placeholder values
(`SqlPiece`), so a dimension added to the scope cannot shift the values of another; a
dimension the scope does not hold is an always-false piece.

## Filters and paging (`filters.ts`)

`parseAuditQuery(searchParams)` → `{ filters, cursor, raw, problems }`. Query parameters
(`AUDIT_PARAMS`): `mission`, `user`, `connection`, `tool`, `decision`, `agent`, `holder`,
`kind`, `from`, `to`, `cursor`.

| Filter       | Matches                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------- |
| `mission`    | calls of the mission, acts on it, acts on its requests                                    |
| `user`       | an email or a user id: acts performed by that user and calls of the missions they created |
| `connection` | calls through the connection and acts on it                                               |
| `tool`       | exact tool name (calls only)                                                              |
| `decision`   | `allowed` \| `refused` (calls only: administrative entries drop out)                      |
| `agent`      | exact agent label, case-sensitive (calls only): what the caller declared, not an identity |
| `holder`     | the holder of the token a call presented (calls only): see "Token holders" below          |
| `kind`       | `call` \| `admin`                                                                         |
| `from`, `to` | a day `YYYY-MM-DD` read as UTC, or a full ISO instant; `to` includes its day              |

A value that cannot be read (unknown decision, impossible date, `from` after `to`,
oversized value, unreadable cursor) is dropped and listed in `problems`, which the page
shows; it never widens the search. An unknown email matches nothing, exactly like a known
user with no entry, so the filter does not reveal who has an account.

### The Activity page (`activity/page.tsx`)

The record as a person reads it. The words are the interface's
(`lib/vocabulary.ts`: `ACTIVITY_WORDS`, `ACT_WORDS` per administrative act,
`REFUSAL_WORDS` per refusal code, `DECISION_WORDS`); the protocol's names are
in the detail of a line, in mono.

- **Filters**, one `GET` form. On the first line: the period as four segments
  (Today, Yesterday, 7 days, All — links that set `from` / `to` as UTC days; a
  period typed by hand highlights none), the mission, the account, the
  decision, the exact tool name, "Apply", and "Clear" when a filter is set.
  Behind "More filters" (a `Disclosure`, remembered, open when one of them is
  set): person, key holder, agent, kind, from, to.
- **Counts** of the page shown — calls, refused, asked first, changes — and
  one sentence saying whose record this is (a person's missions and accounts,
  or everything for an administrator).
- **The table** (`DataTable`, `columnBudget={6}`: the documented exception):
  Time (`When`), Who (the key holder with the label the agent gave itself; a
  machine key as a dashed square with "machine key"; for a change, who made
  it and through which app), Action (the tool in mono, or the act in words),
  On (the resource and its account, or the object of the change), Permission
  (the label of the first risk touched, "+n" for more), Decision. A seventh
  column, Mission, is a detail column: "Show details" (`DetailScope`
  `activity:columns`, remembered).
- **Decision**: "allowed" in the quiet ink ("· after a yes" when the call
  consumed an approval); "refused" in red with the reason in words; a call
  refused `approval-required` is not red: it reads "asked you" (or "asked
  <creator>") in amber, and its row is tinted amber instead of red; a change
  reads "change".
- **The detail of a line** opens under it through its "detail" link, which
  adds `?open=<entry id>` to the current filters and position — a line has an
  address. For a call: the mission and its creator, the key and the agent
  label, the tool, each permission touched with its id and what is left, the
  arguments ("never stored", then their fingerprint, or the sentence that says
  who is shown it when `arguments_hash` is `null`: `standingOn`), the refusal
  code with what the agent was told, and the technical facts (a yes used,
  latency, the service's error, the client address). For a change: the act
  and its object as the protocol names them, who made it, then **what changed
  in words** (`changeLines`, `activity/change-lines.ts`, pure;
  `data-testid="change-line"`): the account by its name, the resources by
  theirs, each permission with its limits and whether it asks first ("Read
  code · 200 a day · 60 a minute · runs freely", its id in mono beside it), a
  status in the words of its object ("stopped · was running" for a mission),
  a value that changed with what it was, and nothing for a value that did not
  change. The lines are read from the keys the record holds, not written per
  act: a new act with known keys reads well at once, and an unknown key is
  printed under its own name rather than dropped. `before` / `after` as stored
  — the protocol's names, the raw ids — are one click away ("Show the raw
  record", `change-raw`). The names behind the ids come from
  `AuditQueryService.changeNames(entry)`: read-only, called for the one line a
  person opened, it names the ids of an entry this service already returned to
  the reader (an account, a resource, a person by their email, a team) and
  reveals nothing the entry does not hold.
- **Paging**: "Earlier" follows `page.next`; "Newest" returns to the first
  page.

### Token holders

Every call entry names the token it presented and its holder (spec §8; ADR
[mission-members-and-per-holder-tokens](../decisions/mission-members-and-per-holder-tokens.md)):
`token_id`, `token_kind` (`member` | `named`) and `token_holder` — the member's user id,
or the name of a named token — written by the pipeline from the authenticated context.
Unlike the agent label it is not a claim of the caller.

- **The view.** `AuditCallView.token` is `{ kind, key, label }`: `label` is the member's
  email (their id when the user row is gone) or the token's name; `null` on an entry
  written before tokens had a holder, which the page shows as "not attributed". It is
  the "Who" column of the Activity page, with the label the agent gave itself under it;
  a named token is drawn as a dashed square and says "machine key".
- **The filter.** `holder`, as typed (`AuditQueryService.holdersOf`): the exact form the
  activity of a mission links with (`member:<user id>`, `named:<name>` — `holderParam` /
  `parseHolderParam`), otherwise an email names a member (a token name never contains
  `@`, `parseTokenName`) and anything else a named token. A kind is never crossed: a
  token named like a user's id is not that member. An unknown email matches nothing, like
  a known member with no call.

Order is `ts DESC, id DESC`. `AuditQueryService.search(viewer, filters, cursor, pageSize
= AUDIT_PAGE_SIZE /* 50 */)` asks the store for one row more than the page; when it comes
back, `next` is the `(ts, id)` of the last entry shown, and the "Earlier" link carries it as
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
- A call refused because a decision stage threw (resource, risk or budget: a classifier
  that is not total, a store failure) has its entry like any refused call:
  `decision: 'refused'`, no `refusal_code`, and a `refusal_reason` the host builds from the
  stage and the class name of what was thrown (`stageFailureReason`, gateway-core) — never
  from the error's message, which can quote the arguments. The instance log gets one
  `error` line with the stage, the tool, the error class and the first stack frames, and
  no message either ([execution-door](execution-door.md); ADR
  [decision-stages-fail-closed-and-audited](../decisions/decision-stages-fail-closed-and-audited.md),
  D1).
- `AuditCallView` / `AuditAdminView` are explicit field lists built by `toView`; nothing
  else of a record reaches a page.
- `before` / `after` of an administrative entry pass through `withoutArguments`, which
  replaces the value of any key named `args`, `arguments` or `raw_arguments`, at any
  depth, by `[not shown]` — defence in depth against a future writer's mistake.
- The session timeline is built by `eventView`, which surfaces `tool`, `refusal_code`,
  `agent_label`, `holder` (the token holder, resolved to a label), `remaining`, `risk_ids`,
  `request_id`, `request_kind`, `request_state`,
  `approvals_consumed` (a count, never the approval ids), `gate`, `gate_before`,
  `gate_open_until`, `tokens_revoked`, `token_prefix`, `replaced_prefix`, `credits`, `dimension`,
  `expires_at` and ignores the rest of the event's `details` (the fingerprint, the
  approval ids, the period start).
  It reads them through `parseEventDetails` (`@vaubaan/shared`, see
  [budget and sessions](budget-and-sessions.md)): each field comes from the kinds that
  carry it, and an event whose stored details do not have the shape of its kind is listed
  with its kind, time, risk and actor, every detail field `null`.
- Open requests are those `isDecidable` (`server/requests/state.ts`) says are still open
  as of now: the same rule as "Waiting for you", not a second comparison of dates.
- Open requests are listed **by link** to the creator's view of the request
  (`inboxRequestPath(id)` of `server/requests/url.ts` = `/waiting/<id>`): kind, risk,
  opened, expires. The sealed arguments of an approval request stay with the requests
  feature ([requests](requests.md)).

## Mission session view (`session-view.ts`)

`root.audit.sessions.get(user, missionId, { eventsBefore?, timeline? })` returns `null` for a
mission that does not exist or that the user neither created nor is a member of (the same
answer, as on the mission detail page: it goes through `MissionService.get`), otherwise —
for the creator and for a member alike, with `viewer_role` saying which:

| Field             | Content                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`           | `deriveMissionState` (active with its current period, expired, revoked, orphaned)                                                                                                                                                                                                                                                                                                       |
| `session`         | `{ id, created_at }`, or `null` until the first call                                                                                                                                                                                                                                                                                                                                    |
| `risks`           | one row per accepted risk: catalog label and severity `level`, `quota`, `consumed` and `remaining` this period, `exhausted`, `rate_limit`, `gate`, and `gate_open_until` (below)                                                                                                                                                                                                        |
| `periods`         | the counters per period, newest first: the current one (listed even before its first action) then up to `PAST_PERIODS_SHOWN` (7) past ones                                                                                                                                                                                                                                              |
| `events`          | the timeline, newest first, `SESSION_EVENTS_PAGE_SIZE` (100) per page, keyset-paged with `next_events` (`SessionsRepo.listRecentEvents`)                                                                                                                                                                                                                                                |
| `open_requests`   | requests in state `open` whose expiry is in the future, with their `path` — `null` for a member: they see that a request waits, only the creator answers it — and, for an approval request, the `tool` of the call and the `resource_ref` its audit entry holds (what the page heads the request with: "Merge a pull request · acme-org/app"); never the arguments or their fingerprint |
| `holder_activity` | the calls of the **current period** per token holder — `holder` (`{ kind, key, label }`, `null` for calls written before tokens had a holder), `allowed`, `refused`, `last_seen_at` — busiest first, then by label (`AuditRepo.tokenHolderActivity`)                                                                                                                                    |
| `agent_labels`    | distinct `agent_label` of the mission's call entries with call count and last seen (`AuditRepo.agentLabels`)                                                                                                                                                                                                                                                                            |
| `label_activity`  | the calls of the **current period** per agent label — `allowed`, `refused`, `last_seen_at`, the unlabelled calls as `label: null` — busiest first; empty when the mission is not active (`AuditRepo.agentLabelActivity`)                                                                                                                                                                |
| `timeline_filter` | the filter `events` was read with (below)                                                                                                                                                                                                                                                                                                                                               |

`consumed` and `remaining` are read from `session_counters` as they stand, never
recomputed from the audit: a granted claim (period reset, quota extension —
[requests](requests.md)) lowers the counter, so "counted" can go down within a period.
The `reset` and `extension` events of the timeline carry what was given back per risk
(`credits`), which the page shows as "+N given back"; an expiry extension shows the new
date. `countersAgreeWithAudit` is the check `counted + credited == audited`.

**The gate of a risk is two facts.** `gate` is the mission's own setting (`auto` or
`approval`); `gate_open_until` is the end of the period the creator opened it for
("open the gate for the rest of the period", spec §3.5), `null` otherwise. Both come
from `MissionDetailRisk` ([missions](missions.md)). The row of the permission
(`data-permission="<risk id>"`, under "Permissions and usage") says "runs freely" or
"ask me first" and, while the gate is open for the period, "runs freely until
`<date>`": "ask me first" alone would be wrong while calls pass.

### The page (`app/(app)/missions/[id]/session/page.tsx`)

`/missions/<id>/session` reads as "Activity of `<mission>`", on the wide measure
(handbook [missions](missions.md), "The activity of a mission", for its composition):
what waits (`open-requests`), who called per key holder (`holder-activity`) and per
agent label (`label-activity`), the timeline (`timeline`, an `ActivityTable` of five
columns: when, who, action, permission, outcome), and — one click away — the
permissions with what was used (`session-permissions`) and the earlier periods
(`session-periods`). The link "Full record of this mission" leads to
`/activity?mission=<id>`.

What a row of the timeline says of an event is `eventWords(event, { requestOpen })`
(`session/event-words.ts`, pure): the outcome in words with its tone, and detail lines
(`{ text, at, mono }`: `at` is an instant the page prints in the reader's time zone,
`mono` marks an identifier such as a refusal code or a masked key). It switches over
`SessionEventKind`; a kind a later version wrote (`isKnown` is false) is
printed as it is stored.

| Kind                       | The row says                                                                                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `call-allowed`             | "allowed" (and that a yes was used, when the call consumed an approval)                                                                                                                   |
| `call-refused`             | "asked first" in amber for `approval-required`, "limit reached" for `budget-exhausted`, otherwise "refused" in red, with the code in mono                                                 |
| `request`                  | "asked for a yes" / "asked for more room", amber while it waits, with the link to the page that answers it for the creator; once closed, "refused by the creator" or "expired unanswered" |
| `approval`                 | "approved", usable until an instant                                                                                                                                                       |
| `gate-opened`              | "runs freely" until the end of the period                                                                                                                                                 |
| `gate-changed`             | "set to “ask me first”" or "set to “runs freely”", with what it was                                                                                                                       |
| `reset`, quota `extension` | "limits reset" / "limit raised", one line per risk with what was given back                                                                                                               |
| expiry `extension`         | "given more time", with the new date                                                                                                                                                      |
| `rotation`                 | "key generated" / "key replaced", with the masked key and its holder                                                                                                                      |
| `revocation`               | "key revoked" for one key, "mission stopped" for all of them                                                                                                                              |

A member reads the same timeline without the links that answer a request
(`open_requests[].path` is `null` for them): the page says that requests are the
creator's (`requests-are-the-creators`).

The wording is the page's and is tested beside it
(`app/(app)/missions/[id]/session/event-words.test.ts`); the server holds no sentence
for an event of the timeline, only the typed fields of `SessionEventView`.

The table has a fixed budget of five columns and its ids and details wrap, so every
column is on screen at 1280 px; the browser suite asserts it, on the seeded day and on
a timeline that holds gate and approval details.

### Key holders on the activity of a mission

Who called, authenticated by the token (spec §4.2 "Mission session … and calls per token
holder"). Two reads, both informational, the counterparts of the agent-label ones below:

- **Who called — current period** (`holder_activity`). Counts of the
  mission's audit entries of the current period grouped by `(token_kind, token_holder)`
  and decision. **Counts, not limits**: every token of a mission draws from the same
  counters (spec §3.2), and the section says so. Each row links to the timeline of that
  holder and, for the creator, to the Activity page filtered on it.
- **Timeline filter**: `/missions/<id>/session?holder=member:<user id>` or
  `?holder=named:<name>` lists the call events made with a token of that holder
  (`SessionTimelineFilter` kind `holder`). It is a keyset read on the columns
  `events.token_kind` / `events.token_holder` (migration `0010`, index
  `events_session_holder_ts`), like the per-label one.

The "who" column of the timeline names the holder: the member's email, or the name of
a machine key — on a call, and on a `rotation` or a `revocation` of one token. It is
empty for every other event, for a mission-wide `revocation`, and for a call stored
before tokens had a holder. The holder of
an event is read from its details through `parseEventDetails` (`holderRefOf`) and resolved
to a label by the service; the columns only select rows.

### Agent labels on the activity of a mission

A label is what a caller declared about itself (handbook
[execution-door](execution-door.md), "Agent label"): attribution, never an identity, with
no effect on what is allowed or counted. The page says so where it shows one, and both
reads below are informational.

- **Agents — current period** (`label_activity`). Counts of audit entries
  of the mission with `ts` in the current period (`[period.start, period.end)`, open-ended
  for a one-off mission), grouped by `agent_label` and decision. It is **not a budget**:
  the quota is per risk and shared by every agent (spec §3.2), a call touching two risks
  is one call here and two decrements there, and a granted claim lowers a counter without
  removing a call. The section states it ("not verified, and it decides nothing"), and
  the permissions with what was used are unchanged by any filter. Each row links to the
  timeline of that label and, for the creator and a labelled row, to the Activity page
  filtered on it.
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
index `events_session_label_ts`. There is no scan and no bound: the link to earlier events is offered when,
and only when, an older matching call exists. The event view still reads the label from
the details (`parseEventDetails`); the column only selects the rows.

## Retention (`retention.ts`)

`AuditRetentionSweeper` calls `store.audit.purgeByRetention(config.retentionDays)` —
the audit's only delete path, bounded by its cutoff and guarded by the triggers — and
then purges the session history of the same age (below). The
composition root awaits `root.audit.retention.start()` before the instance serves (one
sweep at boot), a timer repeats it every `RETENTION_SWEEP_INTERVAL_MS` (one hour), and
`root.close()` stops the timer and waits for a sweep in flight before closing the store.
`retention_days` / `VAUBAAN_RETENTION_DAYS` is the only setting
([configuration](configuration.md)); an entry exactly N days old is kept.

A purge that fails is logged (`audit retention: purge failed`, with `retention_days` and
the error) and retried at the next interval; it never stops the instance. A purge that
removes something logs `audit retention: entries purged` with the count. The timer is
`// single-process only`: a hosted deployment runs `sweep()` from one scheduled job.

### The session history leaves with the audit

The same sweep purges the session history of the same age (spec §6, §8; product
owner's decision of 2026-10-13): a timeline says what the audit says — the tool, the
instant, the holder, the agent label —, so `retention_days` is one promise wherever a
call is written. `SessionHistoryRetention.purge(retentionDays)`
(`budget/retention.ts`) asks the store for the sessions that hold something older than
the cutoff (`SessionsRepo.withHistoryBefore`), computes each mission's current period
(`currentPeriod`, as on every read) and removes, in one transaction per session
(`SessionsRepo.purgeHistory`):

| What               | Removed when                                                                             | Never removed                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `events`           | `ts` older than N days                                                                   | an event of `PERIOD_STATE_EVENT_KINDS` (`gate-opened`, `gate-changed`, `reset`, `extension`) written since the current period started |
| `session_counters` | the period is over **and** ended more than N days ago (`period_start + length < cutoff`) | the counters of the current period; every counter of a one-off mission (its one period never ends)                                    |

The exception is what a decision reads back from the start of the period: a gate
opened "until the period ends" (`openedGatesOf`) and the credits of granted claims
(`countersAgreeWithAudit`). On a period shorter than the retention it never applies;
on a yearly period with a 90-day retention it keeps those few events until the period
turns. Once the period is over they are history and leave like the rest.

Consequences to know:

- The activity of a mission (`/missions/<id>/session`) shows the timeline and the earlier
  periods that are left: after N days a quiet mission's timeline is empty and its
  "Earlier periods" table starts at the retention.
- Requests are not purged: a decided request keeps its row (and never held arguments
  past its decision).
- `countersAgreeWithAudit` holds for a period younger than the retention. On a one-off
  mission older than that, the audit lost entries the counters still count: the check
  reports a mismatch that is the retention, not a fault.

The two purges fail apart: one that throws is logged (`audit retention: purge failed`
or `audit retention: session history purge failed`) and the other still runs. What the
second removed is logged as `audit retention: session history purged` with `events`
and `counters`. `sweep()` still returns the number of audit entries.

## Administrative entries: who writes what

| Act                                                                     | Written by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Object                                                                  |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `connection-created`, `connection-reconnected`, `connection-revoked`    | `ConnectionService` (`start` / `complete` / `revoke`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | the connection                                                          |
| `connection-refused`                                                    | `ConnectionService` (installation not bound to the user)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | the connection, or `not-created:<provider>`                             |
| `resources-discovered`                                                  | `ConnectionService.discover` — outcome, count, error; success and failure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | the connection                                                          |
| `resource-edited`                                                       | `ConnectionService.updateResource` — `before` / `after`: `resource_id`, `ref`, `display_name`, `env`, `hidden`, `owner_metadata`; nothing when the save changed nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | the connection                                                          |
| `connection-transferred`                                                | `ConnectionService.transfer` — `before.owner` / `after.owner`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | the connection                                                          |
| `connection-reassigned`                                                 | `ConnectionService.reassign` (operator) — `before`: the previous owner and status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | the connection                                                          |
| `share-created`, `share-revoked`                                        | `ShareService.share` / `revoke` — target and restriction; a replaced share writes `share-revoked` (`after.replaced_by`) then `share-created` (`before`: the previous restriction) ([authority](authority.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | the share                                                               |
| `group-created`, `group-member-added`, `group-member-removed`           | `GroupService` (`create` / `addMember` / `removeMember`), Administration → Teams; `group-member-added` is written only when the membership was actually added (a repeated add writes nothing)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | the group                                                               |
| `mission-member-added`, `mission-member-removed`                        | `MissionTeamService.addMember` / `removeMember` (the creator, in the interface) — `after` / `before`: `member_user_id`, `member_email`; a removal also `token_revoked_prefix`. Adding a member who still held a working token writes a `mission-token-revoked` entry after it ([missions](missions.md), "Members and tokens")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | the mission                                                             |
| `mission-token-issued`, `mission-token-revoked`                         | `MissionTeamService.generateToken` (a member's first token; a later one is `mission-rotated`), `createNamedToken`; `revokeToken` (`after.reason`: `by-holder` / `by-creator`), `addMember` when the user added still held a working token (`member-removed`) and `revokeTokensOfDeactivated` (`holder-deactivated`, in the operator's name, at a deactivation and for whatever a reactivation still finds) — `token_prefix`, `token_kind`, `holder`; never a secret. A token insert the store refused (`TokenNotIssuableError`) writes nothing                                                                                                                                                                                                                                                                 | the mission                                                             |
| `mission-issued`, `mission-rotated`, `mission-revoked`                  | `MissionService` (`issue` / `duplicate`, `rotate`, `revoke`), from the interface or from the management door's `issue_mission`, `rotate_mission_token`, `revoke_mission`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | the mission                                                             |
| `gate-changed`                                                          | `MissionService.setGate` — `before` / `after`: `risk_id`, `gate`, and `open_for_period` (`true` → `false`) when `approval` was asked on a gated risk whose gate was open for the period, on an active or an expired mission; nothing when neither the gate nor an opening changed ([missions](missions.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | the mission                                                             |
| `mission-orphaned`, `mission-restored`                                  | `MissionGrounds` (`watchConnection` / `watchCreator` → `settle(actorId)`), around a share, a revocation, a transfer, a reassignment, a group edit, a sign-in or the deactivation or reactivation of a user — `before` / `after`: `status` and, on the orphaned side, `cause`, `connection_id`, `uncovered`. Written through `AuditRepo.appendUnlessLatest`: when two acts under way at once see the same change, the entry is written once and names the act that settled first                                                                                                                                                                                                                                                                                                                                | the mission                                                             |
| `period-reset`, `budget-extended`, `expiry-extended`, `request-refused` | `RequestService.decideClaim` ([requests](requests.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | the request                                                             |
| `approval-granted`, `gate-opened`, `request-refused`                    | `RequestService.decideApproval` — `after`: `mission_id`, `risk_id`, `tool`, `fingerprint`, the resolution and its approval or period; never the arguments                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | the request                                                             |
| `delegation-granted`                                                    | `AuthorizationService.decide` — the user approved a consent screen; `after`: `client_id`, `client_name`, `scope`, `redirect_uri`, `resource` ([management-door](management-door.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | the delegation                                                          |
| `delegation-revoked`                                                    | `DelegationService.revoke` (the user), `TokenService` (the client signed out, or a refresh token or code was replayed), `ClientRegistry.decide` (an operator disabled the client), `DelegationService.revokeAllOf` (an operator deactivated the user) — `after.reason`: `user`, `client`, `refresh-token-replay`, `authorization-code-replay`, `operator`, `user-deactivated`; after a replay `after.missions_to_review` names the missions the delegation issued that still run ([management-door](management-door.md))                                                                                                                                                                                                                                                                                       | the delegation                                                          |
| `oauth-client-approved`, `oauth-client-disabled`                        | `ClientRegistry.decide` (Administration → Registered apps) — `before` / `after`: the status, the client id, name and redirect URIs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | the OAuth client (`oauth-client`)                                       |
| `user-deactivated`, `user-reactivated`                                  | `UserAdminService.deactivate` / `reactivate` (Administration → People) — deactivation: `before`: `status`, `email`; `after`: `status`, `groups_left`, `delegations_revoked`, `member_tokens_revoked`; reactivation: `before`: `status`, `removed_at`; `after`: `status`, `email`. The delegations revoked, the member tokens revoked (`mission-token-revoked`) and the missions orphaned or restored have their own entries. A reactivation first closes what a half-failed deactivation left open (`closeHeldBy`): whatever it still finds is written as the same `delegation-revoked` / `mission-token-revoked` entries, before `user-reactivated`; when a closing step fails there is no `user-reactivated` entry — the user stays deactivated ([authentication](authentication.md), "Deactivating a user") | the user                                                                |
| `config-changed`                                                        | the Administration handlers (`saveProviderApp`, `saveIdpSettings`, the telemetry toggle `setEnabled`) and `completeLogin` when the first operator sign-in revokes the bootstrap token                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `instance-config`: `provider-app:<id>`, `idp`, `telemetry`, `bootstrap` |

A resource edit and a discovery name the **connection** as their object so that the
connection filter and the owner's visibility find them with no join; the resource is in
`before` / `after`. A request decision names the request; the search resolves it to its
mission through `requests.mission_id`.

The actor of an administrative entry is stored as `user_id`: a user id, or
`BOOTSTRAP_ACTOR_ID` (`'bootstrap'`, `packages/gateway-core/src/audit.ts`) for the holder
of the bootstrap token, who has no user row. `AuditAdminView.actor` is
`{ id, email, label }`, built by `actorView` (`query-service.ts`); `label` is what the
Activity page prints: the user's email, else `BOOTSTRAP_ACTOR_LABEL` ("Bootstrap operator")
when the id is `BOOTSTRAP_ACTOR_ID` (its `email` is `null`), else the raw id (a user
whose row is gone).

An act that came through the management door keeps the user as its actor and also
carries `delegated_client_id`, the OAuth client that performed it
([management-door](management-door.md)); it is `null` for an act of the interface.
`AuditAdminView.delegated_client_id` exposes it and the Activity page says "through
`<client id>`" under who made the change.

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
| `user`            | the user's email                                                                                |
| `delegation`      | the name of the client the delegation was given to                                              |
| `request`         | `the limit of <mission name>` (a claim) / `a call of <mission name>` (an approval request)      |
| `instance-config` | none: the id is the name (`idp`, `telemetry`, `bootstrap`, `provider-app:<id>`)                 |

`objectLabel` is a `switch` over `AdminObjectType` with one case per member and no
`default`: an object type added to gateway-core does not compile until it has a label
(or says why it has none). A label widens nothing: the store filtered the entries before
they were turned into views, and a label names only the object of an entry the viewer was
given.

The structural test `tests/integration/audit/admin-mutations.test.ts` reads, with the
TypeScript parser, the public methods of every class under
`server/{connections,provider-apps,missions,auth,requests,telemetry,authority,shares,groups,users,oauth-as,management}`;
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
- **What a permission used on the mission's activity page disagrees with the record** → `countersAgreeWithAudit`
  ([budget-and-sessions](budget-and-sessions.md)).
- **A call is missing from the timeline of its label** → the filter reads the column,
  not the details: `SELECT kind, agent_label, details_json FROM events WHERE id = ?`.
  A call event whose `agent_label` column is `NULL` while its details carry a label was
  written outside the sessions repository (the only writer, which fills the column).
- **A permission reads "ask me first" and calls pass** → `gate_open_until` on the risk row: the
  creator opened the gate for the period; the `gate-opened` event of the timeline says
  until when, and a later `gate-changed` ends it.

## Tests

- `src/server/audit/filters.test.ts` (24) — every filter, repeated and blank values,
  closed sets, unreadable dates, reversed period, single day, oversized value, cursor
  round trip and refusals, `auditQueryString`, `scopeOf` for the three viewers,
  `withoutArguments`.
- `src/app/(app)/missions/[id]/session/event-words.test.ts` (8) — what a row of the
  timeline says, kind by kind, in the words of the interface.
- `tests/integration/audit/audit-query.test.ts` (35) — visibility (creator, connection
  owner, owning group, operator, bootstrap operator, requests of a mission), "a filter
  never widens the scope", the label of the object of an entry for each of the nine
  object types (and `null` for an object that is gone), each filter (the agent label:
  exact, calls only, inside the scope; the token holder: by email, by name, by the exact
  form, never across kinds, inside the scope) and their combination, remaining budget per call,
  keyset paging (page sizes, no repeat, equal timestamps, concurrent write), no raw
  argument for any viewer, filter options.
- `tests/integration/audit/mission-session.test.ts` (21) — a member reads the whole
  session attributed per holder, with no link to answer a request, and loses it when
  removed; for a non-member, creator only; before the
  first call, counters / remaining / exhausted, past periods, one-off mission, open
  requests by link, tool and resource (never a fingerprint or an argument), decided request, agent labels, calls per label for the current
  period (allowed, refused, unlabelled, past periods left out, nothing when inactive,
  the counters unchanged), the timeline filtered by label and to unlabelled calls, the
  calls of one label paged among more than two thousand events of other labels (order,
  no repeat, none skipped), until when a gate is open and the typed fields of each
  approval, gate, rotation and revocation event, timeline content and paging, revoked
  mission, `eventView`.
- `tests/integration/audit/events-agent-label.test.ts` (3) — migration `0008`: the
  backfill of the events an earlier image stored (labelled, unlabelled, empty, not a
  string, not a call, malformed JSON, no details) and its index; the copy made at insert
  (`agentLabelColumn`); `listRecentEvents` filtered on a label and on no label, with the
  keyset.
- `tests/integration/audit/session-history-retention.test.ts` (11) — the session history leaves with the audit:
  events, past-period counters, what a current period keeps, one-off missions, the sweeper wiring
- `tests/integration/audit/retention.test.ts` (10) — purge of entries older than N days
  and of nothing else (other tables untouched, boundary kept), triggers still forbidding
  update and delete, idempotence, configured days, scheduling (boot sweep, interval,
  stop, failure logged, shared sweep), wiring in the composition root.
- `tests/integration/audit/admin-mutations.test.ts` (52) — the structural test above
  (the classification, the list of acts, then one case per mutating method: 45, the
  six methods of `MissionTeamService`, the three mutating tools of the management
  door, the deactivation and reactivation of a user and
  `DelegationService.revokeAllOf` included), an approval request decided
  by each of its three resolutions through either entry point (3), plus `before` /
  `after` of a resource edit and a failed discovery.
- `tests/e2e/v5/audit-session.spec.ts` (4, Playwright on the ephemeral instance) — a day
  of calls on the mission's activity page (what waits, who called per agent label, the
  timeline of one label and back to the whole one) and on the Activity page (the words
  of a line, "asked you" for a call that had to ask, six columns and a seventh behind
  "Show details", the detail of a line at its own address with the fingerprint, the
  period and four controls on one line with the rest behind "More filters"); every
  column of the record on screen at 1280 px with a detail open and no sideways scroll;
  every column of the mission's timeline on screen at 1280 px; 404 for a mission that
  is not the user's.
- `tests/e2e/v5/approve-action.spec.ts` (its first test of 2) asserts the rest of this
  page in a browser: the permission reading "ask me first" and "runs freely until" while
  the gate is open, and no switch there; what the `gate-opened` and `gate-changed` events
  say on the timeline ("runs freely … without asking until", "set to “ask me first”" with
  what it was); and that timeline fitting the window at 1280 px
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
