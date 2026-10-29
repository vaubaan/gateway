---
title: Discovery merges into owner-curated resources and never deletes them; a connection's default environment labels the unlabelled ones
status: accepted
date: 2026-10-13
---

# Discovery merges into owner-curated resources and never deletes them; a connection's default environment labels the unlabelled ones

## Context

The spec makes the connection's owner the curator of its resources, while discovery keeps
reporting what the provider holds, some plugins set an environment label themselves (Stripe
`test`/`live`), and missions select resources by row id. An unlabelled resource refuses every
environment-qualified risk, which made each new resource of a single-environment account (a Fly
organization, a Railway workspace) unusable until labelled by hand.

## Decision

A discovery updates provider facts only (`metadata_json`); owner edits live in their own columns
(`owner_metadata_json`, edited name, `hidden`) and are never overwritten; a ref that disappears
upstream is marked `stale_since` and keeps its row id. A connection may carry a
`default_env`, set by its owner and audited; a resource's effective environment is its own label,
else that default, computed in one place (the connections repository's reads), while the stored
row keeps the resource's own label.

## Consequences

- Mission selections survive upstream churn; stale rows accumulate (no purge yet).
- Every reader of a resource's environment (issuance, the execution door, the management door,
  account pages) reads the repository's effective value, never the column.
- Setting or clearing a default changes what running missions reach, like relabelling; an
  unlabelled resource of a connection without default is still never a safe default.
- An owner-editable scalar in metadata needs a plugin contract change (only lists of strings are
  editable today). Connect-flow rules: handbook [connections](../handbook/connections.md).

## Rejected alternatives

### Delete resources that disappear upstream

Cascades into `mission_resources`, silently narrows running missions, and loses the owner's label
when the resource comes back.

### One metadata column, plugins told to preserve owner keys

Every plugin would re-implement the merge, and one bug would erase owner settings.

### A silent or per-provider default environment

Would act on an unlabelled production resource as staging; two connections of one provider are
routinely different environments.

### Write the default into each unlabelled row

Clearing it could no longer tell owner labels from copies, and every writer would have to apply it.
