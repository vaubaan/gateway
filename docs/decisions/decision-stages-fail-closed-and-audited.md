---
title: A decision stage that fails refuses the call and audits it; an ambiguous environment or a glob identifier is never resolved in the caller's favour
status: accepted
date: 2026-10-13
extends:
  - fallback-risk-only-when-uncategorized
---

# A decision stage that fails refuses the call and audits it; an ambiguous environment or a glob identifier is never resolved in the caller's favour

> Decided in the final cycle-end pass. Handbooks:
> [gateway-core](../handbook/gateway-core.md),
> [policy-engine](../handbook/policy-engine.md),
> [execution-door](../handbook/execution-door.md),
> [threat-model](../handbook/threat-model.md).

## Context

The call pipeline decides in three stages before anything is sent upstream:
resources, risks, budget. Three paths through them did not fail closed, or
failed closed without a trace.

**A stage that threw left no audit entry.** A classifier that throws on an
argument shape it did not expect, a catalog lookup that fails, a store error in
the budget stage: the exception went up to the door, the agent received a 500,
and the audit log had nothing. Spec §8 says every call is recorded, allowed or refused. A refusal
nobody can see is also a way to probe a classifier without leaving a trace.

**One identifier decided the environment of a call that named several.** The
environment resolver took the first resource ref it met in a slice. A slice
naming two resources — a list, or two identifier segments — in different
environments was evaluated in the environment of the first: a write to `prod`
could be judged with the acceptance of `staging`. A plugin's own `envOf`,
handed a wildcard or a list in the environment segment, returned nothing, and
the host fell back to the owner's label on the resource.

**A `*` inside an executed identifier.** A caller-side slice is a concrete call,
not a pattern. An identifier such as `feature/*` or a list value containing `*`
is matched by pattern-side globs in ways the plugin's executor may not mirror.

## Decision

### D1. A failing decision stage is a refusal, audited

`CallPipeline` runs the resource, risk and budget stages through one `attempt`.
A stage that throws anything other than a pipeline refusal becomes a `rejected`
outcome: the agent receives a generic refusal, the audit entry carries
`stageFailureReason(stage, thrown)` — the stage and the error class, never the
message, which may quote arguments — and the host is told through
`CallPipelineDeps.onStageError`, which the execution door wires to an `error`
log with the stage, the tool, the error class and the first stack frames.

The upstream stage is not part of this: a provider failure is already recorded
as one.

New structural invariant: `[inv: every-refused-call-audited]`.

### D2. Resources of one call must agree on the environment

`resourceEnvResolver` collects the environment of **every** identifier and list
value of a slice that is a resource ref of the mission. One environment: that
one. Several: `null`, and an env-scoped risk is not acceptable (`risk-not-accepted`).

### D3. A plugin says "no single environment" explicitly

`NO_SINGLE_ENV` (a symbol exported by policy-engine and re-exported by the
plugin SDK) is what an `envOf` returns when the call names a wildcard, a list
or a glob where one environment is expected. The host then resolves to `null`
and does **not** fall back to the resource label. `undefined` keeps its
meaning — "this slice says nothing about the environment, use the label".

### D4. An executed slice carries no glob in an identifier

`evaluateCall` denies an executed slice whose identifier contains `*` without
being exactly `*`, or whose list contains a value with `*`
(`carriesGlobIdentifier`). The exact `*` remains: it is how a classifier says
"every instance" (ADR plugin-arguments-closed-surface-and-typed-refusals D2).

## Consequences

- A bug in a classifier now shows up as a refused call in the audit log and an
  `error` line in the instance log, instead of a 500 with no record. It also
  means a classifier bug refuses calls rather than letting them through.
- A call that spans two environments is refused for env-scoped risks. A tool
  that legitimately works across environments must be modelled with a risk that
  is not env-scoped.
- The audit reason of a stage failure is deliberately poor (`stage` and error
  class). The detail is in the instance log, which the operator controls.
- Branch-like identifiers containing a literal `*` cannot be executed. None of
  the shipped providers accepts one.

## Rejected alternatives

- **Letting the exception reach the door and auditing there.** The door does not
  know which stage failed or what was already decided, and every future door
  would have to repeat it.
- **Putting the error message in the audit reason.** Error messages of
  classifiers and stores quote arguments; the audit log is read by people who
  are not allowed to see them.
- **The strictest environment wins when resources disagree.** "Strictest" is not
  defined: environments are labels of the owner, not an ordered scale.
- **Returning `null` from `envOf` for "no single environment".** `null` and
  `undefined` are too easily exchanged by a plugin author; the difference
  between "refuse" and "fall back to the label" deserves a name.
