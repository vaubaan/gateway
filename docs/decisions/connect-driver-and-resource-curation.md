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
  editable today). Connect-flow rules: handbook [accounts](../handbook/accounts.md).

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

## Amendment 2026-11-14: a plugin may hide what the credential cannot act on

### Context

GitHub lists every public repository its user is related to, whatever the fine-grained token's
grant, and offers no way for a token to list its own repositories. An owner whose token reaches one
repository saw dozens in the mission form, ticked by default, and unticked them by hand.

### Decision

`Resource.hiddenByDefault` (plugin SDK 0.9.1) is a provider fact: discovery stores it as `hidden`
while the owner never hid nor showed the resource. The owner's choice is kept apart, as the edited
name is: `connection_resources.hidden_edited` (migration 0034) is set by every owner hide or show,
and then discovery never changes `hidden`. Rows hidden before 0034 were the owner's; visible ones
take the hint at their next discovery. A creating call's answer carries no hint and changes no mark.

### Consequences

- A resource the owner showed stays shown across refreshes; one never touched follows the plugin
  both ways (hidden, then shown when the hint goes away).
- A hidden resource is left out of "every resource known", of future joins and of the mission
  form's default ticks; reach is still the stored lists, so a running mission keeps it.
- GitHub's rule and its trade-off (a granted public repository is hidden until shown): handbook
  [services/github](../handbook/services/github.md).

### Rejected alternatives

#### Apply the hint to new rows only

The connections that suffer today would keep every public repository listed.

#### Leave out what the plugin thinks unusable

The owner could no longer select a granted public repository, nor see why it is missing.
