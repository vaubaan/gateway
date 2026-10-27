---
title: Orphaned missions are derived on every read and lost per connection; nothing is stored, nothing widens
status: accepted
date: 2026-10-13
---

# Orphaned missions are derived on every read and lost per connection

## Context

Authority is recomputed from current membership, never from a snapshot (spec §10). A stored, final
`orphaned` turned transient losses into permanent outages: an IdP omitting one group at one sign-in
(Entra ID's overage above 200 groups) closed missions for good, with new tokens and budgets from
zero for every project holding them. Orphaning a whole mission for one revoked connection stopped
the untouched accounts too.

## Decision

`orphaned` is computed on every read and stored nowhere (`MissionGrounds`): a mission is orphaned
when its creator is removed or no longer covers it. Each connection is a part of the mission, lost
on its own (`connection-revoked`, `connection-missing` final; `access-withdrawn` until a share or
membership grounds it again); the mission is orphaned as a whole only when every part is lost or a
share is narrowed under one.

## Consequences

- Every reader of a mission goes through `MissionGrounds`; a structural test fails on a new file
  loading a mission record until it is classified, and triggers refuse `orphaned` in the column.
- When the authority comes back, everything is back: same token, session, counters, open requests.
- A call needing a lost part is refused `connection-revoked`; its tools leave `tools/list`.
- Nothing widens: a lost part is never replaced and takes no new permission. Human acts that orphan
  or restore are audited naming the human; the execution door writes no administrative entry.

## Rejected alternatives

### A stored, final `orphaned`

Turns a transient loss into a permanent outage for every project holding the token.

### A stored status flipped back by sweeps

Two writers in two directions; any path without a sweep leaves the column wrong.

### Orphan the whole mission for one revoked connection

Seen in production: four accounts stopped for a change on a fifth.

### A grace period before a lost authority refuses calls

Runs on an authority just withdrawn.
