---
title: OAuth broker — spec
status: draft
---

# OAuth broker — spec

> **Status:** draft, for the product owner's review. The calls:
> [oauth-broker-contract](../handbook/oauth-broker-contract.md); how it runs:
> [oauth-broker](../handbook/oauth-broker.md).

## 0. Vocabulary

- **Broker** — a service that owns one OAuth client at a provider (client id, client secret, one
  redirect URI) and runs the authorization-code flow for the instances enrolled with it.
- **Instance** — a gateway enrolled with a broker, known by the digest of its broker key and of the
  return URLs on record for it.
- **Operator** — whoever runs the broker's machine, network and configuration; not trusted with
  tokens.
- **Flow** — one sign-in in progress, from the instance's start to its redeem; ten minutes at most.
- **Grant** — a one-time value the browser carries back to the instance, redeemed for its tokens.
- **Enclave** — a confidential-computing environment whose processor measures the loaded code,
  signs that measurement and encrypts memory against the host.
- **Measurement** — what the enclave's platform reports for the code it runs (for a container: the
  image digest).
- **Platform adapter** — the one part of the broker that knows the enclave platform: it produces
  the evidence and unseals the secrets.

## 1. Vision

The broker lets an instance connect a provider that offers no key a person can make and no dynamic
client registration, through one verified OAuth client, **without anyone who operates the broker
being able to use a person's tokens** — and lets anyone check that claim without trusting the
operator.

## 2. What it does

- **Start a flow** for a provider with the scopes asked, the instance's return URL (refused unless
  on record for that instance), the instance's state and PKCE challenge; the consent page carries
  the broker's own state and its own challenge.
- **Receive the browser** back from the provider, keep the code **unexchanged**, and send the
  browser to the return URL with a one-time grant or the provider's refusal.
- **Redeem** a grant only for the instance that started it, once, before it expires, with the
  verifier of its challenge; **then** exchange the code and answer the refresh token **sealed to
  that instance**, the access token, the account and the scopes. Every failure gets one answer.
- **Refresh** and **revoke**: open a sealed refresh token for the instance that sealed it only, add
  the client secret, call the provider. Another instance's or an altered token is an invalid grant.
- **Attest**: one evidence for everyone, recent, bound to the key of the TLS connection the instance
  is on, renewed every few minutes; no key or body needed to ask, and rate-limited.
- An instance may have at most 500 flows in progress, beside a bound for the whole broker, and a
  number of refreshes per hour set by the operator: the instances share one client and its quota.

## 3. What it keeps, and never keeps

- **Kept**: each provider's client secret and the key sealing refresh tokens (unsealed into memory
  at start); the enrolled instances as digests with an opaque id; flows, in memory only; the
  private key of its TLS identity, generated at start, never released.
- **Never kept**: a token past the call that carries it; an account or a record of who connected
  what; anything on disk; request bodies, tokens, codes, verifiers or keys in logs; a customer's
  name or URL in the configuration.
- Provider data never transits the broker.

## 4. Trust model

- **The code is public, minimal, reproducible and signed**: anyone rebuilds the same digest; each
  release publishes the digest and, per platform, the measurement.
- **It runs in an attested enclave** (memory encrypted, no shell, debug off); the secrets are
  released only to an enclave whose evidence carries a published measurement. The same image may
  run without one, behind the platform's TLS, with its secrets in the platform's environment: it
  then attests nothing, its operator can read both secrets and run other code that sees every
  token, and gateways reach it only declared unattested.
- **The instance verifies before it sends**: no verifier and no refresh token before the evidence
  is checked against the allowlist shipped with the gateway release and binds the account's
  key. A broker its own administrator declares unattested is the only exception, and says so.
- **The public front sees a code it cannot use**: the broker's own verifier never leaves the
  enclave.
- **What the operator decides is harmless**: enrollment is configuration; provider endpoints and
  allowed scopes are measured code, from the provider table the gateway and the broker share
  ([ADR](../decisions/oauth-brokers-managed-in-settings-with-two-client-sources.md)): a gateway
  running its own client at a provider reads the same table. The configuration is readable by anyone (it is measured into
  the evidence): it holds digests and opaque ids only.
- **A stolen instance store is worthless on its own**: its refresh tokens open only with that
  instance's broker key, until the instance is unenrolled.
- **Remaining trust**: the hardware vendor and the platform signing evidence; the owner of the
  provider project, who can create a client secret at any time; whoever holds both an instance's
  store and its broker key.

## 5. Portability

The core knows no platform. Adding one is an adapter, its published measurement and a gateway
release naming it; no data moves. A development adapter's evidence says "no enclave"; the
`unattested` adapter has no evidence at all.

## 6. Out of scope

- An administration interface, accounts, a database, any persistence.
- Proxying provider API calls.
- Restricted scopes (mail): not served.
- The gateway's side: the allowlist, the verifiers, its configuration.

## 7. Open questions

1. Rotating an instance's broker key or adding a return URL without dropping flows in progress
   (today a restart).
2. A provider that rotates refresh tokens on refresh: the refresh answer carries none.
3. After a client-secret rotation, a provider refusal that is not `invalid_grant` reads as a broker
   failure, not an expiry.
4. Whether the enclave may send its non-sensitive logs to the operator (today: yes).
5. Rotating the sealing key (tokens carry a key id) without disconnecting every instance.
6. Whether the provider's verification of the shared client accepts a broker that keeps no token.
7. Whether the client secret can be created inside the enclave, so no person ever sees one.
