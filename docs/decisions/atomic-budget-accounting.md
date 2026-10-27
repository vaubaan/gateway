---
title: The budget is durable counters decided and incremented in one store transaction; only a granted claim gives actions back
status: accepted
date: 2026-10-13
---

# The budget is durable counters decided and incremented in one store transaction; only a granted claim gives actions back

## Context

Spec §6 requires the budget decision and its decrement to be one operation (two concurrent calls
on the last credit: one allow, one refusal), and §3.3 forbids a restart forgetting a consumed
credit. The audit is the truth of what happened and the counters of what is left, held together
by the structural check that they agree. A claim (spec §3.4) must be able to give room back
without editing the mission's policy.

## Decision

Quota state is `session_counters(session_id, risk_id, period_start, consumed)` only, read, decided
and incremented inside one `BEGIN IMMEDIATE` transaction; the credit is consumed at decision time,
before the upstream call, and never refunded. Rate windows live in memory and periods roll over on
read from `(anchor, length, now)`. A granted claim lowers the claimed risk's counter for the current
period (reset: to zero; extension: by `1 <= amount <= consumed`) and records the credit on its
session event, so the check is `counted + credited == audited`.

## Consequences

- Every allowed call costs one write transaction; a hosted deployment swaps the rate limiter
  (Redis) and the store, nothing else.
- A call touching N risks decrements N counters; a refusal on any dimension of any risk refuses the
  whole call before any increment. Dimensions are checked quota, then rate, then gate, so nobody
  is asked to approve a call the budget would refuse.
- A claim never touches `mission_policy` and never grants anything on a risk it does not name;
  purging `events` mid-period breaks the structural check.
- `consumed` is not the count of allowed calls: read the audit, or add the events' credits.

## Rejected alternatives

### In-memory counters with periodic flush

A crash between flushes forgets credits, which spec §3.3 forbids.

### Refund the credit on upstream failure

Needs the provider's side effect to be known, breaks counters-vs-audit, and lets an agent burn an
exhausted budget on failing calls.

### Reserve-then-confirm, or a scheduled rollover job

Two calls on the last credit would both pass; a job can be late, and a reset destroys past
periods.

### A per-period extension table, counters monotonic

Allows any amount but needs a migration and changes every reader of `quota - consumed`; a negative
counter is forbidden by the `CHECK` and unreadable.

### A reset that zeroes every risk of the period

Granting one claim would reopen risks nobody was asked about, while their own claims wait.
