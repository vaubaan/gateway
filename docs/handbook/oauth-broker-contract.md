---
title: OAuth broker contract — the calls between the gateway and a broker, and the attestation
tracks:
  - apps/gateway/src/server/accounts/oauth-broker.ts
  - apps/gateway/src/server/accounts/broker-channel.ts
  - apps/gateway/src/server/accounts/broker-attestation.ts
  - apps/gateway/src/server/accounts/attestation-gcp.ts
  - apps/gateway/src/server/accounts/broker-measurements.json
  - apps/gateway/tests/support/accounts/fake-oauth-broker.ts
  - apps/gateway/src/server/config/oauth-brokers.ts
  - packages/oauth-providers/src/providers.ts
last_reviewed: 2026-11-05
---

# OAuth broker contract — handbook

What a broker implements so an instance connects a provider through it; read by broker authors
outside this repo. ADRs:
[google-calendar-through-an-oauth-broker](../decisions/google-calendar-through-an-oauth-broker.md),
[oauth-broker-stateless-in-an-attested-enclave](../decisions/oauth-broker-stateless-in-an-attested-enclave.md).
The reference broker: [oauth-broker](oauth-broker.md). To the gateway a broker is a URL, a key and
an `attestation` mode ([configuration](configuration.md)).

## Start here

- [`oauth-broker.ts`](../../apps/gateway/src/server/accounts/oauth-broker.ts) — the calls.
- [`broker-channel.ts`](../../apps/gateway/src/server/accounts/broker-channel.ts) — the pinned
  TLS connection, `/attest`, timeouts.
- [`attestation-gcp.ts`](../../apps/gateway/src/server/accounts/attestation-gcp.ts) — its header
  lists every claim checked in a Confidential Space token.
- [`fake-oauth-broker.ts`](../../apps/gateway/tests/support/accounts/fake-oauth-broker.ts) — the
  reference behaviour; `oauth-broker.test.ts` pins every case below.

## Invariants

- **The broker keeps no token**: only the client secret, the enrolled instances (key digests,
  return URLs on record) and flows (10 minutes). The instance keeps the refresh token, **opaque**
  to it (the reference broker seals it to the instance), and presents it at every refresh.
  Provider data never transits the broker.
- **Nothing is sent before the TLS key is pinned.** The gateway opens its own TLS connection
  (chain not checked, no reuse), hashes the presented key (`base64url(SHA-256(DER SPKI))`), and
  without a pin calls `POST /attest` on it, **no body, no `Authorization`**. The evidence must name
  that hash as its only nonce, be issued ≤ 10 minutes ago, and carry a measurement on
  `broker-measurements.json` (today OAuth broker 0.1.0 on Confidential Space; any other: "no
  attested broker version admitted by this release"). The key is pinned for min(`exp`, 1 h); another key later means one
  new attestation, then nothing.
- **No gateway nonce**: the broker serves one cached evidence, refreshed every 5 minutes. A replay
  is harmless: the replayer cannot present the enclave's key. One TLS key per broker, so one
  replica per address (each enrolled as its own block).
- `attestation: none` (an administrator's own broker): ordinary HTTPS, system CAs, no `/attest`;
  the pages say "not attested". Nothing in the configuration widens the allowlist.
- **`provider` and `scopes` come from one table**:
  [`@vaubaan/oauth-providers`](../../packages/oauth-providers/src/providers.ts), which the reference
  broker compiles in. The gateway refuses to boot when a brokered plugin names a provider the table
  does not list, or a scope outside that provider's `allowedScopes`; a broker of another author
  serves at least those ids and scopes.

## Transport

- JSON, UTF-8, every call a `POST`; base URL a root with a port (`https://api.broker.example:8443`,
  a TCP passthrough to the enclave), a path kept as prefix. The browser callback is on a separate
  public HTTPS front. An unattested broker may serve both on one host, port 443 implied
  (`https://broker.example.com`).
- `Authorization: Bearer <key>` on every call but `/attest`; the key identifies the **instance**,
  every flow is bound to it; never in a body, URL or redirect.
- No redirect followed (3xx is a failure); answers ≤ 256 KiB; 15 s per request, 30 s for a call
  that first attests (the attestation is shared by waiting calls).

## The calls

| Call                         | Request                                                                      | Answer                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `POST /attest`               | no body, no key                                                              | `200 { platform, evidence }` (`gcp-confidential-space`: the launcher's JWT)                                     |
| `POST /flows`                | `provider`, `scopes`, `return_url`, `state`, `challenge`, `challenge_method` | `201 { authorize_url }`                                                                                         |
| browser back to `return_url` | —                                                                            | `?grant=<one-time>&state=…` or `?error=<protocol code>&state=…`, nothing else                                   |
| `POST /grants/redeem`        | `grant`, `verifier`                                                          | `200 { refresh_token, access_token, expires_at, account, scopes }`                                              |
| `POST /token`                | `provider`, `refresh_token`                                                  | `200 { access_token, expires_at, scopes? }`; the broker writes nothing                                          |
| `POST /revoke`               | `provider`, `refresh_token`                                                  | `204`, also when already revoked; relayed to the provider when it has a revocation endpoint; Microsoft has none |

| Field           | Rule                                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scopes`        | in full; the broker asks for these and no others; the answer gives what was actually granted                                                              |
| `return_url`    | `<public_url>/connections/callback/<plugin id>`, on record for the key's instance; any other refused                                                      |
| `state`         | 20-128 chars `[A-Za-z0-9_-]`, returned unchanged; the gateway's, not the broker's own state at the provider                                               |
| `challenge`     | PKCE S256 of the gateway's verifier, unpadded base64url; `challenge_method` always `S256`                                                                 |
| `authorize_url` | https, the broker's client and **its own** PKCE challenge (verifier kept in the enclave); Google: `access_type=offline`; Microsoft: `response_mode=query` |
| `grant`         | opaque, URL-safe, ≥ 128 bits, a few minutes; **the first redeem attempt spends it**; the code is exchanged only after checks                              |
| `expires_at`    | ISO-8601, or `null`: the gateway then refreshes only when the provider refuses                                                                            |
| `account`       | the provider account (an email), or `null`; shown, nothing decided on it                                                                                  |

The gateway refreshes when its token expires within a minute, and on a provider 401 or 403. It
checks `state` itself (session-bound, single use, per plugin, 10 minutes).

## Errors

JSON `{ "error": "<[a-z_]{1,40}>", "message"? }`; the message is never shown or logged.

| Status         | `error`                                                    | Where             | The gateway                                                               |
| -------------- | ---------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------- |
| 400            | `invalid_grant`                                            | `/grants/redeem`  | the connect fails (unknown, spent, expired, other instance, bad verifier) |
| 400            | `invalid_grant`                                            | `/token`          | account **expired** (the provider refused the refresh token)              |
| 400            | `invalid_request`, `invalid_scope`, `unsupported_provider` | any               | broker failure                                                            |
| 403            | `return_url_not_registered`                                | `/flows`          | broker failure                                                            |
| 401            | `invalid_key`                                              | all but `/attest` | broker failure, never an expiry                                           |
| 429, 5xx, none | `rate_limited`, `temporarily_unavailable`…                 | any               | broker failure, retried later                                             |
| —              | attestation refused                                        | before any call   | broker failure: nothing sent, nothing expires                             |

- **A broker failure is never an expiry**: only `invalid_grant` on `/token` ends an account.
  Once the access token expires, provider calls fail until the broker is back.

## Outside the repo — what a broker operator provides

- Per enrolled instance: base URL, key, the recorded return URLs (one per plugin using the broker).
- For `google`: a Google Cloud project with the Calendar API enabled; a **Web application** OAuth client whose one redirect
  URI is the broker's callback; an external consent screen with the plugin's scopes and Google's
  app verification for sensitive scopes (no CASA: restricted scopes only).
- For `microsoft`: an Entra app registration, supported account types "Accounts in any
  organizational directory and personal Microsoft accounts", platform **Web**, one redirect URI
  `https://<public host>/oauth/callback/microsoft`; a client secret, pasted into
  `OAUTH_BROKER_SECRET_MICROSOFT_CLIENT_SECRET` (unattested) or stored in Secret Manager as
  `microsoft-client-secret` (enclave); the delegated Microsoft Graph permissions `User.Read`,
  `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite` (with `openid`, `email`, `profile`,
  `offline_access`); the publisher domain `vaubaan.com`, verified by Microsoft through `https://vaubaan.com/.well-known/microsoft-identity-association.json`, which the site answers from `MICROSOFT_IDENTITY_APP_IDS` ([website](website.md)); publisher verification, so people of other tenants may consent. A tenant whose
  consent policy blocks user consent needs one administrator's consent for the app. Microsoft has
  no endpoint that revokes one refresh token: `/revoke` answers 204 and sends nothing (logged
  `reason: no_revoke_endpoint`); the gateway erases its copy and the person removes the app from
  their Microsoft account.
- An enclave run and a measurement published in a gateway release ([oauth-broker](oauth-broker.md)).
