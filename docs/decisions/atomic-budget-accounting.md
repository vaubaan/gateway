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

What counts as a label, and what happens to a value that is not one, is the amendment
"the agent label is checked, not repaired" at the end of this document.

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
- The audit's `arguments_hash` and the approval fingerprint were two different hashes of
  the same arguments until P1.6 made `CallPipeline` record the canonical fingerprint
  (see the amendment below).
- The gate-opened-for-the-period event (spec §3.5) is an input of `decide()`
  (`opened_gates`); since P2.1 the service derives it from the session's events (see the
  amendment below).
- A hosted deployment changes the rate-limit implementation and the transaction
  boundary of the rate record (see above); counters, events, requests and approvals
  move with the store.

## Amendment (2026-10-13, feature P2.1) — the approval gate

The approval gate amendment of the pivot ADR decided _that_ a risk can be gated
`approval`; this section records _how_ the budget honours it, now that the creator's
decision exists. It adds to the decisions above and changes one of them (the key).

### The fingerprint is unchanged, and is the audit's

`sha256(canonicalJson(args ?? {}))`, 64 hex, as decided above. The open point of the
consequences is closed: since P1.6 the pipeline records that same value as the audit's
`arguments_hash`, so "only their fingerprint remains in the audit" (spec §3.5) is one
hash, and the creator's view finds the entry of a refused call by it.

### An approval is bound to `(mission, risk, tool, fingerprint)`

The spec says `(mission, RiskId, argument fingerprint)`. The tool is added to the key of
the approval and of the open approval request (store migration 0005). Two tools can touch
the same risk with byte-identical arguments — a file write and a file delete on the same
path —, and the creator approves while reading one tool's name: without the tool in the
key, the other call would consume the approval (Phase 1 security review). The binding is
strictly narrower than the spec's, never wider.

### One request and one approval per gated risk

A call touching several risks of which one is gated is refused whole, and its one approval
lets the whole call through (spec §3.5). A call touching **two** gated risks is refused on
the first without an approval; granting it leaves the second to ask in its turn. The
lookups stay non-consuming, so the first approval survives the second refusal and the
replay consumes both. One request covering every gated risk of the call would need the
request to carry a list of risks and the approval a set — a schema change for a case the
shipped presets do not produce.

### "Open the gate for the rest of the period" is read from the session's events

The opening is a `gate-opened` event carrying the period it was granted in; `decide()`
receives the set derived from the session's `gate-opened` and `gate-changed` events of
the current period (`budget/gates.ts`), read inside the decision transaction. The bound
is the period's start carried by the event: after the rollover nothing matches, with no
job to close anything — the same "arithmetic on read" as the counters. A gate edited on
the mission ends the opening (the latest of the two events decides; a tie closes). A
one-off mission has no period end, so nothing can be opened on it: the creator edits the
gate itself.

### The arguments are erased in the transaction that decides

`decideApproval` stores the decision and sets `args_blob` to NULL in one statement, in
the transaction that writes the approval or the opening; the sweeper does the same on
expiry. Between an expiry and the sweeper's pass the blob is still in the row and no code
path opens it (the store's `getArguments` checks state and expiry).

### Rejected

- **An approval covering every gated risk of the call.** One click for the creator, but
  the set of risks a call touches can change between the grant and the replay (a resource
  relabelled `prod`): an approval bound to the call alone would cover a gated risk the
  creator never saw.
- **Storing the opened gate as a column of `mission_policy`** (`gate_open_until`). A
  second source of truth for the gate, to be expired by someone; the spec calls the
  opening a session event and the event is enough.
- **Keeping the arguments until the approval is consumed**, to show the creator what ran.
  The spec erases them on decision; the fingerprint, the tool and the audit entry of the
  replay say what ran.
- **Passing the slices to the budget stage to store them on the request.** The audit
  already holds them for the same call; reading them there keeps the pipeline's contract
  unchanged.

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

## Amendment 2026-10-13 — the agent label is checked, not repaired (P2.7)

Adds to "The agent label never reaches the decision", which stands. Handbook:
[execution-door](../handbook/execution-door.md), "Agent label".

### Context

Spec §7.9: several agents present the same mission token, each may set its agent label
so that the session and the audit tell who did what, and the budget is shared. The label
is attribution only; nothing proves it. In Phase 1 the door repaired what it received: a
value was cleaned up and cut at 120 characters, so the audit could show a label the
caller never sent.

### Decision

- **A strict shape.** A label is 1 to 64 characters: ASCII letters and digits plus
  `. _ - : / @ +`, the first character a letter or a digit; surrounding whitespace is
  trimmed. The two constants (`AGENT_LABEL_MAX_LENGTH`, `AGENT_LABEL_PUNCTUATION`) live
  with the bootstrap kit, which prints them: agents are told exactly what is checked.
- **Two carriers, the per-call one first.** `params._meta.agent` of the `tools/call`,
  then the HTTP header `X-Vaubaan-Agent`. A carrier that holds nothing, or a value that
  is rejected, leaves the place to the next one.
- **A value that is not a label is dropped, never repaired, never refused.** The call
  proceeds exactly as if no label had been sent, and the door logs the carrier, the
  reason (`not-a-string`, `too-long`, `invalid-character`) and the length — never the
  value.

### Consequences

- An `agent_label` in the audit or on a session event is always, character for
  character, what the caller sent.
- A caller whose label is malformed loses its attribution, not its action; the only
  trace is the door's log line.
- Behaviour change against Phase 1: labels longer than 64 characters, or carrying a
  character outside the list, used to be stored in a repaired form and are now absent.

### Rejected alternatives

- **Repairing the value** (what Phase 1 did). An attribution the gateway rewrote is no
  longer what the caller said about itself.
- **Refusing the call.** Nothing decides on a label: it must never be the cause of a
  refusal.
- **Reserving a share of the budget per label.** The budget is shared by the agents of
  a mission (spec §7.9), and a label is not an identity: any agent can claim any name.
