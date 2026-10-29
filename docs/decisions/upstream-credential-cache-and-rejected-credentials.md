---
title: Caches on the call path never outlive revocation; only a 401 rejects a credential
status: accepted
date: 2026-10-13
---

# Caches on the call path never outlive revocation; only a 401 rejects a credential

## Context

Derived upstream credentials (a token minted from a stored key) cost a signature and a round trip
per call, and argon2id verification of a mission token is slow by design while agents call often.
The host knows no provider and a plugin holds no state, so neither can cache alone. Revocation and
rotation must still take effect on the next call, and a provider's 403 for a forbidden action must
not be read as a dead credential. Handbook [execution-door](../handbook/execution-door.md).

## Decision

The host gives `execute` a connection-scoped `ExecuteContext.credentialCache` (namespaced by
connection and row version, at most 55 minutes, in memory, dropped on a 401 or when the connection
stops being active). The verified-token cache stores a proof (bearer hash → token row id), never a
state: the token row and mission are re-read on every call. Only a 401 drops cached credentials,
refreshes and may expire a connection; any other status is an ordinary upstream failure.

## Consequences

- A credential that is a tool's result is never cached; a shared (multi-process) cache for these
  values must encrypt them.
- A dead key whose provider answers 403 fails every call visibly until reconnected, instead of a
  healthy connection expiring silently.
- The mission context is never cached.

## Rejected alternatives

### The host caches by intercepting the plugin's `fetch`

Puts provider knowledge in the host.

### A module-level cache in the plugin

Invisible to the host, impossible to drop on revocation.

### Cache the whole verified mission context

A window in which a revoked token still works.

### Refresh on 401 and 403

Would expire a healthy connection, and stop its missions, the first time a provider refuses an
action.
