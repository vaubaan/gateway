---
title: One approval request covers the call — it lists every gated risk the call touches, and one grant approves it
status: accepted
date: 2026-10-13
---

# One approval request covers the call

## Context

A call can touch several gated risks (a workflow file on a gated branch: two; a migration: five).
With one risk per request, the creator granted the first, the agent replayed and was refused on the
second: one human round trip per gated risk for an action read in full the first time.

## Decision

The budget decision refuses once with every risk whose gate asks at that instant, and one request
lists them all; one grant, bound to `(mission, tool, argument fingerprint)`, approves the call and
is consumed by its identical replay. An open request is reused only when it covers what the call
needs, and is never widened.

## Consequences

- One request, one decision, one replay per call; the request page says the answer covers every
  listed risk.
- A gate changed between request and replay makes the approval insufficient: one more covering
  request.
- A stored request or approval never comes to cover a risk its author did not see (legacy rows
  read as their single risk).

## Rejected alternatives

### One approval row per risk under one request

A partly consumed grant means nothing to the creator.

### Widen the open request when a replay needs more

A creator looking at "one risk" would grant two.

### Approve the call whatever it touches

The list bounds the grant to what the creator saw.
