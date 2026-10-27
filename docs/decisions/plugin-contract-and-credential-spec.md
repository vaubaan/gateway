---
title: Plugin contract, credential spec, presets and the single registry
status: accepted
date: 2026-10-13
---

# Plugin contract, credential spec, presets and the single registry

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
- A catalog risk is never renamed or removed, only `deprecated` with `replaced_by`; presets ship in
  the catalog and are copied into the mission policy at issuance.
- Every plugin runs the SDK test kit (well-formed, catalog coverage, no wildcard, presets,
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

### Persist a preset reference on the mission

A preset changed in a later plugin version would silently alter running missions.
