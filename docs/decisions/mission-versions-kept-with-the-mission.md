---
title: Every change of a mission's configuration is an immutable version, kept with the mission, and a rollback is a new version
status: accepted
date: 2026-11-15
---

# Every change of a mission's configuration is an immutable version, kept with the mission, and a rollback is a new version

## Context

A mission is edited after issuance without limit ([mission-editable-after-issuance](mission-editable-after-issuance.md)),
and changes also through accepted permission requests, resources it creates, future resources and
answered claims. The audit keeps an entry per act, but in shapes that differ per act and only
for the retention period (90 days by default). The owner asked (2026-11-14) for versions of a
mission's configuration with rollback, kept as long as the mission.

## Decision

`mission_versions` (migration 0039) holds one row per change of a mission's configuration:
number, author (person, mission through its `vaubaan` account, or the gateway), cause, the
whole configuration as JSON and a compact summary of what moved. The store's write of the change
appends it in the same transaction (`recordSync`), only when the configuration differs from the
latest version. Rows are never updated and are deleted only with their mission; retention never
reaches them. "Restore this version" is an edit judged under the creator's authority now, and
writes a new version that names its source; history is never rewritten. Keys, teammates and
counters are not configuration.

## Consequences

- Every new writer of a mission's configuration calls `recordSync` in its transaction; a test per
  write path pins it.
- The History survives the audit's purge and is in every backup; the table grows with the edits
  of a mission, not with its calls.
- A restore can come back narrower than the version (authority lost, resources gone) and says
  what it left out; it never restores keys nor resets usage.

## Rejected alternatives

### Rebuild the history from the audit

Purged by retention, and each act stores a different partial shape: a full configuration is
not recoverable from it.

### Store only diffs

A rollback would replay a chain, and one bad row breaks every later version.

### Rollback rewrites or truncates history

Loses what happened; restoring again would not undo it.

### Versions written by the service after the store call

Two transactions: a crash or a concurrent write between them leaves a change without its
version, or a version showing another change's state.
