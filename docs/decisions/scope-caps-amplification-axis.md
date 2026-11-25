---
title: Scope caps frame amplitude apart from risks; a catalog declares only the limits the gateway enforces
status: accepted
date: 2026-06-16
---

# Scope caps frame amplitude apart from risks; a catalog declares only the limits the gateway enforces

## Context

`risks_touched ⊆ accepted_risks` captures the kind of an action, not its amplitude: the same risk
reads seven days of mail or five years. The risk vector is qualitative and comparable across
providers; amplitude is quantitative and tightened after incidents. And a limit a catalog declares
but the gateway does not apply is worse than none: it is believed.

## Decision

Amplitude lives beside the risk entry in two SDK types: `caps` (soft, a mission may only tighten)
and `infra_limits` (hard ceilings set by the plugin maintainer). A stateless cap is applied before
the call by the plugin rewriting arguments (`normalizeForCaps`), never checked after a mutating
call; a catalog may declare only the keys in `ENFORCED_CAP_KEYS` / `ENFORCED_INFRA_LIMIT_KEYS`
(`apps/gateway/src/server/execution/scope-caps.ts`), held by `catalog-caps-enforced.test.ts`.

## Consequences

- Today only `infra_limits.calls_per_minute_max` is enforced (the ceiling of a mission's rate);
  per-call size and time window are bounded by nothing but quota, rate and gate.
- A new key joins the enforced list in the change that enforces and tests it.
- Stateful amplitude (rate, quota) is the mission budget, not a second mechanism: no cap counts
  over a mission's life (`calls_per_session_max` was removed on 2026-11-25; a catalog that still
  writes it loads, the key dropped).
- The catalog types (`caps`, `infra_limits`) stay while unenforced. The plugin hook
  `normalizeForCaps` was removed on 2026-10-31 (ADR plugin-contract-and-credential-spec, amendment):
  the cap stage that enforces a cap adds it back as an optional member, a non-breaking change.

## Rejected alternatives

### A seventh vector axis `amplitude`

The vector is descriptive and comparable; caps are quantitative and enforced.

### Post-hoc checks for mutating tools

A bulk delete over the cap has already run when the response is counted.

### Keep unenforced declarations as advisory

A reader of the catalog does not read the handbook.

### Remove `caps` from the SDK until enforced

A contract change now and another when enforcement lands.
