---
title: Plugin contract, credential spec, macro-actions and the single registry
status: accepted
date: 2026-10-13
---

# Plugin contract, credential spec, macro-actions and the single registry

## Context

Plugins are the unit of community contribution, so a third party depends on their API. The v4 code
had no such API: plugins were duck-typed adapters importing the gateway's row types, every catalog
had a hand-mirrored TypeScript twin, the provider list was duplicated in eleven places, and
credential acquisition was spread over provider-specific routes.

## Decision

A plugin is a `ProviderPlugin` validated by `definePlugin` at import; it imports
`@vaubaan/plugin-sdk` only and knows neither the mission, the accepted risks nor the budget. It
declares how it is connected (`CredentialSpec`: `api-key`, `oauth2`, `ssh-key`) and the host runs
every flow; its YAML catalog is its only catalog artefact. One `PluginRegistry` is built from the
shipped plugins, and nothing else in the repository enumerates providers.

## Consequences

- A plugin is written, tested and reviewed without the gateway; it receives `fetch` injected, never
  reads `process.env`, and never sees a client secret or the stored ciphertext.
- A catalog risk is never renamed or removed, only `deprecated` with `replaced_by`; macro-actions
  ship in the catalog and what they write is copied into the mission policy at issuance.
- Every plugin runs the SDK test kit (well-formed, catalog coverage, no wildcard, macro-actions,
  identifiers); `plugins/_template` is the reference.
- Changing this contract breaks third-party plugins: it moves only by a decision, with the
  versioning rules of the [plugin-sdk handbook](../handbook/plugin-sdk.md).

## Rejected alternatives

### Keep the duck-typed adapter and document it

A contract that lives in the host's call sites cannot be discovered, and nothing stops a plugin
from importing the gateway.

### Plugins implement their own connect routes

Spreads OAuth security details (PKCE, state, redirect validation) across code by different authors.

### Keep the TypeScript catalog twins

Two sources of truth for the security artefact under review.

### Persist a macro-action or cran reference on the mission

A macro-action changed in a later plugin version would silently alter running missions.

## Amendment 2026-10-31: a slim, versioned contract and one way to call a provider

### Context

The SDK was about to be published for plugins written outside the repository, and the contract
carried hooks no host called (`normalizeForCaps`, `normalizeArgs` behind a flag shipped off), the
main entry re-exported 1 400 lines of git wire code one plugin uses, twelve plugins each wrote
their own `fetch → 401/403 → status → JSON` wrapper and five their own JSON-RPC client, and the
package had kept version 0.1.0 through several breaking changes.

### Decision

- The contract holds only what a host uses. `normalizeForCaps`, `normalizeArgs` and the host flags
  are removed; a later cap stage adds its hook back as an optional member.
- Three entry points: `@vaubaan/plugin-sdk` (the contract, the catalog, the transport),
  `@vaubaan/plugin-sdk/testing` (the kit, with what plugin tests need of the policy engine) and
  `@vaubaan/plugin-sdk/git` (the git wire code and `GitRemoteCapability`). A plugin imports these
  and nothing else of the gateway, its tests included: a lint rule holds it.
- The SDK's transport is the one way to call a provider: `httpJson` (or `upstreamFailure` and
  `readBounded` for a body read by hand) and the upstream MCP client (`mcpRequest`,
  `callUpstreamTool`). An answer is bounded, read through a type guard (`readShape`), and a failure
  is thrown typed: `UpstreamAuthError` for 401/403, `UpstreamHttpError` for another status,
  `UpstreamProtocolError` (502) for an answer the protocol does not allow, a JSON-RPC error frame
  included.
- The SDK has its own semver: it moves when the contract moves, a breaking change is a minor before
  `1.0.0`, and each is listed under "Plugin SDK" in the changelog
  ([handbook](../handbook/plugin-sdk.md), Versions of the SDK).

### Consequences

- Plugins written before the transport are listed in `plugin-transport.test.ts` and leave the list
  one by one; Miro is the worked example.
- The kit and a structural test walk slices and catalog patterns on the data model
  (`assertSlicesOnDataModel`, `catalogPathIssues`); the check joins `definePlugin` once the shipped
  catalogs have no known gap.
- Publishing needs `@vaubaan/shared` and `@vaubaan/policy-engine` published or inlined; inlining is
  recommended.

### Rejected alternatives

#### Keep the reserved hooks so a future cap stage is not a contract change

Every external author reads and reviewers carry members no host calls; adding an optional member
later is a non-breaking change.

#### A transport helper per protocol in each plugin, with a shared checklist

The checklist is what drifted: twelve copies of the 401/403 rule, the caller's `signal` dropped in
some, unbounded reads in all.
