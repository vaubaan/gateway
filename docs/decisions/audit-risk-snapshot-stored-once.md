---
title: The audit stores the accepted-risk snapshot once per distinct set, and the remaining budget of the touched risks only
status: accepted
date: 2026-10-23
amends:
  - embedded-store-sqlite-and-migrations
---

# The audit stores the accepted-risk snapshot once per distinct set, and the remaining budget of the touched risks only

> Product owner's decision of 2026-10-23. Spec:
> [vaubaan-gateway §8](../spec/vaubaan-gateway.md#8-audit),
> [gateway-risk-model §12](../spec/gateway-risk-model.md#12-audit). Handbook:
> [store, "Audit"](../handbook/store.md#audit). Migration
> `0022_audit_risk_sets.sql`.

## Context

[embedded-store-sqlite-and-migrations](./embedded-store-sqlite-and-migrations.md)
unfolded a call entry's `accepted_risks_snapshot`, `risks_touched` and
`remaining_budget` into one `audit_risks` row per risk of the snapshot ∪ the
touched risks. Every call repeated the whole snapshot, touched or not.

Measured on the dogfood instance (2.0.0-alpha.4, 2026-10-23): the store was
15.3 MB after 9 days, 12.5 MB of it `audit_risks` and its primary-key index —
84 613 rows for 1 167 audit entries (78 rows per call on average, 102 at most;
122 distinct risk ids). Missions issued with the `everything-i-hold` preset
accept about 100 risks, so each call cost about 12 KB, about 2 MB a day. On the
managed free plan (a 1 GB volume, backups kept as full copies 7, 30 and 90
times) the product owner found this too much.

The snapshot itself is wanted: it is what makes a decision reproducible after
the mission's policy changed (gateway-risk-model §12). What is not wanted is
writing the same hundred ids on every call. The remaining budget of an untouched
risk carries nothing either: the call did not change it (and the budget stage
already reported the touched risks only).

## Decision

- **The snapshot is stored once per distinct set.** Table `audit_risk_sets(id,
risk_count)` with `audit_risk_set_members(set_id, risk_id)`, one row per risk
  ("enumerations are rows"; the `risk_id` CHECK refuses the empty string and
  `*`, as on `mission_policy`). The id is content-addressed: SHA-256 (hex) of the
  sorted, distinct risk ids joined by a line feed. The append inserts the set
  with `ON CONFLICT (id) DO NOTHING` and its members only when the set is new,
  inside the entry's transaction. `audit.accepted_set_id` (new, nullable)
  refers to it. Two missions that accept the same risks share the set.
- **`audit_risks` holds the risks the call touched only** — the refused risk of
  a refused call is one of them — with `accepted`, `touched` and `remaining` as
  before. The remaining budget is recorded for touched risks only; a value the
  entry carries for an untouched risk is not stored.
- **The read folds back the same `AuditEntry`.** `accepted_risks_snapshot` comes
  from the set (checked against `risk_count`), `risks_touched` and
  `remaining_budget` from the rows. gateway-core's type does not change.
- **Immutability is the audit's.** `BEFORE UPDATE` triggers on both tables
  abort; `BEFORE DELETE` triggers abort unless the purge window is open **and**
  no remaining `audit` row refers to the set. `purgeOlderThan` deletes, inside
  its window, the risk rows and entries older than the cutoff, then the members
  and sets no remaining entry refers to. A set is not kept after its last entry:
  it describes nothing once that entry is gone, and keeping it would let the
  store grow with every distinct policy forever.
- **No rewrite of existing rows.** The audit is immutable
  (**[inv: audit-immutable]**): entries written before migration 0022 keep
  their full `audit_risks` rows and no set id, read their snapshot from those
  rows as before, and age out with `retention_days`. The space they hold comes
  back only then (and only as free pages: SQLite does not shrink the file
  without a `VACUUM`).

Effect, for a 100-risk mission and a call touching one risk: 100 `audit_risks`
rows (about 17 KB with the index, measured with the dogfood's id lengths) become
one row (about 190 B), plus a set of 100 members written once — about 98% fewer
audit rows per call.

## Consequences

- An entry's risk picture is spread over three tables; the repository is the
  only reader and returns the same record shape, so no service or page changed.
  `countAllowedTouches` was already a join on touched rows.
- A read costs one more indexed lookup per call entry (the set's members). A
  Postgres port reads a page's sets in one statement.
- `record.risks` (the raw rows, test-facing) lists touched risks only on new
  entries, every snapshot risk on old ones.
- An entry whose `remaining_budget` names an untouched risk no longer
  round-trips that key. The pipeline never writes one.
- The `never a sentinel` check covers the set members as it covers the policy.

## Rejected alternatives

- **Store no snapshot and derive it from the mission's policy history.** Not
  reconstructible: a policy is edited in place (limits, gates, members), a
  mission is revoked and its rows go with it, and nothing records the policy
  as of each call. The snapshot exists precisely because the mission changes.
- **Compress the rows** (one JSON or compressed blob per entry). Still one copy
  of the set per call — 100 ids is about 3 KB uncompressed — and it breaks the
  "enumerations are rows" rule the counters-vs-audit check and the
  never-a-sentinel check rely on.
- **Keep as is.** About 2 MB a day for one busy instance; backups multiply it.
- **Keep unreferenced sets after the purge.** Cheap per set, but they would
  outlive every entry that justified them, and their count grows with every
  policy change; the purge already holds the window and removes them in the
  same transaction.
- **Rewrite the existing entries into sets.** Would need an `UPDATE`/`DELETE`
  exception to the immutable audit for a space gain the retention gives anyway.
