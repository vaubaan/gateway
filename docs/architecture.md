---
title: Architecture in ten minutes
---

# Architecture in ten minutes

The path of a request through Vaubaan Gateway, for a person reading the code for the first time.
Each part links to its handbook, which names the files to open first. The words are the protocol's
(account, risk, budget, gate); the interface calls the same things account, permission, limits
and "ask me first" ([README, Words](../README.md#words)).

## One process, two ways in

```
 coding agent                                               person
 (mission token)                                            (browser session)
      │                                                           │
      ▼                                                           ▼
 EXECUTION DOOR                                             WEB INTERFACE
 POST /mcp, /mcp/catalog, /git/<provider>/…                 pages under apps/gateway/src/app
      │                                                     answers requests, edits missions
      ▼                                                           │
 CALL PIPELINE (packages/gateway-core)                            │
  1 admission: token, mission state, resource                     │
  2 plugin.classify(call)  ──►  slices                            │
  3 policy engine: slices ──► risks ⊆ accepted?                   │
  4 budget: quota, rate limit, gate                               │
  5 plugin.execute(call, credential)  ──►  provider API           │
    (the `vaubaan` plugin: the host's own mission service)        │
  6 audit entry, allowed or refused                               │
      │                                                           │
      ▼                                                           ▼
 STORE (one SQLite file): accounts and encrypted credentials, shares,
 missions, token digests, counters, requests, audit
```

Everything runs in one Node process with one embedded database. Nothing is shared between two
processes; the [known limitations](handbook/known-limitations.md) list what that rules out.

## The execution door

An agent sends MCP `tools/list` and `tools/call` to `/mcp` with its mission token as a bearer. The
door admits the request (origin, token digest, rate limit of the surface), rebuilds the mission's
context from the store, and hands the call to the pipeline. Nothing is cached between requests: a
revoked or rotated token is refused on its next call. The git remote under `/git/` uses the same
admission, with the token as the Basic password, and decides a push ref by ref.
Handbooks: [execution-door](handbook/execution-door.md), [git-remote](handbook/git-remote.md).

## The call pipeline

`packages/gateway-core` holds the stage order, the typed refusals and the audit entry; the
application supplies the stages. A stage that refuses ends the call with a structured refusal
(`risk-not-accepted`, `budget-exhausted`, `approval-required`…) that tells the agent what to do,
and every call, allowed or refused, writes one audit entry. Handbooks:
[gateway-core](handbook/gateway-core.md), [budget-and-sessions](handbook/budget-and-sessions.md),
[audit](handbook/audit.md).

## The policy engine

`packages/policy-engine` is pure: no input or output, no state. It matches the slices a plugin
emitted (`github.repo[acme/app].branch[main].W`) against the patterns of the plugin's risk catalog,
and returns the risks the call touches. The call passes only if the mission accepted every one of
them, each by its explicit identifier: no wildcard is ever stored. Handbook:
[policy-engine](handbook/policy-engine.md); the model itself:
[gateway-risk-model](spec/gateway-risk-model.md).

## The plugins

One folder per provider under `plugins/`, written against `@vaubaan/plugin-sdk`. A plugin
describes the provider's data model, ships its risk catalog (`risk-catalog.yaml`), classifies each
call into slices, declares how a credential is obtained, discovers resources, and executes the call
with the credential the gateway hands it. A plugin classifies; it never decides. The registry in
`apps/gateway/src/server/compose/shipped-plugins.ts` is the only list of providers. Guide:
[`plugins/README.md`](../plugins/README.md); handbooks: [plugin-sdk](handbook/plugin-sdk.md),
[providers](handbook/providers/README.md).

## The gateway's own management tools

An agent that prepares missions for other agents does it like any other work: through a mission on
the person's **Vaubaan account**, a service of its own (`plugins/vaubaan`), whose `vaubaan__*` tools
read what that person may put in a mission, preview a policy and issue, rotate or revoke missions
under the person's name. The call passes the same door, budget and audit; the plugin's `execute` is
bound by the host to the mission service, never through the SDK. It executes no other provider's
tool and answers no request: approvals and claims are answered in the browser only, and a mission
never rotates or revokes itself. Handbook: [providers/vaubaan](handbook/providers/vaubaan.md).

## The store

One SQLite file on the data volume, migrated at start, reached only through repositories.
Credentials are encrypted under the instance's master key and decrypted in memory for the length of
a call; mission tokens are stored as digests. A scheduled backup encrypts a copy to S3-compatible
storage. Handbooks: [store](handbook/store.md), [configuration](handbook/configuration.md),
[threat-model](handbook/threat-model.md).

## Where to go next

- What the product does and why: [spec](spec/vaubaan-gateway.md).
- Why a choice was made: [decisions](decisions/).
- Every subsystem: [handbook index](handbook/README.md).
- Working with a coding agent: [AGENTS-guide](AGENTS-guide.md).
