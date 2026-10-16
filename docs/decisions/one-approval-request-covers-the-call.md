---
title: One approval request covers the call — it lists every gated risk the call touches, and one grant approves it
status: accepted
date: 2026-10-13
amends:
  - atomic-budget-accounting
---

# One approval request covers the call — it lists every gated risk the call touches, and one grant approves it

> Product owner's decision of 2026-10-13 (question 13 of the final pass). Spec:
> [vaubaan-gateway §0 "Approval", §3.5, §4.1](../spec/vaubaan-gateway.md).
> Handbooks: [requests, "One request covers the call"](../handbook/requests.md#one-request-covers-the-call),
> [budget-and-sessions](../handbook/budget-and-sessions.md), [store](../handbook/store.md).

## Context

An approval request named one risk, and so did the approval a grant produced:
`(mission, risk, tool, fingerprint)`. The budget decision refused a call on
the first gated risk that had no approval.

A call can touch several gated risks. Writing a workflow file on a branch
whose writes are gated touches two; a migration can touch five. The creator
then received a request for the first risk, granted it, the agent replayed,
was refused on the second, a second request was dropped, and so on: as many
round trips between a human and an agent as there were gated risks, for one
action the human had already read in full the first time.

The spec already said "the approval covers the call, not the isolated risk";
that held for a call with one gated risk only.

## Decision

### D1. One request lists every gated risk of the call

The budget decision refuses once, with every risk of the call whose gate asks
at that instant (a gate opened for the period is not among them). The request
stores the list (`requests.risk_ids_json`); `risk_id` stays and is the first
of the list. The refusal carries `risk_ids` and one URL.

### D2. One grant approves the call

The approval is bound to `(mission, tool, argument fingerprint)` — the call —
and lists the risks it covers (`approvals.risk_ids_json`). The identical
replay finds the approval that covers every gated risk it needs and consumes
it, once. The tool stays in the binding, for the reason of migration 0005.

"Open the gate for the rest of the period" opens the gate of every listed
risk still closed. "Refuse" refuses the call.

### D3. A request is reused only when it covers what the call needs, and is never widened

A replay before the decision reuses the open request of the same call that
lists every risk it needs. An open request that lists fewer is left as it is
and a new one is dropped beside it. Widening it in place would let a creator
who is looking at a page that says "one risk" grant two.

### D4. Rows that exist keep the meaning they had

Migration `0013` adds the two columns and backfills them from `risk_id`: a
request or an approval written before names one risk and now lists that one
risk. No row comes to cover a risk its author did not see.

- An open one-risk request is still granted for its risk. A call that needs
  more gets a covering request; granting the old one alone does not let that
  call through.
- Approvals granted risk by risk before the upgrade are consumed together by
  the call they jointly cover.
- A list that is absent or unreadable reads as the one risk of `risk_id`.

## Consequences

- One request, one decision, one replay per call, whatever it touches.
- The creator's page lists the gated risks and says the answer covers them
  all. The request's label in the inbox is no longer a single risk.
- A change of gates between the request and the replay (a risk set to
  `approval` meanwhile) makes the approval insufficient: the call is refused
  once more, with one request covering what it needs now.
- `ApprovalKey` (per risk) becomes `ApprovedCall`; the store looks approvals
  up by the call and consumes them by id.
- During the days after an upgrade, a call may have two open requests: the
  one-risk request of the earlier build and the covering one. They expire on
  the usual delay.

## Rejected alternatives

- **One approval row per risk under one request.** `approvals.request_id` is
  unique, and a "partly consumed" grant has no meaning for the creator.
- **Widen the open request when a replay needs more.** See D3.
- **Convert open one-risk requests during the migration.** SQL does not know
  which other risks the call touches; only the classifier does, and the
  arguments are sealed.
- **Expire open requests at the upgrade.** It would make agents ask again
  for what a creator may be about to grant.
- **Drop the risk from the approval entirely** (approve the call, whatever
  it touches). The list is what bounds the grant to what the creator saw: if
  a gate is closed later on another risk of the same call, it is asked.
