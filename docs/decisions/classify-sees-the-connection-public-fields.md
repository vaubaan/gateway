---
title: The classifier sees the connection's public form fields
status: accepted
date: 2026-10-16
extends:
  - plugin-contract-and-credential-spec
  - plugin-identifiers-one-grammar-for-classify-and-execute
---

# The classifier sees the connection's public form fields

> Fix of a refusal seen on the dogfood instance, 2026-10-16. Handbooks:
> [plugin-sdk](../handbook/plugin-sdk.md),
> [execution-door](../handbook/execution-door.md),
> [fly](../handbook/providers/fly.md) §1. Spec: the contract of
> [gateway-risk-model](../spec/gateway-risk-model.md) §7 still writes
> `classify(tool, args, resources)`; the extra argument is optional and is
> reported to the planning agent for the spec.

## Context

A refused `fly__create_app` (`{ name, network }`) was audited and refused
with the slice `fly.org[*].app.W`. The connection is bound to one Fly
organization (`vaubaan`), which `execute` sends to Fly and checks every app
against; but `classify` is pure and receives only the tool, the arguments
and the mission's resources on the connection. The Fly classifier took the
organization from the apps of the mission (their discovered `org_slug`), and
a mission that creates an app usually holds no app yet: the organization was
unknown, the slice said `org[*]`. The decision was right (every Fly pattern
matches `org[*]`); what a person read in the refusal and the audit was not.

The organization slug is a non-secret field of the connection's form
(`secret: false`); the host already keeps the visible fields of the form in
the connection's metadata (`metadata.fields`) and shows them on the account
page.

## Decision

1. **SDK.** `ProviderPlugin.classify` takes an optional fourth argument,
   `connection?: ClassifyConnection`, `{ fields: Record<string, string> }`:
   the non-secret form fields of the connection. Still pure; never the
   credential, never a secret field. Existing classifiers ignore it.
2. **Host.** `loadMissionContext` puts the fields on
   `MissionConnection.public_fields` (`connectionPublicFields`, string values
   of `metadata.fields` only). The resource stage and the risk stage hand the
   same view to the classifier (`classifyConnectionOf`;
   `evaluateCallForToken` takes `connection?`), so the slices the risk stage
   decides and audits are those the resource stage resolved.
3. **Fly.** The `org[<slug>]` segment is the connection's `org_slug` (checked
   with the slug grammar), else the organization the mission's apps share,
   else `org[*]`. The organization is still never an argument.

## Consequences

- Refusals and audit entries of Fly name the real organization
  (`fly.org[vaubaan].app.W`). The risks touched do not change: the catalog's
  patterns match `org[*]`, so a named organization cannot widen or narrow a
  decision — fail-closed is kept, and a missing or malformed field falls
  back to what was cited before.
- Any plugin whose slices could name what the connection is bound to (a
  team, an account) can now do it from the form fields; none other does yet.
- A connection made by an app installation or OAuth carries no form fields:
  the classifier receives `{ fields: {} }`.
- The spec's signature of `classify` lags behind by one optional argument
  (reported, not edited by this change).

## Rejected alternatives

- **Pass the credential to `classify`.** Breaks the purity of the contract
  and hands secrets to code that never needs them.
- **An organization pseudo-resource in every mission.** The data model says
  the organization is never a mission resource; selecting it would also
  appear in the resource listings and the selection rules.
- **Let the agent name the organization in the arguments.** The argument
  surface is closed; an agent-chosen organization in the audit would be a
  claim, not a fact.
- **Leave `org[*]`.** Correct for the decision, but the audit and the
  refusal must say what was attempted where (spec §4.1); "any organization"
  for a connection bound to one is wrong for the reader.
