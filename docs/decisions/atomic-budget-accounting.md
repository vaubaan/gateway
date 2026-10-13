---
title: Atomic budget accounting — durable counters in one SQLite transaction, in-memory rate windows, rollover on read
status: accepted
date: 2026-10-13
extends:
  - pivot-v4-to-v5-on-prem-mission-tokens
  - embedded-store-sqlite-and-migrations
---

# Atomic budget accounting — durable counters in one SQLite transaction, in-memory rate windows, rollover on read

> Fixes how the budget of the pivot ADR [[pivot-v4-to-v5-on-prem-mission-tokens]] (D4:
> quota, rate limit, period, session) is made authoritative in one process, on top of the
> decision primitive the store ADR [[embedded-store-sqlite-and-migrations]] provides.
> Implemented by feature P1.3 of the v5 plan. Handbook:
> [budget-and-sessions](../handbook/budget-and-sessions.md).

## Context

Spec §3.2 defines the budget as three dimensions per accepted `RiskId` — quota per
period, rate limit per sliding window, gate — and §6 requires "authoritative, atomic
counting: the budget decision and the decrement are a single operation; two concurrent
calls on a quota's last credit produce exactly one allow and one refusal". §3.3 makes the
session the source of truth for the budget and the audit the source of truth for what
happened, with a structural test that the two agree. §3.5 binds approvals to the exact
argument fingerprint. The plan (§3.5) sketches the transaction; it leaves to this ADR:

- where quota counters live (durable in SQLite, or in memory with periodic flush);
- where rate-limit windows live (memory or store);
- how the period rollover is computed (on read, or by a job);
- what "one action" is for a call touching N risks;
- what the canonical argument fingerprint is;
- whether the credit is reserved before the upstream call and what happens when the
  upstream call fails after the decrement.

Constraints: v5 is a single Node process on SQLite (store ADR), with nothing precluding a
hosted deployment later (`_common.md`); the store's `SessionsRepo.decideAndDecrement`
already runs a synchronous callback inside `BEGIN IMMEDIATE` and increments the counters
of the touched risks when the callback allows; the audit is immutable and written once
per call, after the upstream result (store ADR).

## Decision

### Quota counters are durable rows, decided and incremented in one `BEGIN IMMEDIATE` transaction

`session_counters(session_id, risk_id, period_start, consumed)` is the only quota state.
`SessionService.recordCall` does, inside one transaction of the store primitive: session
get-or-create (the session is born on the first call), counter read for the touched risks
and the current period, approval lookup for gated risks, the pure `decide()`, then on
allow the approval consumption, the rate-window record and the counter increments; on
refusal the request drop (or the reuse of the one already open). The event of the call
(`call-allowed` / `call-refused`, plus `request` when one is dropped) is written in the same
transaction. SQLite's single writer plus Node's single thread make "N concurrent calls on
the last credit → exactly one allow" a property of the primitive, not of a lock the
service manages; the integration test runs 50 concurrent `recordCall`s on a quota of 1.

A restart therefore never forgets a consumed credit (spec §3.3). The cost is one write
transaction per allowed call, which a single-company gateway absorbs without notice.

### Rate-limit windows live in memory, probed and recorded inside the same transaction

The sliding window of `(mission, risk)` is a list of timestamps in the process
(`SlidingWindowRateLimiter`, `apps/gateway/src/server/rate-limit/`), `// single-process
only`. The decision **peeks** every touched window without recording, and **records** only
when the call is allowed, inside the synchronous transaction callback, so a call refused on
one risk leaves the windows of the others untouched and no interleaving can slip between
the probe and the record. A restart forgives at most one window of rate (pivot ADR D1
accepts this); it never forgives a quota.

The same class implements the composition root's `RateLimiter` port (`take`, check and
consume in one call) for the surface limits of spec §6, so the gateway has one
sliding-window implementation. A hosted deployment replaces it with a Redis sorted set
per key (`ZREMRANGEBYSCORE`, `ZCARD`, `ZADD`, `PEXPIRE` in one Lua script); the budget
would then probe before its SQLite transaction and record after commit, accepting a
window-wide race the quota does not have.

### Period rollover is computed on read from `(anchor, length, now)`

`currentPeriod(spec, now)` returns the index, start and end of the period `now` falls in;
`start` is the counters' key. A call arriving after the end of a period reads the next
period's counters, which do not exist yet, hence zero (spec §3.3). No job, no reset of
rows, past periods stay readable. A one-off mission has one period starting at its
anchor (the issuance instant the store records in `missions.period_anchor`) and no end:
its `budget-exhausted` refusal carries `period_end: null` and only a claim can reopen a
risk. An instant before the anchor (clock skew between issuance and first call) belongs to
the first period.

Mission state (`active | exhausted(per risk) | expired | orphaned | revoked`, spec §2.3) is
derived the same way (`deriveMissionState`): stored terminal statuses first, then
`expires_at`, then the counters of the current period only.

### One action = one allowed call touching the risk; N risks → N decrements; refused → nothing

Spec §3.2 decides it; the ADR records how: `risks_touched` is de-duplicated (one credit
per distinct risk per call), every distinct risk's counter gains one, and a refusal on any
dimension of any risk refuses the whole call before any increment, approval consumption or
window record. The three dimensions are checked in **dimension-major order** across all
touched risks — every quota, then every rate window, then every gate — so a human is
never asked to approve an action the budget would refuse anyway, and
`budget-exhausted` wins over `rate-limited` wins over `approval-required` when several
apply. An approved action still counts against quota and rate (spec §3.5 "the gate does
not replace the budget"); when a gated risk is both exhausted and unapproved the agent
gets the claim, not an approval request.

### The canonical argument fingerprint is `sha256(canonicalJson(args))`

`canonicalJson` sorts object keys recursively, keeps array order, drops `undefined`
members and emits no whitespace; the fingerprint is the full hex digest (64 characters).
Approval requests, approvals and the `approval-required` refusal all carry it; two argument
objects that differ only in key order (an MCP client re-serializing a replay) share one
fingerprint, a one-byte value change does not (spec §3.5). It is distinct from
`@vaubaan/gateway-core`'s `hashArguments` (sha256 of `JSON.stringify`, 16 hex characters,
order-sensitive), which the audit's `arguments_hash` keeps for v4-comparable rows; whether
the audit should switch to the canonical fingerprint is a P1.6 wiring question (see
Consequences).

### The credit is consumed at decision time and never refunded

The decision transaction commits the increment **before** the upstream call. If the
upstream call then fails, the audit entry keeps `decision: allowed` with `upstream_error`
set (gateway-core convention) and the counter keeps its increment: the spec counts allowed
calls, the gateway did allow, and a refund would require knowing whether the provider
applied the effect before failing (a 502 after a merge is still a merge). Operators read
"allowed with no business effect" as `decision = 'allowed' AND upstream_error IS NOT
NULL`; a creator who wants the credit back grants a claim. The structural check
`SUM(session_counters) == COUNT(audit WHERE decision = 'allowed' AND risk touched)` holds
by construction because both sides count the same event.

### A replayed refusal reuses the open request

An agent that retries a refused call (hints notwithstanding) must not flood the creator's
inbox. Inside the transaction, the service looks for an open, unexpired request of the
same `(mission, kind, risk[, fingerprint])` and puts its URL in the refusal instead of
dropping a new one; once the creator decided, or the request expired, the next refusal
opens a new request. `rate-limited` opens nothing (the agent only has to wait).

### The agent label never reaches the decision

`agent_label` is copied onto the session event and the audit entry; `decide()` does not
receive it. Several agents on one token share the counters (spec §3.2, §7.9); the
integration test checks that three labels consume one budget.

## Consequences

- `apps/gateway/src/server/budget/` holds the pure core (`decide`, `currentPeriod`,
  `periodIndex`, `fingerprintArguments`, `deriveMissionState`), the `SessionService`, the
  pipeline's `BudgetStage` adapter (`createBudgetStage`) and the reusable structural check
  (`countersAgreeWithAudit`); `apps/gateway/src/server/rate-limit/` holds the sliding
  window. Zero HTTP, zero plugin dependency.
- The store's `DecideContext` gained two non-consuming lookups, `findApproval` and
  `findOpenRequest` (additive), so the service can decide before it consumes anything.
- Every allowed call costs one SQLite write transaction and one event row; `events` grows
  with traffic and is subject to the same retention policy as the audit (P2.x sweeper).
- The `BudgetStage` adapter uses the cached `MissionContext`'s policy (the enumeration
  the risk stage just checked) and reads the mission row only for a one-off mission's
  anchor, because the shared `Period` carries no anchor for `one-off`. Making the shared
  `Period` carry `anchor_at` in both variants would remove that read (question for Renaud).
- The audit's `arguments_hash` and the approval fingerprint are two different hashes of
  the same arguments until P1.6 decides whether `CallPipeline` should record the canonical
  fingerprint (spec §3.5 "only their fingerprint remains in the audit" suggests it should).
- The gate-opened-for-the-period event (spec §3.5) is an input of `decide()`
  (`opened_gates`); the service passes none until P2.1 records and reads the event.
- A hosted deployment changes the rate-limit implementation and the transaction
  boundary of the rate record (see above); counters, events, requests and approvals
  move with the store.

## Rejected alternatives

- **In-memory counters with periodic flush.** Faster, but a crash between flushes forgets
  credits, which spec §3.3 forbids; the pivot ADR accepts losing seconds of _rate_, not a
  _quota_. The single-process SQLite write is cheap enough.
- **Durable rate windows (a row per action, or a counter per fixed window).** Durable
  windows survive restarts the spec does not require them to survive, cost a write per
  probe and make the sliding semantics awkward in SQL; the memory window with a
  documented Redis replacement keeps the hot path simple.
- **Fixed-window rate limit for the budget.** The composition root's `MemoryRateLimiter`
  is a fixed window; the spec says "sliding window" and a fixed window lets 2× the limit
  through at a boundary. The sliding window is the one implementation for both uses.
- **Rollover by a scheduled job that resets counters.** A job can be late, a restart can
  miss it, and a reset destroys the history of past periods; arithmetic on read has none
  of these problems.
- **Per-risk check order (quota, rate, gate for risk A, then risk B…).** Would ask the
  creator to approve an action on risk A while risk B is exhausted, then refuse the
  replay for budget. Dimension-major order asks nothing of a human for a dead call.
- **Refunding the credit on upstream failure.** Requires knowing the provider's side
  effect, breaks the counters-vs-audit identity (audit says allowed, counter says not), and
  opens a loophole: an agent could burn an exhausted budget on failing calls. A claim is
  the spec's way to give credit back.
- **Reserve-then-confirm (decrement after the upstream call).** Two concurrent calls on
  the last credit would both pass the check; the spec's atomicity requirement is exactly
  the decrement at decision time.
- **Consuming approvals during the decision loop.** Simpler, but a call touching two gated
  risks with one approval would consume it and still be refused. The non-consuming lookup
  then consume-on-allow keeps approvals intact on refusal.
- **A new request on every refusal.** Simplest, floods the inbox on retries; the open
  request is reused instead.
- **`hashArguments` (16 hex, order-sensitive) as the approval fingerprint.** Order
  sensitivity would make a faithful replay through another serializer ask again, and 16
  hex characters are a weak binding for a single-use grant.
