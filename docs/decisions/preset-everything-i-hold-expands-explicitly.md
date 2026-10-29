---
title: The built-in preset "Everything I hold on this account" expands into the explicit list at preview and issuance
status: accepted
date: 2026-10-18
---

# The built-in preset "Everything I hold on this account" expands into the explicit list

## Context

A mission policy is an explicit enumeration `RiskId → (quota, rate limit, gate)`. A solo developer
running their own agents, or an operator preparing a break-glass mission, wants "everything I
hold", which meant typing every RiskId (87 lines over five connections on a real instance). The
invariant stays: no wildcard, no sentinel, no "everything" in a share, a mission, a token or the
audit.

## Decision

The gateway offers a built-in preset `everything-i-hold` on every connection, expanded at preview
and again at issuance into explicit lines: every non-deprecated catalog id the creator's authority
covers now that the selected resources can reach, the fallback included, each with a budget from
one gateway rule and gate `auto`.

## Consequences

- The stored policy is the list; later authority or catalog growth does not widen the mission.
- No plugin may ship that preset id (structural test); it is the one preset allowed to carry the
  fallback.
- The preview always carries the `everything-i-hold-expanded` notice (count, most severe, critical
  risks running freely, the fallback), and creation still confirms the explicit list.

## Rejected alternatives

### A wildcard risk

Every stage of the chain must read as a list, and a new catalog risk must never enter a mission
nobody re-read.

### A mission flag "all current authority", resolved at call time

The mission would widen silently; nobody would have confirmed what the agent can do.

### Hand-maintained "owner" presets per catalog

Drift on every catalog change, and wrong for a creator who holds only a share.
