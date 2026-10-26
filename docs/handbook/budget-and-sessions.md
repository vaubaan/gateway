---
title: Budget and sessions — decision core, session service, rate windows
status: current
date: 2026-10-13
last_synced: 2026-10-24
tracks:
  - apps/gateway/src/server/budget/
  - apps/gateway/src/server/rate-limit/
  - apps/gateway/src/server/store/repositories/sessions.ts
  - apps/gateway/src/server/store/repositories/approvals.ts
  - apps/gateway/src/server/store/repositories/requests.ts
  - apps/gateway/tests/unit/server/budget/
  - apps/gateway/tests/unit/server/rate-limit/
  - apps/gateway/tests/integration/budget/
  - packages/gateway-core/src/pipeline.ts
  - packages/gateway-core/src/fingerprint.ts
  - packages/gateway-core/tests/unit/fingerprint.test.ts
  - apps/gateway/src/server/compose/root.ts
---

# Budget and sessions — decision core, session service, rate windows

How a `tools/call` that passed the risk check is counted against its mission's budget:
the pure decision, the store-backed service that applies it atomically, the in-memory
rate windows, the mission state derivation and the counters-vs-audit check.
Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §2.3 (mission states), §3.2 (the
budget), §3.3 (the session), §3.4–3.5 (claims and approvals), §6 ("authoritative, atomic
counting"), §10 (budget and structural tests). Decision:
[atomic-budget-accounting](../decisions/atomic-budget-accounting.md). Built on the store's
decision primitive ([store](store.md)) and gateway-core's `BudgetStage` hook
([gateway-core](gateway-core.md)).

## Layout

```
apps/gateway/src/server/budget/
  index.ts            barrel
  errors.ts           BudgetInvariantError (not a refusal: an upstream guarantee failed)
  period.ts           PeriodSpec, CurrentPeriod, periodIndex(), currentPeriod(), periodSpecOf()
  fingerprint.ts      re-exports canonicalJson(), fingerprintArguments() from @vaubaan/gateway-core
  decide.ts           decide(input) → Allow | Refuse   (pure, no IO)
  gates.ts            GATE_EVENT_KINDS, openedGatesOf(events, period) — the gates opened for the period;
                      effectiveGate(entry, openedGates) — the gate that applies to a risk now          (pure)
  mission-state.ts    deriveMissionState(), consumedInPeriod()  — revoked | orphaned | expired | active (+ exhausted risks)
  mapping.ts          store records ⇄ domain: BudgetMission, budgetMissionOf(), policyEntryOf() /
                      policyEntryRecordOf(), periodOf() / statedPeriodOf() / budgetPeriodOf(),
                      sessionCounterOf(), isStale()
  mission-usage.ts    readMissionUsage(), missionUsageReader()  — "load counters, derive state", once
  session-service.ts  SessionService.recordCall() / stateOf() / usageOf()  — runs decide() in the store transaction
  budget-stage.ts     createBudgetStage({ service, missions }) — gateway-core's BudgetStage
  consistency.ts      countersAgreeWithAudit(), CREDIT_EVENT_KINDS  — SUM(session_counters) + credits == COUNT(audit allowed)
apps/gateway/src/server/rate-limit/
  index.ts
  sliding-window.ts   SlidingWindowRateLimiter (SlidingWindows peek/push + RateLimiter take), rateWindowKey()
```

Dependencies: `@vaubaan/shared` (the policy vocabulary, `RiskId`, `Period`,
`SessionEventKind`), `@vaubaan/gateway-core` (`refuse.*` builders, `BudgetStage`,
`BudgetDecision`, `MissionContext`), the store (`SessionsRepo`, `RequestsRepo`,
`MissionsRepo`, record types) and the composition root's `RateLimiter` port. No HTTP, no
plugin, no `next`.

## Vocabulary and the three dimensions

A mission policy is `readonly MissionPolicyEntry[]`, one entry per accepted risk:
`{ risk_id, quota, rate_limit: { max, window_seconds }, gate: 'auto' | 'approval' }`
(`@vaubaan/shared`). The budget reads it as is; the store's camelCase
`MissionPolicyEntry` (`rateLimit`, `rateWindowSeconds`) is translated once by
`policyEntryOf` (`mapping.ts`). `BudgetMission` is what the service needs of a mission:
`{ id, status, expires_at, period: PeriodSpec, policy }`, built from a `MissionRecord` by
`budgetMissionOf`.

### The one translation point (`mapping.ts`)

`mapping.ts` is the only place where a mission's store record becomes a domain value, or
the reverse, for the budget **and** for missions (handbook [missions](missions.md),
"Records and views"); a connection's own shapes are `connections/mapping.ts`.

| Function                     | From → to                                                                                     | Used by                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `policyEntryOf(record)`      | store entry → shared `MissionPolicyEntry`                                                     | budget, missions, execution door, requests          |
| `policyEntryRecordOf(entry)` | shared `MissionPolicyEntry` → store entry (the inverse, same file)                            | `MissionService.issue`                              |
| `periodOf(record)`           | `periodAnchor` / `periodSeconds` → shared `Period` (the pipeline's; anchor only if recurring) | `loadMissionContext`                                |
| `statedPeriodOf(record)`     | → `StatedPeriod` `{ kind, length_seconds? }`, no anchor                                       | drafts, detail page, kit, `mission-issued` audit    |
| `budgetPeriodOf(record)`     | → `PeriodSpec` `{ anchor_at, length_seconds \| null }`                                        | `budgetMissionOf`                                   |
| `sessionCounterOf(record)`   | `SessionCounterRecord` → shared `SessionCounter`                                              | `mission-usage.ts`, `consistency.ts`                |
| `isStale(resource)`          | `staleSince !== null`                                                                         | `loadMissionContext`, mission detail, `draftFrom`   |
| `budgetMissionOf(record)`    | `MissionRecord` → `BudgetMission`                                                             | missions, requests, execution door (catalog), tests |

Still outside it: `budget-stage.ts` rebuilds a `PeriodSpec` from the pipeline's `Period`
(`periodSpecOf`) and re-reads the mission row for a one-off anchor — the shared one-off
`Period` carries none (open question of the ADR). The store's camelCase entry is named
`MissionPolicyEntry` like the shared type; the store's name is its contract, so this
module aliases it (`MissionPolicyEntryRecord`) instead of renaming it.

| Dimension | Where its state lives                                                           | Refusal             |
| --------- | ------------------------------------------------------------------------------- | ------------------- |
| quota     | `session_counters(session_id, risk_id, period_start, consumed)` — durable       | `budget-exhausted`  |
| rate      | in-memory sliding window keyed `mission:<id>:risk:<risk_id>`                    | `rate-limited`      |
| gate      | the policy entry (`approval`), the `approvals` table, the session's gate events | `approval-required` |

**One action** = one allowed call touching the risk: `risks_touched` is de-duplicated
(`distinctRisks`), every distinct risk's counter gains one, a refused call changes nothing
anywhere — not the counters, not the windows, not the approvals.

## Period arithmetic (`period.ts`)

`PeriodSpec = { anchor_at, length_seconds | null }`. `currentPeriod(spec, now)` returns
`{ index, start, end }`: for a recurring mission `index = floor((now - anchor) / length)`
(an instant before the anchor is period 0), `start = anchor + index × length` is the
counters' key and `end = start + length` is the reload instant the refusal shows; for a
one-off mission (`length_seconds: null`) the single period starts at the anchor and
`end` is `null`. Rollover is therefore a matter of key: a call after `end` reads rows under
the new `start`, which do not exist, so every counter is zero (spec §3.3). Nothing runs
in the background; past periods stay readable in `session_counters`.

`periodSpecOf(period, oneOffAnchorAt)` maps the shared `Period`; the one-off variant
carries no anchor, so the caller passes the store's `MissionRecord.periodAnchor`.

## Fingerprint (`fingerprint.ts`)

`fingerprintArguments(args)` = SHA-256 hex (64 chars) of `canonicalJson(args ?? {})`:
object keys sorted recursively, arrays in order, `undefined` members dropped, `toJSON`
honoured, no whitespace, BigInt refused. It binds approval requests, approvals and the
`approval-required` refusal (spec §3.5); a replay whose arguments were re-serialized in
another key order matches, a one-byte change does not. The implementation lives in
`@vaubaan/gateway-core` (`fingerprint.ts`), where the pipeline uses the same function for
the audit entry's `arguments_hash`: one hash everywhere (ADR
[upstream-credential-cache-and-rejected-credentials](../decisions/upstream-credential-cache-and-rejected-credentials.md)
D4). This module re-exports it.

## The pure decision (`decide.ts`)

```ts
decide({
  policy,            // MissionPolicy — the entries of the touched risks must exist
  risks_touched,     // RiskId[] (duplicates collapse)
  counters,          // Map<RiskId, consumed this period>   (from the transaction)
  rate_windows,      // Map<RiskId, { count, retry_after_seconds }>  (peeked, not recorded)
  period,            // CurrentPeriod
  fingerprint,
  approvals?,        // Map<RiskId, approval id> valid for this tool and fingerprint (looked up in the transaction)
  opened_gates?,     // Set<RiskId> opened for the period (spec §3.5; `openedGatesOf`, below)
})
// → { kind: 'allow', decrements, remaining, approvals_to_consume }
// → { kind: 'refuse', code: 'budget-exhausted', risk_id, details: { quota, consumed, period_end } }
// → { kind: 'refuse', code: 'rate-limited',     risk_id, details: { limit, retry_after_seconds ≥ 1 } }
// → { kind: 'refuse', code: 'approval-required', risk_id, details: { fingerprint } }
```

Order is **dimension-major**: every touched risk's quota (`consumed >= quota` refuses),
then every rate window (`count >= max`), then every gate (`approval` and not opened and no
approval for this fingerprint). The first failing risk names the refusal; a refusal on one
risk refuses the whole call (spec §3.5). An approved action still passes quota and rate
first ("the gate does not replace the budget"). A touched risk absent from the policy
throws `BudgetInvariantError`: the risk stage guarantees `risks_touched ⊆ accepted`, so
this is a bug, not a budget refusal, and it rolls the transaction back. The caller is
refused all the same: `CallPipeline` runs the budget stage, like the resource and risk
stages, through one `attempt`, and a stage that throws becomes a `rejected` call with its
audit entry — the reason names the stage and the error's class, never its message
(`stageFailureReason`) — while the thrown value goes to the host's log through
`onStageError` ([gateway-core](gateway-core.md); ADR
[decision-stages-fail-closed-and-audited](../decisions/decision-stages-fail-closed-and-audited.md),
D1).

## Gates opened for the period (`gates.ts`)

"On a request, the creator may choose to open the gate for the rest of the period: the
risk switches to `auto` until the next reload, then returns to `approval`. This is a
session event" (spec §3.5). The event is `gate-opened`, written by the request service
([requests](requests.md), "Approvals") with the period it was granted in:
`{ request_id, period_start, period_end }`, the risk in the event's own `risk_id` column.

`effectiveGate(entry, openedGates)` is the one spelling of "the gate that applies to this
risk now" (`approval` unless the policy says `auto` or the creator opened it for the
period): `decide()` gates a call with it and the creator's view of an approval request
shows each touched risk with it ([requests](requests.md)).

`openedGatesOf(events, period)` is pure and returns the `Set<RiskId>` `decide()` takes as
`opened_gates`. It is fed the session's events of `GATE_EVENT_KINDS` (`gate-opened`,
`gate-changed`) about the gated risks of the call, since the period started
(`DecideContext.riskEvents`, read inside the decision transaction). Two rules bound an
opening:

- **the period** — an opening counts only when its `period_start` is the current period's
  start. After the rollover nothing matches: the gate reads `approval` again and nothing
  runs to close it. A one-off mission has no period end, so the request service refuses
  to open a gate on it (`no-period-end`) and no such event exists;
- **a later edit** — `gate-changed` is recorded when the creator sets the risk's gate on
  the mission page ([missions](missions.md), "Editing a gate"), and `permission-removed`
  when an edit of the mission removes the risk (`GATE_EVENT_KINDS` holds the three kinds):
  a permission removed then added again in the period asks again. An opening is in force
  only if no `gate-changed` of that risk has a timestamp greater than **or equal to** its
  own: on a tie the edit wins and the gate stays closed. The edit finds an opening to
  close with this same function over the period that runs now (`currentPeriod`),
  whether or not the mission serves at that instant: an expired mission keeps its gates
  editable, and an opening closed there stays closed if the expiry is extended later in
  the period.

An event whose details do not have the shape of its kind opens nothing
(`parseEventDetails`). The request page and the mission page show "runs freely until …" from the
same function, so they cannot disagree with the decision. An opened gate skips the gate
dimension only: quota and rate are checked first, as for every call, and an approval that
happens to exist for the call is left unconsumed.

## The service (`session-service.ts`)

```ts
const service = new SessionService({
  sessions: store.sessions, // decideAndDecrement, getByMission, counters
  requests: store.requests, // prepareArguments (seals approval-request arguments ahead of the transaction)
  rateWindows: new SlidingWindowRateLimiter(), // the budget's SlidingWindows
  requestUrl: root.requests.requestUrl, // `<public_url>/r/<id>`, the one builder (handbook requests)
  requestExpirySeconds: config.requests.expirySeconds,
  approvalValiditySeconds: config.approvals.expirySeconds, // told to the executor in the refusal
});

const result = await service.recordCall({
  mission, // BudgetMission
  tool,
  args, // fingerprinted here; sealed for an approval request when a touched risk is gated
  risks_touched,
  agent_label, // event attribution only: what the caller declared
  token, // { token_id, token_kind, holder }: whose token it was; event attribution only
  now,
});
```

`recordCall`:

1. computes `currentPeriod(mission.period, now)` and `fingerprintArguments(args)`; if a
   touched risk is gated `approval`, seals the arguments with
   `requests.prepareArguments` (the encryptor is asynchronous, the transaction is not);
2. runs `sessions.decideAndDecrement({ missionId, riskIds, periodStart })`; inside the
   transaction: replaces the quota and the rate of each touched risk of the caller's
   `mission.policy` by the values the store holds now (`ctx.limits` → `livePolicy`; the
   gates are read live too, and a touched risk no longer stored is removed), so a limit the creator changed after
   the mission was loaded is the one that decides — no call decided after the change
   commits passes above it (ADR
   [mission-editable-after-issuance](../decisions/mission-editable-after-issuance.md), which
   supersedes mission-limits-editable-after-issuance);
   then peeks the rate windows of the touched risks, derives the gates opened for
   the period (`ctx.riskEvents` → `openedGatesOf`), looks up the usable approvals of
   the call (`ctx.findApprovals({ tool, fingerprint })`) and reads which of the gated
   risks still closed each one covers — one that covers them all is preferred —, calls
   `decide()`;
3. on **allow**: consumes each distinct approval once (`ctx.consumeApproval(id)`; a
   vanished one is an `InvariantError` that rolls back), pushes `now` into the windows of the decremented
   risks, returns `allow: true` (the primitive increments the counters) and the
   `call-allowed` event;
4. on **refuse**: for `budget-exhausted` reuses the open, unexpired claim of the risk;
   for `approval-required` the open request of the call (tool, fingerprint) that lists
   every gated risk of `details.gated_risks` (`ctx.findOpenRequest`); or drops a new one
   (`ctx.createRequest`, expiry `now + requestExpirySeconds` — an approval request with
   all those risks) with a `request` event; `rate-limited` opens nothing; returns `allow: false` and the
   `call-refused` event;
5. after commit, builds the typed `Refusal` with `refuse.*` (`claim_url` /
   `approval_url` from `requestUrl(request.id)`, `expires_at` from the request,
   `approval_valid_seconds` from the configuration).

**The approval key.** An approval and an approval request are bound to the call:
mission, **tool**, fingerprint (`ApprovedCall`, store migrations 0005 and 0013), and
list the gated risks of that call they cover. The same arguments sent to another tool
find neither the request nor the approval of the first: they ask on their own. **A call
touching several gated risks is refused once, with one request that lists them all**
(`details.gated_risks`, handbook [requests](requests.md), "One request covers the
call"); one grant, one replay. An approval that covers only some of them — granted
before a request covered the call — is found but not consumed until the others are
covered too.

Result: `{ outcome: 'allowed', session_id, period, fingerprint, decrements, remaining,
approval_ids }` (remaining computed from the committed counters) or `{ outcome: 'refused',
session_id, period, fingerprint, refusal, request_id }`.

Events (`events` table, `kind` = shared `SessionEventKind`): `call-allowed`
with `{ tool, fingerprint, risk_ids, agent_label, token_id, token_kind, holder, remaining, approval_ids }`
(the three token fields are absent on an event stored before tokens had a holder; `parseEventDetails` reads both),
`call-refused` with `{ …, refusal_code, request_id }` and `riskId` set to the refusing
risk, `request` with `{ request_id, request_kind, tool, fingerprint }`.

**One contract for event details.** The details of each kind are one type,
`SessionEventDetails` (`packages/shared/src/session-events.ts`): a union of
`{ kind, details }` pairs with the stored snake_case keys. Writers (this service, the
request service, the requests repository's expiry, the mission service and the team service
for `rotation` and `revocation`) build a `NewEvent` (`store/types.ts`) on that union, so a renamed key does not
compile. Readers (the request timeline, the session view, the structural check below) call
`parseEventDetails(kind, details)`, the only code that reads stored details: it answers
`null` for a kind it does not know and for an object that does not have the shape of its
kind. Every kind has a shape: `approval` `{ request_id, approval_id, tool,
fingerprint, expires_at }` and `gate-opened` `{ request_id, period_start, period_end }`
(written by the request service), `gate-changed` `{ gate, gate_before }` (written by the
missions repository in the transaction that edits the gate), `rotation` `{ token_prefix, token_kind, holder,
replaced_prefix }` (a token issued to one holder: the creator's rotation, a member's own token, a named token)
and `revocation` `{ tokens_revoked }`, plus `{ token_prefix, token_kind, holder }` when one token was revoked on
its own (handbook [missions](missions.md), "Members and tokens"); the holder fields are optional when read, so
an event stored before tokens had a holder still parses. A `null` event is shown
with its kind and no detail, and gives back no credit; nothing throws. Stored keys are
part of the data: renaming one needs a migration of the `events` rows.

**One budget per mission, however many agents or tokens** (spec §3.2, §7.9, §7.9 bis).
The session is the mission's and the counters are keyed by session, risk and period:
nothing in a decision reads who the caller says it is, nor whose token it presented. A
mission has one or more tokens, each with one holder — a member, or a named token
(handbook [missions](missions.md), "Members and tokens") — and `recordCall` takes the
call's `token` (`TokenAttribution`, built by the budget stage from the authenticated
`MissionContext`) for one purpose, like the label: the `call-allowed` / `call-refused`
event carries `token_id`, `token_kind` and `holder`. Neither is a key nor an input of
`decide`: two members and a named token on one mission spend the same credits, and
adding a member or a token adds no budget
(`tests/integration/execution/team-door.test.ts`). `agent_label` enters `recordCall` for one purpose, the
`call-allowed` / `call-refused` event it is copied into, and is neither a key nor an input
of `decide`. An orchestrator and its sub-agents, with different labels or with none, draw
from the same counters and the same rate windows; a label cannot reserve, split or widen
a quota, and a label the door rejected is simply `null` here
([execution-door](execution-door.md), "Agent label"). The activity of a mission
(`/missions/<id>/session`) shows the calls of the current period per label next to the counters, as counts of audit entries
and explicitly not as a budget ([audit](audit.md), "Mission session view").

**Not refunded.** The counter increment commits before the upstream call. An upstream
failure leaves `decision: allowed` + `upstream_error` in the audit and the credit
consumed; the creator gives credit back through a claim (ADR). A **streamed** result
changes none of this: the decision and its increment commit before the plugin runs, so
before the first part leaves the gateway; a stream that breaks midway, or whose caller
goes away, is an allowed call with `upstream_error` and its credit stays consumed — the
agent already holds the parts that were sent, and the provider-side effect is as unknown
as for any failed call ([execution-door](execution-door.md), "Streaming"). What happens to the
request after this refusal — who may open its URL, the creator's four answers, their
events, the expiry sweep — is [requests](requests.md).

### Reading the state (`mission-usage.ts`)

"Load the session's counters, derive the state" is written once:
`readMissionUsage(sessions, mission, now)` → `MissionUsage { session_id | null, period,
consumed: Map<RiskId, number>, state }`. It computes the current period first and asks
the store for **that period's counters only** (`sessions.counters(sessionId,
period.start)`), so the read does not grow with the mission's age — a mission with a
one-minute period no longer loads every past minute to discard it.

`SessionService.usageOf(mission, now)` is that function over the service's repository and
`stateOf(mission, now)` is its `state`. The consumers depend on a narrow type and never
re-implement the read:

| Consumer                                                         | Dependency                                     | For                                                                                          |
| ---------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `MissionService` (list, detail, rotate, `stateAfterRefusal`)     | `Pick<SessionService, 'stateOf'>`              | the mission's state                                                                          |
| `MissionTeamService` (team, `generateToken`, `createNamedToken`) | `MissionService.stateOf` / `stateAfterRefusal` | whether a token can be issued now, and the state to report when the store refused the insert |
| `RequestService.view` (the creator's claim and approval pages)   | `Pick<SessionService, 'usageOf'>`              | state, period, consumed per risk, events                                                     |
| the execution door (`GET /mcp/catalog`)                          | `Pick<SessionService, 'stateOf'>`              | state, period and what is left per risk                                                      |

`MissionService` and `RequestService` take it as an optional `budget` dependency (the door is handed the
`SessionService` itself). The gate edit is not in the table: `MissionService.setGate` needs the period, not the
state, and computes it with `currentPeriod`. The composition root builds those two
modules before the `SessionService` (which needs the requests module's `requestUrl`), so
it leaves `budget` out and they default to `missionUsageReader(store.sessions)`: the same
function over the same store, not a second implementation.

## Mission state (`mission-state.ts`)

`deriveMissionState({ status, expires_at, period, policy }, counters, now)`:
`revoked` / `orphaned` / `expired` when the status it is given says so (`revoked` and
`expired` are stored; `orphaned` was derived from the creator's current authority by
`MissionGrounds.inspect` before the mission got here — [authority](authority.md)); `expired` when
`expires_at <= now`; otherwise `{ kind: 'active', period, exhausted: RiskId[], remaining }`
computed from the counters whose `period_start` equals the current period's `start`
(`consumedInPeriod`), so yesterday's exhaustion is gone today without any write.
`remaining` is clamped at 0 (a quota lowered below what was consumed).

## The pipeline stage (`budget-stage.ts`)

`createBudgetStage({ service, missions })` implements gateway-core's `BudgetStage`:
`decide(ctx, call, { risks_touched, now })` builds the `BudgetMission` from the request's
`MissionContext` — `ctx.policy` is the enumeration the risk stage just checked, so both
stages of one call agree — and `periodSpecOf(ctx.mission.period, anchor)`, reading the
mission row (`missions.getById`) only for a one-off mission whose shared `Period` has no
anchor. It maps the result to `BudgetDecision`: `{ outcome: 'allowed', session_id,
remaining, approval_id }` (the first consumed approval; all are on the event) or
`{ outcome: 'refused', refusal }`. `CallPipeline` then forwards upstream and writes the
audit entry with `remaining_budget` and `approval_id` (gateway-core).

`preflight(ctx, call, { risks_touched, now })` asks
`SessionService.preflightLimits`: the same transaction and `decide()`, approvals left
aside, counting nothing. A `budget-exhausted` or `rate-limited` refusal is recorded as
`recordCall` records it (the refused event, the claim request) and returned; anything
else writes nothing and answers `null`. The git door calls it through
`CallPipeline.precheck(…, { limits: true })` before a push's pack leaves for the
provider (handbook [git-remote](git-remote.md#push)).

## Rate windows (`rate-limit/sliding-window.ts`)

`SlidingWindowRateLimiter` keeps, per key, the ascending timestamps of its actions and
prunes that key to its window on every access. Two faces on one state:

- `SlidingWindows` — `peek(key, windowMs, nowMs) → { count, retryAfterMs }` never
  records (`retryAfterMs` = when the oldest action leaves the window); `push(key,
windowMs, nowMs)` records one action. The budget peeks before `decide()` and pushes
  only on allow, inside the transaction callback, so refusals leave windows intact and
  no interleaving fits between probe and record.
- `RateLimiter` (composition root port) — `take(key, limit, windowMs)` checks and
  consumes in one call, for the surface limits of spec §6 (per mission on `/mcp`, per
  user on connect flows, per IP on request pages).

Above `pruneThreshold` keys (10 000) every `push` sweeps keys whose newest action left
their last window. `rateWindowKey(missionId, riskId)` = `mission:<id>:risk:<risk_id>`.

`// single-process only` (module comment and class) — hosted replacement: a Redis
implementation of the same two interfaces, `SlidingWindows` and `RateLimiter`, one sorted
set per key (`ZREMRANGEBYSCORE`, `ZCARD`, `ZADD`, `PEXPIRE` in a Lua script); the budget would probe
before its SQLite transaction and record after commit (ADR). The composition root builds one
`SlidingWindowRateLimiter`: it is the budget's `rateWindows` and, unless a test injects
another `RateLimiter`, the surface limiter of the execution door (`mcp:mission:<id>`,
`mcp-verify:<prefix>:<client ip>`), of the connect flows (`connect:<user>`), of the request page
(`request-page:ip:<ip>`), of the authorization server (`oauth:register…`,
`oauth:token:…`, `oauth:client-document:<requester>`) and of the management door
(every key prefixed `mgmt:`, `compose/management.ts`), on disjoint keys. The root also builds the `SessionService` (`root.budget`) and hands it to
the execution door, which wraps it with `createBudgetStage`
([execution-door](execution-door.md)).

## Structural check (`consistency.ts`)

`countersAgreeWithAudit({ sessions, audit }, mission, now)` returns, per accepted risk,
`counted` (sum of `session_counters.consumed` for the current period, through
`sessionCounterOf` and `consumedInPeriod` like every other reader), `credited` (the
actions granted claims gave back in the period: `details.credits` of the session's
`reset` / `extension` events whose `details.period_start` is the period's, read through
`parseEventDetails` so that an event with malformed details is skipped, see
[requests](requests.md)) and `audited`
(`audit.countAllowedTouches(mission, risk, period.start, period.end ?? open-ended)`), plus
`mismatches` (`counted + credited !== audited`). The integration suite asserts `mismatches` is empty after a mixed run
through the real `CallPipeline` (allowed, failed upstream, exhausted, rate-limited,
approval-required, concurrent burst); an operator diagnostic may run it on a live store.

## What the store gained

`DecideContext` (`store/repositories/sessions.ts`) carries `limits`, the quota, rate and
window of the touched risks read from `mission_policy` in the transaction (a Postgres port
reads them `FOR SHARE`), and has three non-consuming, in-transaction lookups: `findApprovals({ tool, fingerprint })`
(`findApprovalsSync`, `approvals.ts`: every usable approval of the call, soonest-expiring
first, each with the risks it covers), `findOpenRequest(lookup)` (`findOpenRequestSync`,
`requests.ts`; `state = 'open' AND expires_at > now`; a claim by its risk, an approval
request by its tool, its fingerprint and the risks it must list) and `riskEvents({ kinds, riskIds, since })` (the session's events about some
risks, oldest first, details as stored). `consumeApproval(id)` consumes one approval of
the mission by id, once.

A call event is also indexed by who made it. At insert the sessions repository copies, for `call-allowed` and
`call-refused` only, `details.agent_label` into `events.agent_label` (`agentLabelColumn`, migration 0008) and
`details.token_kind` / `details.holder` into `events.token_kind` / `events.token_holder` (`holderColumns`,
migration 0010; `NULL` on every other kind and on a call stored before tokens had a holder). The details stay
the source: the columns are never returned in an `EventRecord`. They serve `listRecentEvents(sessionId, {
calls })`, the timeline of one label (`{ agentLabel }`) or of one token holder (`{ holder: { kind, holder } }`),
through the indexes `events_session_label_ts` and `events_session_holder_ts` ([audit](audit.md), "Mission
session view"). A `rotation` or `revocation` event names its holder in its details only.

## Tests

- `tests/unit/server/budget/period.test.ts` (8) — `periodIndex` across boundaries and
  before the anchor, invalid lengths, `currentPeriod` recurring / one-off / canonical
  anchor / boundary, `periodSpecOf`.
- `packages/gateway-core/tests/unit/fingerprint.test.ts` (12) — the canonical JSON, the fingerprint and
  `unfaithfulArgument` (a value JSON would rewrite), next to their implementation
  ([gateway-core](gateway-core.md)).
- `tests/unit/server/budget/decide.test.ts` (20) — N risks → N decrements, no risk,
  remaining, approval to consume, opened gate; `budget-exhausted` (recurring and one-off),
  whole-call refusal, `rate-limited` (≥ 1 s), `approval-required`, multi-risk gate
  refusal, dimension order, approval does not bypass quota or rate; invariant on an
  unknown risk, inputs not mutated.
- `tests/unit/server/budget/gates.test.ts` (9) — nothing opens without an event; the
  risk the event names, for the period it carries; closed again at the reload instant; an
  opening of the next period; a later edit ends it, a tie closes, a later opening opens
  again; unreadable events open nothing; `decide()` fed with the result (no approval
  consumed, budget still applies).
- `tests/unit/server/budget/mission-state.test.ts` (7) — stored statuses, expiry,
  exhausted per risk, rollover on read, one-off never reloads, clamped remaining,
  `consumedInPeriod`.
- `tests/unit/server/rate-limit/sliding-window.test.ts` (8) — empty window, peek never
  records, sliding drop-out, key independence, invalid window, sweep above threshold,
  the `RateLimiter` port, `rateWindowKey`.
- `tests/integration/budget/session-service.test.ts` (20, `:memory:` store) — session
  born on first call and N counters; refusal decrements nothing and drops one claim with
  `claim_url` and events; replay reuses the open request, a decided one is replaced;
  whole-call refusal; rollover on read; reload hourly vs one-off never; **N=50 concurrent
  `recordCall` on quota 1 → exactly one allow, one claim**; several agent labels share
  counters; rate-limited (no request, no decrement, `retry_after_seconds`, free again
  after the window); refusals record nothing in the windows; approval gate: sealed
  arguments and fingerprint on the request, consumption by an identical replay in another
  key order, single use, exact fingerprint, expiry, whole-call refusal, approved actions
  count against the quota (the creator's decision, the gate opening and the erasure are
  `tests/integration/requests/approval.test.ts`, handbook [requests](requests.md));
  invariant abort leaves no session; `stateOf`; `usageOf` and
  `missionUsageReader` read the current period's counters only (three periods recorded,
  one read, keyed by the current `period_start`).
- `tests/integration/budget/pipeline-consistency.test.ts` (6) — the stage inside the real
  `CallPipeline` with the store's `SqliteAuditWriter`: **`SUM(session_counters) ==
COUNT(audit allowed)` per risk after a mixed run**, a credit event with malformed details
  skipped without throwing, upstream failure keeps the credit, a one-off mission's
  open-ended period, a mission with no session, granted claims
  (`counted + credited == audited`).

## References

- ADR [atomic-budget-accounting](../decisions/atomic-budget-accounting.md);
  [embedded-store-sqlite-and-migrations](../decisions/embedded-store-sqlite-and-migrations.md)
  (the primitive); [pivot-v4-to-v5-on-prem-mission-tokens](../decisions/pivot-v4-to-v5-on-prem-mission-tokens.md)
  D1, D4 and the approval-gate amendment.
- Spec [vaubaan-gateway](../spec/vaubaan-gateway.md) §2.3, §3.2–3.5, §6, §7.5–7.9, §10.
- Neighbouring handbooks: [store](store.md), [gateway-core](gateway-core.md),
  [configuration](configuration.md) (the `RateLimiter` port and the root's wiring).

## Live permission edits

`livePolicy(policy, limits, touched)` preserves untouched lines and rereads the
limits and gate of each touched line inside the decision transaction. A removed
touched line fails closed; it cannot execute using the admission snapshot.

**An edit of the whole mission** ([missions](missions.md), "Editing a mission after
issuance"; ADR mission-editable-after-issuance) changes nothing of this module's rules
and is read the same way: the edit commits in one transaction; a decision after it
reads the new limits, window and gate of each touched risk, and fails closed on one that
was removed. Accepted risks and resources are the caller's context, loaded when the call
starts: an in-flight call past its resource and risk stages keeps that admission, the
next call loads the new mission. Counters are keyed by session, risk and period, none
of which an edit moves — the period is not editable for that reason: changing its length
would move the current period's start, so the counters would either restart at zero (a
hidden reset) or have to be moved to a key where `countersAgreeWithAudit` no longer
holds. A permission added starts with no counter; one removed then added again finds its
counter as it was. A shorter rate window applies at once; a longer one only counts what
the in-memory window still remembered (`peek` prunes to the window it is given), so it
can be slightly lenient for one window's length after the change.
`prepareApprovalArguments` prepares a sealed blob before the transaction for
any nonempty risk set because a human can set a gate while encryption awaits.
The blob is retained only when an approval request is actually created. Policy
edits never reset counters or rate windows.
