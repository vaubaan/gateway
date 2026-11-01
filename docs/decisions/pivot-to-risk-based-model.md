---
title: A mission carries accepted risks, not capabilities
status: accepted
date: 2026-06-15
---

# A mission carries accepted risks, not capabilities

## Context

Three models of what an agent may do failed in turn: concentric capability rings (15 to 20 per
provider, the operator got lost), five macro-permissions (too vague: what is `govern` at Vercel?),
and a slice DSL that required predicting what an autonomous agent would touch. A person who
delegates can say which consequences they accept far more easily than which actions the agent
will take.

## Decision

A mission carries an explicit list of accepted `RiskId`s; nobody grants a capability, a slice or a
pattern. The plugin classifies each call into slices, the provider's YAML catalog maps slices to
named risks, and the call is allowed only if the risks it touches are a subset of the accepted
ones (spec [gateway-risk-model](../spec/gateway-risk-model.md)).

## Consequences

- Default deny: no wildcard and no sentinel in a persisted list; a flagged fallback risk catches
  any call no other risk matches.
- A new catalog risk fails closed: a mission that did not accept it is refused on the first call
  touching it, and nothing is migrated automatically.
- What pre-fills a policy (macro-actions at a trust level) is written into the explicit list at issuance,
  never referenced.
- A missing risk is answered by a person (the creator edits the mission), never by the agent.

## Rejected alternatives

### Slices as the grant

The person would write selectors at issuance: still capability-based, still predicting the agent's
path.

### Five macro-permissions

Simpler on screen, but unclear about what each macro covers for someone who knows the provider.

### A full policy engine (Cedar, OPA)

Heavy for operators, and a dynamic policy language is a prompt-injection target.

### An LLM as classifier

Prompt injection on the classifier, latency, cost; not explainable, not auditable.
