---
title: Plugin arguments — a closed surface, refused in classify and execute; an executor declines with a typed refusal
status: accepted
date: 2026-10-13
extends:
  - plugin-identifiers-one-grammar-for-classify-and-execute
  - plugin-contract-and-credential-spec
---

# Plugin arguments — a closed surface, refused in classify and execute; an executor declines with a typed refusal

> Decided in the final cycle-end pass, after reading the Phase 3 plugin diffs
> line by line. Handbooks: [plugin-sdk](../handbook/plugin-sdk.md), each
> provider's handbook under `docs/handbook/providers/`; guide:
> [plugins/README.md](../../plugins/README.md).

## Context

The identifier ADR made `classify` and `execute` read an identifier through the
same function. Three gaps remained between "what was classified" and "what was
executed".

**Arguments nobody declared.** A classifier reads the arguments it knows. An
executor that forwards the whole argument object upstream (the rewrapped tools
of Vercel, Railway's GraphQL variables, Cloudflare's record body, Supabase's
Management API bodies) also sends the ones the classifier never looked at. An
agent could add `teamId`, `force`, `target` or a second `id` that the provider
honours and the decision never saw.

**Identifiers the slice grammar cannot carry.** A descriptor name, a storage
path or a function slug containing a character outside the slice grammar was
either dropped from the slice or made the classifier throw. A dropped
identifier matches a narrower pattern than the call deserves.

**An executor's "no" looked like a provider failure.** An executor that declines
a call itself (a deployment that belongs to another project, a service of
another Railway project, a recipient it will not send to) threw a plain `Error`.
The host recorded an upstream failure, and the agent received a transport error
instead of a sentence it can act on.

## Decision

### D1. The arguments of a tool are the ones its schema declares

`@vaubaan/plugin-sdk` exports `declaredArgumentsOf(tool)` and
`undeclaredArgumentDenial(declared, tool, args, routing?)`. A plugin whose
executor forwards arguments calls it **in `classify` and in `execute`**:

- in `classify`, an undeclared argument is a denial (`deny` with a sentence
  naming the argument) — the call is refused before the budget and audited as a
  refusal;
- in `execute`, the same check is the second lock: a caller of `execute` that
  did not go through `classify` cannot widen the call either.

`routing` names the arguments the host or the executor adds itself (`teamId`
and `projectId` for Vercel, `projectId` for Railway). Where the check sits
among a plugin's other checks is the plugin's: Vercel and Supabase run it after
their identifier checks, so a call wrong on both counts is told about the
identifier first; Railway runs it first.

Cloudflare DNS, Vercel, Railway and Supabase apply it on both sides. Stripe
refuses an undeclared argument in `classify` with a check of its own; its
executor, like those of GitHub, Resend, Gmail, Upstash Redis and SSH, builds
the upstream request field by field from declared arguments and forwards
nothing else, so an undeclared argument that reached it would be ignored, not
sent.

### D2. An identifier the grammar cannot carry is classified as "any"

`isSliceIdent(value)` says whether a value fits the identifier segment of a
slice; `identSegment(value)` returns it, or `ANY_IDENT` (`*`) when it does not.
A call naming such an identifier is classified on **every** instance of the
entity: it can only be accepted by a mission whose pattern covers them all. It
is never dropped and never escaped.

`sliceRoundTripIssues` and the testing kit's `assertCatalogCoverage` check that
every slice a classifier emits parses back to itself and carries no glob inside
an identifier.

### D3. An executor declines with `ExecutorRefusal`

`ExecutorRefusal` (plugin-sdk `refusal.ts`) is the one error an executor throws
to say "I will not run this, and nothing failed at the provider".
`declining(fn)` turns it into an `isError` tool result carrying the sentence;
`refusalResult(message)` builds one directly. Everything else an executor throws
is a provider failure and reaches the host unchanged (`UpstreamAuthError`,
`UpstreamHttpError`).

Stripe, Resend and GitHub were moved to it. The contract is the result, not
the class: Vercel keeps a local class of the same shape, and Railway, Supabase
and SSH return the `isError` result directly where they decline. GitHub and
Upstash Redis still throw a plain `Error` for a few conditions that are not the
provider's failure (an installation id that is not a number, a database answer
without a usable REST endpoint); they are recorded as upstream failures.

### D4. Railway binds a service to its project; a deployment stays unbound

Railway discovery now stores the services of each project in the resource
metadata, and `serviceId` is checked against the project of the mission before
any call (`readService`, `servicesOf`). `deploymentId` and the `threadId` of
the agent tools are **not** bound: the provider has no cheap lookup that names
their project. The threat-model row A18 is narrowed to those two and stays open.

> **Amended 2026-10-13** (orchestrator's decision after the final pass): the two
> are no longer forwarded. An id the plugin cannot bind to the mission's project
> is **refused**, in `classify` and in `execute`, and left out of the declared
> schema (`UNBOUND_ARGUMENTS`): `get-logs` reads the latest deployment of a
> bound service, and every `railway-agent` call starts a new conversation.
> Binding them was not possible without a lookup the classifier, which is pure,
> cannot make, and no documented call names the project of a deployment or of a
> thread. A18 is closed for these two; it now names what remains, the agent tool
> itself. Railway plugin `4.0.0`.

### D5. Versions

A plugin whose classification became stricter or whose executor now refuses
what it used to forward takes a major version (Cloudflare DNS, GitHub, Railway,
Supabase, Vercel → 3.0.0) or, before 1.0, a minor one (Resend 0.3.0, Stripe
0.4.0, Gmail 0.3.0). Upstash Redis took 2.0.1 for the REST host pin.

## Consequences

- A call that used to pass with a stray argument is now refused, with a
  sentence naming the argument. Agents that pad their calls with fields of the
  provider's own API must stop; that is the point.
- A new argument on a tool has to be declared in its schema before the
  classifier or the executor can use it: the schema is the contract in both
  directions.
- An identifier with an unusual character costs the call the wider pattern. A
  mission scoped to one function cannot touch a function whose slug the
  grammar cannot write.
- The audit trail distinguishes "the plugin declined" (a tool result with
  `isError`) from "the provider failed" (an upstream error), and the agent
  reads the reason.
- Railway missions scoped to a project can still name a deployment or a thread
  of another project of the same workspace token. Recorded as a known
  limitation and in the threat model.

## Rejected alternatives

- **Dropping undeclared arguments silently.** The call the agent believes it
  made and the call that ran would differ, and nothing would say so. A refusal
  is one round trip and teaches the caller.
- **Checking in `execute` only.** The refusal would come after the budget was
  spent and would be recorded as an executed call that failed.
- **Checking in the host, from the tool schema, for every plugin.** The host
  does not know which arguments an executor adds on its own (`routing`), and
  several providers accept open-ended bodies by design; the plugin is the only
  place that knows what it forwards.
- **Percent-encoding an identifier into the slice.** The slice would no longer
  be the name the owner wrote in a restriction, and two encodings of one name
  would be two different slices.
- **Binding a Railway deployment by listing every deployment of the project
  first.** One extra paged query per call, on an API with a tight rate limit,
  for an identifier the provider itself scopes to the token.
