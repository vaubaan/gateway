---
title: A catalog carries no gate — a risk is accepted or not, and asking first is the mission's choice
status: accepted
date: 2026-06-16
---

# A catalog carries no gate — a risk is accepted or not, and asking first is the mission's choice

## Context

A per-entry catalog default gate (`allow`, `confirm`, `deny`) duplicated other mechanisms: `deny`
behaved like a risk nobody accepted, `confirm` held issuance for a human approval that the runtime
request path already offers, and per-project overrides were never used. The severity of a risk is
a property of the provider, already carried by its vector.

## Decision

A catalog entry carries no gate. A risk is acceptable on a resource when its `acceptable_in_envs`
is absent or includes the resource's environment, the catalog's only structural guard; it is
accepted when the mission's policy names it. Asking before a call (`auto` or `approval`) is a
property of the accepted risk in the mission, chosen by its creator.

## Consequences

- At call time `risks_touched ⊆ accepted` continues, anything else is `risk-not-accepted`.
- Issuance never waits for an approval: it succeeds or is refused with the risks at fault.
- One path for more authority: a refused call opens a request to the creator.
- The vector orders and explains; no gate is ever computed from it.

## Rejected alternatives

### Keep `default_gate` as a hint

Duplicates the vector, which already carries severity.

### Keep `confirm` for approval-mandatory risks

Issuance is already the human act of accepting; an approval per call is the mission's gate.

### Per-project risk policies

Never used; easy to add back if a need appears.
