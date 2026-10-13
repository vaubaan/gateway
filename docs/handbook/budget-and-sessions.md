---
title: Budget and sessions — decision core, session service, rate windows
status: current
date: 2026-10-13
last_synced: 2026-10-13
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
  fingerprint.ts      canonicalJson(), fingerprintArguments()  — sha256 of key-sorted JSON
  decide.ts           decide(input) → Allow | Refuse   (pure, no IO)
  mission-state.ts    deriveMissionState(), consumedInPeriod()  — active | exhausted | expired | …
  mapping.ts          BudgetMission, budgetMissionOf(record), policyEntryOf(), sessionCounterOf()
  session-service.ts  SessionService.recordCall() / stateOf()  — runs decide() in the store transaction
  budget-stage.ts     createBudgetStage({ service, missions }) — gateway-core's BudgetStage
  consistency.ts      countersAgreeWithAudit()  — SUM(session_counters) == COUNT(audit allowed)
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

| Dimension | Where its state lives                                                       | Refusal             |
| --------- | --------------------------------------------------------------------------- | ------------------- |
| quota     | `session_counters(session_id, risk_id, period_start, consumed)` — durable   | `budget-exhausted`  |
| rate      | in-memory sliding window keyed `mission:<id>:risk:<risk_id>`                | `rate-limited`      |
| gate      | the policy entry (`approval`), the `approvals` table, `opened_gates` (P2.1) | `approval-required` |

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
another key order matches, a one-byte change does not. `@vaubaan/gateway-core`'s
`hashArguments` (16 hex, order-sensitive) remains the audit's `arguments_hash` until P1.6
decides otherwise (ADR, Consequences).

## The pure decision (`decide.ts`)

```ts
decide({
  policy,            // MissionPolicy — the entries of the touched risks must exist
  risks_touched,     // RiskId[] (duplicates collapse)
  counters,          // Map<RiskId, consumed this period>   (from the transaction)
  rate_windows,      // Map<RiskId, { count, retry_after_seconds }>  (peeked, not recorded)
  period,            // CurrentPeriod
  fingerprint,
  approvals?,        // Map<RiskId, approval id> valid for this fingerprint (looked up in the transaction)
  opened_gates?,     // Set<RiskId> opened for the period (spec §3.5 gate-opened event; P2.1)
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
this is a bug, not a refusal, and it rolls the transaction back.

## The service (`session-service.ts`)

```ts
const service = new SessionService({
  sessions: store.sessions, // decideAndDecrement, getByMission, counters
  requests: store.requests, // prepareArguments (seals approval-request arguments ahead of the transaction)
  rateWindows: new SlidingWindowRateLimiter(), // the budget's SlidingWindows
  requestUrl: (id) => `${config.publicUrl.origin}/r/${id}`, // never hard-coded
  requestExpirySeconds: config.requests.expirySeconds,
});

const result = await service.recordCall({
  mission, // BudgetMission
  tool,
  args, // fingerprinted here; sealed for an approval request when a touched risk is gated
  risks_touched,
  agent_label, // event attribution only
  now,
});
```

`recordCall`:

1. computes `currentPeriod(mission.period, now)` and `fingerprintArguments(args)`; if a
   touched risk is gated `approval`, seals the arguments with
   `requests.prepareArguments` (the encryptor is asynchronous, the transaction is not);
2. runs `sessions.decideAndDecrement({ missionId, riskIds, periodStart })`; inside the
   transaction: peeks the rate windows of the touched risks, looks up a valid approval per
   gated risk (`ctx.findApproval`), calls `decide()`;
3. on **allow**: consumes each approval (`ctx.consumeApproval`; a vanished one is an
   `InvariantError` that rolls back), pushes `now` into the windows of the decremented
   risks, returns `allow: true` (the primitive increments the counters) and the
   `call-allowed` event;
4. on **refuse**: for `budget-exhausted` / `approval-required` reuses the open, unexpired
   request of the same `(kind, risk[, fingerprint])` (`ctx.findOpenRequest`) or drops a new
   one (`ctx.createRequest`, expiry `now + requestExpirySeconds`) with a `request` event;
   `rate-limited` opens nothing; returns `allow: false` and the `call-refused` event;
5. after commit, builds the typed `Refusal` with `refuse.*` (`claim_url` /
   `approval_url` from `requestUrl(request.id)`, `expires_at` from the request).

Result: `{ outcome: 'allowed', session_id, period, fingerprint, decrements, remaining,
approval_ids }` (remaining computed from the committed counters) or `{ outcome: 'refused',
session_id, period, fingerprint, refusal, request_id }`.

Events (`events` table, free-form `kind` = shared `SessionEventKind`): `call-allowed`
with `{ tool, fingerprint, risk_ids, agent_label, remaining, approval_ids }`,
`call-refused` with `{ …, refusal_code, request_id }` and `riskId` set to the refusing
risk, `request` with `{ request_id, request_kind, tool, fingerprint }`.

**Not refunded.** The counter increment commits before the upstream call. An upstream
failure leaves `decision: allowed` + `upstream_error` in the audit and the credit
consumed; the creator gives credit back through a claim (ADR).

`stateOf(mission, now)` reads the session's counters and returns
`deriveMissionState(...)`.

## Mission state (`mission-state.ts`)

`deriveMissionState({ status, expires_at, period, policy }, counters, now)`:
`revoked` / `orphaned` / `expired` when the stored status says so; `expired` when
`expires_at <= now`; otherwise `{ kind: 'active', period, exhausted: RiskId[], remaining }`
computed from the counters whose `period_start` equals the current period's `start`
(`consumedInPeriod`), so yesterday's exhaustion is gone today without any write.
`remaining` is clamped at 0 (a quota lowered below what was consumed).

## The pipeline stage (`budget-stage.ts`)

`createBudgetStage({ service, missions })` implements gateway-core's `BudgetStage`:
`decide(ctx, call, { risks_touched, now })` builds the `BudgetMission` from the cached
`MissionContext` — `ctx.policy` is the enumeration the risk stage just checked, so both
stages of one call agree — and `periodSpecOf(ctx.mission.period, anchor)`, reading the
mission row (`missions.getById`) only for a one-off mission whose shared `Period` has no
anchor. It maps the result to `BudgetDecision`: `{ outcome: 'allowed', session_id,
remaining, approval_id }` (the first consumed approval; all are on the event) or
`{ outcome: 'refused', refusal }`. `CallPipeline` then forwards upstream and writes the
audit entry with `remaining_budget` and `approval_id` (gateway-core).

## Rate windows (`rate-limit/sliding-window.ts`)

`SlidingWindowRateLimiter` keeps, per key, the ascending timestamps of its actions and
prunes them to the window on every access. Two faces on one state:

- `SlidingWindows` — `peek(key, windowMs, nowMs) → { count, retryAfterMs }` never
  records (`retryAfterMs` = when the oldest action leaves the window); `push(key,
windowMs, nowMs)` records one action. The budget peeks before `decide()` and pushes
  only on allow, inside the transaction callback, so refusals leave windows intact and
  no interleaving fits between probe and record.
- `RateLimiter` (composition root port, P0.4) — `take(key, limit, windowMs)` checks and
  consumes in one call, for the surface limits of spec §6 (per mission on `/mcp`, per
  user on connect flows, per IP on request pages).

Above `pruneThreshold` keys (10 000) every `push` sweeps keys whose newest action left
their last window. `rateWindowKey(missionId, riskId)` = `mission:<id>:risk:<risk_id>`.

`// single-process only` — hosted replacement: one Redis sorted set per key
(`ZREMRANGEBYSCORE`, `ZCARD`, `ZADD`, `PEXPIRE` in a Lua script); the budget would probe
before its SQLite transaction and record after commit (ADR). The root still wires P0.4's
fixed-window `MemoryRateLimiter` for the surface limits until the door (P1.6) composes the
budget; both satisfy the port.

## Structural check (`consistency.ts`)

`countersAgreeWithAudit({ sessions, audit }, mission, now)` returns, per accepted risk,
`counted` (sum of `session_counters.consumed` for the current period) and `audited`
(`audit.countAllowedTouches(mission, risk, period.start, period.end ?? open-ended)`), plus
`mismatches`. The integration suite asserts `mismatches` is empty after a mixed run
through the real `CallPipeline` (allowed, failed upstream, exhausted, rate-limited,
approval-required, concurrent burst); an operator diagnostic may run it on a live store.

## What the store gained

`DecideContext` (`store/repositories/sessions.ts`) has two additive, non-consuming,
in-transaction lookups: `findApproval(riskId, fingerprint)` (`findApprovalSync`,
`approvals.ts`) and `findOpenRequest({ kind, riskId, fingerprint? })`
(`findOpenRequestSync`, `requests.ts`; `state = 'open' AND expires_at > now`, the
fingerprint applies to approval requests only). Nothing was renamed.

## Tests

- `tests/unit/server/budget/period.test.ts` (8) — `periodIndex` across boundaries and
  before the anchor, invalid lengths, `currentPeriod` recurring / one-off / canonical
  anchor / boundary, `periodSpecOf`.
- `tests/unit/server/budget/fingerprint.test.ts` (8) — key sorting, `undefined` and
  array holes, `toJSON`, primitives, BigInt refused, sha256 vector, key order vs value
  change, no-arguments, contrast with `hashArguments`.
- `tests/unit/server/budget/decide.test.ts` (15) — N risks → N decrements, no risk,
  remaining, approval to consume, opened gate; `budget-exhausted` (recurring and one-off),
  whole-call refusal, `rate-limited` (≥ 1 s), `approval-required`, multi-risk gate
  refusal, dimension order, approval does not bypass quota or rate; invariant on an
  unknown risk, inputs not mutated.
- `tests/unit/server/budget/mission-state.test.ts` (7) — stored statuses, expiry,
  exhausted per risk, rollover on read, one-off never reloads, clamped remaining,
  `consumedInPeriod`.
- `tests/unit/server/rate-limit/sliding-window.test.ts` (8) — empty window, peek never
  records, sliding drop-out, key independence, invalid window, sweep above threshold,
  the `RateLimiter` port, `rateWindowKey`.
- `tests/integration/budget/session-service.test.ts` (19, `:memory:` store) — session
  born on first call and N counters; refusal decrements nothing and drops one claim with
  `claim_url` and events; replay reuses the open request, a decided one is replaced;
  whole-call refusal; rollover on read; reload hourly vs one-off never; **N=50 concurrent
  `recordCall` on quota 1 → exactly one allow, one claim**; several agent labels share
  counters; rate-limited (no request, no decrement, `retry_after_seconds`, free again
  after the window); refusals record nothing in the windows; approval gate: sealed
  arguments and fingerprint on the request, consumption by an identical replay in another
  key order, single use, exact fingerprint, expiry, whole-call refusal, approved actions
  count against the quota; invariant abort leaves no session; `stateOf`.
- `tests/integration/budget/pipeline-consistency.test.ts` (4) — the stage inside the real
  `CallPipeline` with the store's `SqliteAuditWriter`: **`SUM(session_counters) ==
COUNT(audit allowed)` per risk after a mixed run**, upstream failure keeps the credit, a
  one-off mission's open-ended period, a mission with no session.

## References

- ADR [atomic-budget-accounting](../decisions/atomic-budget-accounting.md);
  [embedded-store-sqlite-and-migrations](../decisions/embedded-store-sqlite-and-migrations.md)
  (the primitive); [pivot-v4-to-v5-on-prem-mission-tokens](../decisions/pivot-v4-to-v5-on-prem-mission-tokens.md)
  D1, D4 and the approval-gate amendment.
- Spec [vaubaan-gateway](../spec/vaubaan-gateway.md) §2.3, §3.2–3.5, §6, §7.5–7.9, §10.
- Neighbouring handbooks: [store](store.md), [gateway-core](gateway-core.md),
  [configuration](configuration.md) (the `RateLimiter` port and the root's wiring).
