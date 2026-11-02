---
title: A door belongs to the host — a protocol opens to plugins through an SDK capability, and its path names the provider
status: accepted
date: 2026-11-02
author: Renaud Pelissier
---

# A door belongs to the host — a protocol opens to plugins through an SDK capability, and its path names the provider

## Context

The git remote was the one plugin feature reached by something other than MCP, and it was built
around a single provider: the path `/git/<owner>/<repo>.git` named no provider, the registry
accepted at most one `gitRemote`, and the door took whichever plugin declared it. A second git
provider (GitLab, Gitea) or a second protocol (an OCI registry) would have had to choose between
copying the door and letting a plugin own a route of its own.

## Decision

A plugin never owns a route. Every door of the execution surface belongs to the host, which admits,
reads the wire, decides, and audits; a protocol opens to plugins through one optional capability of
`ProviderPlugin` in the SDK (`gitRemote` today), declared by any number of plugins. The path of such
a door names the provider — `/git/<provider>/<owner>/<repo>.git` — and the door resolves the plugin
from that segment, then checks that the mission holds a connection on that provider.

## Consequences

- A new protocol is a new door in the host and a new capability in the SDK, shaped like
  [`GitRemoteCapability`](../../packages/plugin-sdk/src/git/remote.ts): pure or provider-side
  questions only, no `Request`, no decision, no audit in the plugin.
- The "at most one plugin declares `gitRemote`" rule is gone from the registry, the door and the
  handbooks; a plugin declaring a capability is reachable by its own id and nothing else.
- The kit's `insteadOf` rewrite maps the provider's URL prefix to `<instance>/git/<provider>/`;
  missions issued before this change must take their kit again.
- The plugin contract ADR ([plugin-contract-and-credential-spec](plugin-contract-and-credential-spec.md))
  keeps its invariant: a plugin knows neither the mission, the accepted risks nor the budget.

## Rejected alternatives

### A plugin exposes an HTTP endpoint of its own

The plugin receives the request and must classify, decide and audit itself, or skip it: the
contract's invariant breaks, and every author rewrites the door's security code.

### Keep `/git/<owner>/<repo>.git` and resolve the provider from the mission

The meaning of a URL depends on who presents the key; a mission holding two git providers is
ambiguous, and `insteadOf` cannot be written.

### Treat the git remote as the one exception

The URL is a public contract: changing it after publication re-kits every mission, so the
generalization is cheapest before.
