---
title: Connections
tracks:
  - apps/gateway/src/server/connections/
  - apps/gateway/src/server/compose/shipped-plugins.ts
  - apps/gateway/src/server/store/repositories/connections.ts
  - apps/gateway/src/server/store/resource-env.ts
  - apps/gateway/src/app/(app)/accounts/
  - apps/gateway/src/app/(app)/connections/callback/
  - apps/gateway/src/components/connections/
  - apps/gateway/tests/integration/connections/
last_reviewed: 2026-10-27
---

# Connections — handbook

Connecting a provider account, storing and refreshing its credential,
discovering and curating its resources. Spec:
[vaubaan-gateway](../spec/vaubaan-gateway.md) §0, §2.3, §4.2, §7.2; ADRs
[connect-driver-and-resource-curation](../decisions/connect-driver-and-resource-curation.md),
[one-place-to-authorize-services-token-first](../decisions/one-place-to-authorize-services-token-first.md),
[oauth-client-registered-by-the-gateway](../decisions/oauth-client-registered-by-the-gateway.md).

## Start here

- [`service.ts`](../../apps/gateway/src/server/connections/service.ts) — `ConnectionService`: the connect driver per credential kind, discovery, owner edits, revoke, transfer, reassign.
- [`credentials.ts`](../../apps/gateway/src/server/connections/credentials.ts) — `CredentialBroker`: the one place a stored credential is decrypted, refreshed, or withdrawn at the provider.
- [`oauth2-clients.ts`](../../apps/gateway/src/server/connections/oauth2-clients.ts), [`oauth-broker.ts`](../../apps/gateway/src/server/connections/oauth-broker.ts) — the two client sources of an `oauth2` plugin (registered by the gateway, or a broker's: [oauth-broker-contract](oauth-broker-contract.md)).
- [`shipped-plugins.ts`](../../apps/gateway/src/server/compose/shipped-plugins.ts) — the one provider list; picker, catalog index and tool list derive from it.
- [`discovery-after-call.ts`](../../apps/gateway/src/server/connections/discovery-after-call.ts) — discovery after a creating call (ADR [created-resources-join-the-mission](../decisions/created-resources-join-the-mission.md)).

## Invariants

- **Connect state** (`pending.ts`): 32 random bytes, consumed once whoever presents it, returned only to the session of the user who started it, for that provider only; anything else is `state-invalid`. The redirect URI is built from `public_url`, never the request host; a foreign `return_to` is refused (`return-url-refused`), never defaulted.
- **A token is checked before it is stored**: a rejected one stores nothing. A failed first discovery refuses an `api-key` connection, is recorded for `oauth2` (the code is spent), is not attempted for `ssh-key`.
- **No message in a URL**: outcomes travel as an opaque `?notice=<id>`, readable once, only by the web session it was written for. A refused form is echoed back, **never a `secret` field**.
- **A provider's error text is never shown, logged or stored** at connect or refresh (it can echo the credential): only its status in the gateway's words. The agent still gets it on a tool call (ADR [provider-error-text-stays-with-the-agent](../decisions/provider-error-text-stays-with-the-agent.md)). A plugin-worded `CredentialRefusal` is kept.
- **A plugin never receives an OAuth client secret or a brokered refresh token**: the host sends the requests that carry them. The broker keeps no token: the refresh token (opaque, sealed by the broker to this instance) is stored as `BrokerGrant { broker, refreshToken }` beside the secret and left out by `parseSecret`.
- **Status writers are conditional updates, each naming its transition**: a refresh or late callback racing a revocation never revives a connection. `revoked` is terminal and nulls the credential. Which statuses serve calls is one function, `isUnavailableConnectionStatus` (`active` and `unowned` serve).
- **Revoke in the store first, then withdraw at the provider** (bounded, never throws): the local revocation never waits on the provider.
- **A connection of another owner reads exactly like a missing one** (`not-found`).
- **The effective environment label is computed on read** (`resource-env.ts`: own label, else the connection default); the default is never written to a resource row, so clearing it un-labels inheriting resources.

## Traps

- `reassign` decides "ownerless now, new owner group has a member" **inside** the write transaction (`assignOwnerlessTo`); the service's earlier reads only choose which refusal is named.
- `revoke`, `transfer` and `reassign` write `mission-orphaned` / `mission-restored` in a `finally`, even if the act's own audit entry fails: the act is committed and the audit must say why missions stopped.
- An account made a way the plugin no longer offers (`isRetiredWay`) keeps id, resources and missions but nothing reads its secret: calls are refused before the budget, its tools leave `tools/list`. Reconnecting keeps the id.
- `invalid_client` forgets the registered client so the next connect registers again; every other account connected through it expires at its next refresh.
- A discovered ref that goes missing is never deleted, only marked stale; a row younger than 15 min is not marked stale (providers list new resources late). Tests use `agePastStaleGrace`.
- A plugin-set `env` wins over the owner's label (`label-read-only`).
- `refresh` is single-flight per connection (rotating refresh tokens are single use); a broker down is `OAuthBrokerUnavailableError` and never expires the connection: only `400 invalid_grant` on `/token` does.
- An attested broker is reached over a TLS socket of its own whose chain is not checked (`broker-channel.ts`): trust comes from the attestation naming that socket's key, never from a CA. Nothing, the broker key included, is written before the key is pinned.

## Procedures

- **Add a provider**: the plugin, a `SHIPPED_PLUGINS` entry, the dependency in `apps/gateway/package.json` (`next.config.ts` derives `transpilePackages` from it). A new credential kind changes the plugin contract: ADR first.
- **Hosted, several processes**: replace the two `// single-process only` guards (`PendingConnectStore`, `CredentialBroker` refresh) with an atomic get-and-delete and a shared lock.
- No test connects a real account: after changing a token way, connect one real account by hand and check its resources.

## Debug

- **`state-invalid` after consent** → over 10 minutes, callback opened twice, session changed.
- **`token-exchange-failed`** → `redirect_uri_mismatch` (not exactly `<public_url>/connections/callback/<provider>`) or `invalid_client`.
- **"OAuth broker '<name>' answered …"** → the broker's failure, never the connection's: `401 (invalid_key)` wrong key, `403 (return_url_not_registered)` the callback is missing at the broker, `503` down; "could not be attested" is the same outage on `/attest`.
- **"OAuth broker '<name>' is not attested (…)"** → nothing was sent: "no attested broker version admitted by this release" (measurement not on the allowlist: upgrade, or declare your own broker `attestation: none`), "a version this release does not admit" (newer or modified broker), "not bound to this connection’s key" (someone else answers on its address).
- **"not configured on this gateway"** → no `oauth_brokers` entry serves the plugin; the boot log names it.
- **A resource an agent created is not listed** → is the tool in `resourceCreatingTools`? Then the log `resource discovery after a creating call`. Resources created elsewhere appear on "Refresh" only.
- **A connection turned `expired`** → log `credential refresh rejected`; "Reconnect" keeps id and missions. Calls failing while `active` → `ProviderUnreachableError`.
- **An owner's label disappeared** → the plugin started returning `env`.
- **`ssh-key` discovery refused** → public key not in `authorized_keys`, or the host key differs from the pinned fingerprint.
