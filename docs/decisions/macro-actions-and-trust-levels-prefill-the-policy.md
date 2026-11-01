---
title: A mission is composed from macro-actions at a trust level, which pre-fill the explicit policy
status: accepted
date: 2026-10-30
author: Renaud Pelissier
---

# A mission is composed from macro-actions at a trust level, which pre-fill the explicit policy

## Context

Catalog presets are named like personas (Developer, Operator, Scribe) and fix gates and budgets per
preset; creators cannot read them in the connector's own words, and picking one hides what the
agent gets. The risk model forbids deriving any decision from the vector, so the gate of each
accepted risk is chosen by hand or copied from a preset.

## Decision

Each catalog entry belongs to exactly one **macro-action** of its connector (3 to 6, independent,
plus "Anything else" holding the fallback) and carries a **base budget**. A creator ticks
macro-actions and sets each to a **trust level** (Careful, Trusting, Autonomous); the trust level
maps the entry's **tier**, read from its vector (irreversible → 4, costly → 3, reversible but pii,
secret, bulk, account-wide or unbounded cost → 2, else 1), to `auto`, `approval` or not accepted,
and multiplies the base budget (×1, ×3, ×10, rate capped by the catalog ceiling). The result is the
explicit list, shown at preview and the only thing stored; catalog presets are retired.

## Consequences

- The vector pre-fills, it never decides: the runtime still reads only the accepted list, and every
  line stays editable in the advanced view.
- A catalog is refused when an entry has no macro-action or no base budget, or a macro-action is
  empty; a new entry joins a macro-action in the same PR.
- A trust level change after issuance is an ordinary mission edit (ADR
  mission-editable-after-issuance); the mission records the trust level per macro-action only to
  redraw the form.
- `everything-i-hold` stays the one built-in expansion (ADR preset-everything-i-hold-expands-explicitly).

## Rejected alternatives

### Persona presets, kept and renamed

Still one opaque bundle per persona; independent intents (administer without reading) do not fit.

### Cumulative ladders per connector

Each rung includes the one below, so reading cannot be left out of administering.

### The tier from the existing severity score, or written by hand per entry

The six-axis sum ranks `force-push` low: it sorts well and gates badly. Hand-written tiers are
205 values to keep consistent across 14 plugins.

### The trust level in the token, resolved at call time

A catalog change would widen a mission nobody re-read; the token keeps the explicit list.

## History

- 2026-10-31: renamed before publication, as a breaking change in the alpha window (owner
  decision): the French words of the first version — "cran" (Prudent, Confiant, Autonome) and
  "palier" — became "trust level" (Careful, Trusting, Autonomous) and "tier", so the repository
  speaks one language; what each trust level writes did not change.
