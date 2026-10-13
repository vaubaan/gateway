---
title: Execution door — upstream credential cache in the plugin context, verified-token cache, and what counts as a rejected credential
status: accepted
date: 2026-10-13
extends:
  - plugin-contract-and-credential-spec
  - docker-image-and-config-format
  - atomic-budget-accounting
---

# Execution door — upstream credential cache in the plugin context, verified-token cache, and what counts as a rejected credential

> Decisions taken while building the execution MCP door (feature P1.6 of the v5
> plan) that change a public contract or settle a point the briefs left open.
> The transport itself is as decided in [[docker-image-and-config-format]] §6
> (MCP SDK v2, stateless Streamable HTTP) and is not re-decided here. Handbook:
> [execution-door](../handbook/execution-door.md).

## Context

1. **Per-call derived credentials.** The GitHub plugin mints an installation
   token from the company's App key on every `execute`: one RS256 signature and
   one round trip to GitHub before the real call. v4 kept such tokens for about
   50 minutes in the gateway. In v5 the host knows nothing about GitHub, and a
   plugin holds no state (it is a frozen object, shared by every mission), so
   neither side can cache alone.
2. **Verification cost.** A mission token is verified with argon2id — tens of
   milliseconds by design — and an agent calls the door many times a minute.
   The plan asks for "argon2 once per token per process", the spec for
   revocation and rotation that take effect at once.
3. **Provider 401 and 403.** The connections' `CredentialBroker` marks a
   connection `expired` when a forced refresh is rejected, and a credential
   that cannot be refreshed (API key, SSH key, app installation) is rejected by
   definition. Plugins raise `UpstreamAuthError` for 401 **and** 403. Forcing a
   refresh on every `UpstreamAuthError` would expire a GitHub or Stripe
   connection — and stop every mission on it — the first time the provider
   answers 403 for an action the company's app is not permitted to do, or for
   a secondary rate limit.
4. **Two hashes.** P1.3 introduced a canonical argument fingerprint for
   approvals; the audit entry still carried v4's 16-hex, order-sensitive hash.
5. **Three gaps in gateway-core's stage contracts.** The resource stage could
   only succeed or refuse with a code, while a call to an unknown tool has
   neither a target nor a code; the upstream stage could only succeed or
   throw, while a rejected refresh must reach the agent as
   `connection-unavailable`; and nothing said what the audit shows then.

## Decision

### D1. `ExecuteContext.credentialCache` — a connection-scoped cache the host provides

- `@vaubaan/plugin-sdk` gains `UpstreamCredentialCache { get, set(key, value,
ttlSeconds) }` and the optional `ExecuteContext.credentialCache`. Only
  `execute` receives it; discovery and refresh do not.
- The plugin chooses the key inside its connection and the lifetime. The host
  namespaces every entry by connection id and by the connection row's
  `updated_at`, caps the lifetime at 55 minutes, stores the entries behind the
  process's `CacheClient`, and drops a connection's entries as soon as the
  provider answers 401 or the connection stops being `active`.
- A credential that is the **result** of a tool (`github__mint_install_token`)
  is never cached: it leaves the gateway and must be minted for that call.
- GitHub keeps one installation token per repository scope for 50 minutes and
  never serves one within 5 minutes of its expiry.
- The values are live upstream credentials. They stay in process memory; a
  shared cache for them must encrypt its values.

### D2. The verified-token cache stores a proof, not a state

- Key: SHA-256 of the bearer. Value: the id of the token row the bearer
  matched. Lifetime: 15 minutes.
- On a hit, the token row and its mission are re-read from the store by
  prefix; the outcome is computed from their current status. The cache skips
  only the hash computation, whose result cannot change.
- The mission context (connections, statuses, resources, policy) is **not**
  cached: it is a handful of local reads, and a revoked mission, an expired
  connection or a stale resource must be seen by the next call.
- Hash verifications on a cache miss are limited per token prefix (30 per
  minute); beyond it the door answers 429 without computing anything.
  Concurrent first calls of one bearer share one verification.

### D3. Only a 401 is a rejected credential

- `UpstreamAuthError` with `upstreamStatus === 401`: drop the connection's
  cached derived credentials and, if there were any, retry once with the same
  stored credential; otherwise, or if that fails again, force a refresh through
  the broker and retry once. A rejected refresh leaves the connection `expired`
  (the broker's doing) and the agent receives `connection-unavailable`.
- `UpstreamAuthError` with any other status — 403 in practice — is an ordinary
  upstream failure: no refresh, no change to the connection, the provider's
  message in a tool-level error.
- This narrows the brief's "upstream 401/403 → refresh → retry → else
  `expired`" to 401.

### D4. One hash everywhere

`fingerprintArguments` (SHA-256 of the canonical JSON, 64 hex) moves to
`@vaubaan/gateway-core` and is the audit entry's `arguments_hash`. The budget
re-exports it. `hashArguments` is deleted with the v4 gateway.

### D5. Stage contracts

- `ResourceStage.resolve` may return `{ ok: false, reason }`: a structural
  rejection, audited `refused` with no code, like a classifier denial.
- An `UpstreamStage` throws `UpstreamRefusalError(refusal)` when the connection
  turns out to be unusable after the budget decision. The audit entry stays
  `decision: 'allowed'` with `upstream_error: '<code>: <message>'` and the
  consumed credit is not refunded, as for any upstream failure
  ([[atomic-budget-accounting]]); the `failed` outcome carries the refusal and
  the door answers with it.

### D6. Door posture

- No CORS: no `OPTIONS`, no `Access-Control-*` header, and a request whose
  `Origin` is not the instance's public origin is refused. v4 answered `*`.
- `tools/list` filters per provider (a connection in the mission and at least
  one accepted risk of that provider), not per tool.
- The agent label is read from `params._meta.agent`, else from the
  `X-Vaubaan-Agent` header.
- A surface rate limit that is hit is HTTP 429 with JSON-RPC code `-32002`,
  not the `rate-limited` refusal, which is per risk.
- The application moves to zod 4, the version the MCP SDK v2 depends on.

## Consequences

- A third-party plugin written before D1 keeps working (the member is
  optional); one that wants the cache reads it in `execute` only.
- GitHub calls cost one mint per repository scope per 50 minutes instead of one
  per call. A token revoked at GitHub early costs one failed call attempt,
  retried transparently.
- Revoking a mission, rotating a token, revoking a connection: effective on the
  next call, with or without a warm cache.
- A dead API key whose provider answers 403 instead of 401 is not detected:
  the connection stays `active` and every call fails with the provider's
  message until the owner reconnects. The failure is visible (tool error,
  audit `upstream_error`), the opposite failure — a healthy connection expired
  by one forbidden action — was not.
- A connection whose credential is rejected between the decision and the
  forward costs the mission one credit per attempt; the creator gives it back
  through a claim.
- Audit rows written before this change carry 16-hex hashes; rows written
  after carry 64. There is no v5 production data yet.
- Browser-based MCP clients (the MCP Inspector in a browser) cannot call the
  door directly.
- A listed tool can still be refused `risk-not-accepted` on a static mismatch,
  which the spec §4.1 says a listed tool should never be. Closing that needs
  the plugins to declare which risks each tool can touch.

## Rejected alternatives

- **The host caches by intercepting the plugin's `fetch`.** It would have to
  know which URL mints a token for which provider — provider knowledge in the
  host, the thing the plugin contract removes.
- **The plugin keeps a module-level cache.** State in a package imported as
  source by several module graphs (see [[docker-image-and-config-format]] §2),
  invisible to the host, impossible to drop when a connection is revoked.
- **Caching the whole verified mission context for a few seconds** (the plan's
  wording). Cheaper by a few local reads, at the price of a window in which a
  revoked token still works.
- **Caching unknown bearers.** A negative cache keyed by attacker-chosen input
  grows without bound and saves nothing a throttle does not.
- **Refresh on 401 and 403** (the brief). See Context 3.
- **Never expire on a 401 either, only report.** The spec's `expired` state
  ("the provider rejected the credential and refresh failed") would then never
  be reached from the execution path, and agents would keep burning budget on a
  dead connection.
- **A `refused` audit decision for the post-allow `connection-unavailable`.**
  The counter was incremented; a `refused` row would break
  `SUM(counters) == COUNT(allowed)`, the structural invariant of spec §10.
- **A second refusal-shaped code for the surface rate limit.** The eight codes
  are the spec's closed set, and `rate-limited` requires a `risk_id`.
- **Per-tool filtering of `tools/list` by probing the classifier with invented
  arguments.** The risks a tool touches depend on its arguments; a probe that
  misses would hide a callable tool.
- **Keeping `Access-Control-Allow-Origin: *`.** The door has no browser
  client among the agents it serves, and an on-prem instance should not answer
  arbitrary origins by default.
