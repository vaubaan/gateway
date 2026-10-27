---
title: The audit stores the accepted-risk snapshot once per distinct set, and the remaining budget of the touched risks only
status: accepted
date: 2026-10-23
---

# The audit stores the accepted-risk snapshot once per distinct set, and the remaining budget of the touched risks only

## Context

Each call entry wrote one `audit_risks` row per risk of the accepted snapshot plus the touched
risks: with ~100-risk missions that was most of the store (about 2 MB a day on one busy instance,
multiplied by backups on small volumes). The snapshot itself is wanted: it makes a decision
reproducible after the policy changed (gateway-risk-model §12). The audit is immutable and its
enumerations are rows, which the counters-vs-audit and never-a-sentinel checks rely on.

## Decision

The accepted snapshot is stored once per distinct set in `audit_risk_sets` /
`audit_risk_set_members` (id = SHA-256 of the sorted ids), referenced by `audit.accepted_set_id`;
`audit_risks` holds only the touched risks. Both tables are immutable like the audit, and the
purge removes a set only once no entry refers to it.

## Consequences

- An entry spans three tables; the audit repository is the only reader and folds them back into
  gateway-core's unchanged `AuditEntry`.
- Older entries keep their full rows and age out with retention: the audit is never rewritten
  (`[inv: audit-immutable]`).
- The never-a-sentinel check covers set members; a `remaining_budget` for an untouched risk is no
  longer recorded.

## Rejected alternatives

### Derive the snapshot from the mission's policy history

Not reconstructible: policies are edited in place and revoked missions leave.

### Compress the rows into one blob per entry

Still one copy per call, and it breaks "enumerations are rows".

### Rewrite existing entries into sets

Needs an exception to the immutable audit for a gain retention gives anyway.
