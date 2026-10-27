---
title: The gateway is a single-tenant on-prem image with shared identities and mission tokens carrying a budget per risk
status: accepted
date: 2026-10-12
author: Renaud Pelissier
---

# The gateway is a single-tenant on-prem image with mission tokens carrying a budget per risk

## Context

v4 was a multi-tenant SaaS gateway whose risk catalog held. But a company will not hand its cloud
credentials to a third-party SaaS; a token was issued for a person and bounded in kind but not in
quantity (a looping agent could make 10 000 legitimate writes in a minute); the identity model was
flat (one owner, every member with full rights); and plugins cannot be tested against the real
services.

## Decision

One instance is one company: a Docker image (one Node process, SQLite on a volume, secrets sealed
under an instance master key), people signing in through the company's IdP, connections owned by
users and shared as explicit risk lists. Agents act with mission tokens: a named goal whose
accepted risks each carry a budget (quota per period, rate limit) and a gate (`auto` or
`approval`), with anything beyond answered by the creator alone. Apache-2.0, in English.

## Consequences

- No machine-to-machine delegation: no sub-mission, no child token; extra authority always comes
  from a human.
- Three credentials never cross: the mission token (execution door), the delegated token
  (management door), the human session (interface).
- One process, one SQLite writer: no shared rate limit across replicas, high availability out of
  scope.
- Plugins are validated by unit tests on the classifier and opt-in telemetry, never by tests
  against the real services.

## Rejected alternatives

### Stay SaaS with "bring your own IdP"

The cloud tokens would still live at a third party.

### Postgres instead of SQLite

One more service to run on a VPS or a workstation; re-evaluated if high availability is asked for.

### One global budget per mission

A hundred reads would empty the right to write.

### Sub-missions and child tokens

The orchestrator and its sub-agents present the same mission and draw from one budget.

### AGPL-3.0

Network copyleft slows adoption where company policy forbids it, for a protection against
re-hosting not worth that cost.
