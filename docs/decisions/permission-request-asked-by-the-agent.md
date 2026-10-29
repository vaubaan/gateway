---
title: A refused permission stays a no; the agent may ask for it, deliberately and with a reason
status: accepted
date: 2026-10-17
---

# A refused permission stays a no; the agent may ask for it, deliberately and with a reason

## Context

`budget-exhausted` and `approval-required` open a request automatically: the creator already
accepted the risk, only the quantity or the moment is in question. A `risk-not-accepted` left the
creator nothing but re-issuing the mission with new keys, yet opening a request on every such
refusal would fill the inbox with what agents try by mistake while exploring.

## Decision

A missing-permission refusal creates nothing; it returns a reference (15 minutes, bound to mission,
token and missing risks). The agent asks deliberately by calling `vaubaan__request_permission` with
it and a justification, and the creator grants the permission through the mission edit, with an
explicit budget and gate, or refuses.

## Consequences

- Nothing reaches the creator unless an agent decided the task needed it and said why; the reason
  is shown as the agent's words, never as an input to authorization.
- A grant does not run the refused call: the agent retries with its existing key.
- Requests are bounded: an open request for the same mission, holder and missing set is reused, and
  at most ten new ones per mission per rolling day.
- Execution and management credentials can neither edit a mission nor answer a request.

## Rejected alternatives

### Open a request automatically on every `risk-not-accepted`

Agents would learn that every refusal is a question to the human.

### Let the agent widen its mission through the management door

The management door must not be a way past a refusal, and the agent would authorize its own
escalation.

### Allow a single call once

A single-use grant bound to the call's fingerprint stays separate from adding a budgeted
permission.
