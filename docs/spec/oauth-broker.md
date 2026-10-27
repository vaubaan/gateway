---
title: OAuth broker — spec
status: draft
date: 2026-10-27
---

# OAuth broker — spec

> **Status:** draft, for the product owner's review. Derived strictly from ADRs
> [oauth-broker-stateless-in-an-attested-enclave](../decisions/oauth-broker-stateless-in-an-attested-enclave.md)
> (D1 to D7) and
> [google-calendar-through-an-oauth-broker](../decisions/google-calendar-through-an-oauth-broker.md)
> (D1, D2 as amended), and the stateless ADR's amendment "review" of the same
> day. It decides nothing beyond them; what they leave open is
> listed in §7. _How_ it is built lives in the handbook
> [oauth-broker](../handbook/oauth-broker.md); the calls between a gateway and
> a broker are in [oauth-broker-contract](../handbook/oauth-broker-contract.md).

## 0. Vocabulary

| Term                 | Meaning                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Broker**           | A service that owns an OAuth client at a provider (client id, client secret, one redirect URI) and runs the authorization-code flow for the instances enrolled. |
| **Instance**         | A gateway enrolled with a broker: known by the digest of its broker key and the return URLs on record for it.                                                   |
| **Operator**         | Whoever runs the broker's machine, network and configuration. Not trusted with tokens.                                                                          |
| **Flow**             | One sign-in in progress, from the gateway's start to its redeem. Lives ten minutes at most.                                                                     |
| **Grant**            | A one-time value the browser carries back to the instance, which the instance redeems for its tokens.                                                           |
| **Enclave**          | A confidential-computing environment whose processor measures the loaded code, signs that measurement and encrypts memory against the host.                     |
| **Measurement**      | What the enclave's platform reports for the code it runs (for a container platform: the image digest).                                                          |
| **Platform adapter** | The one part of the broker that knows the enclave platform: it produces the attestation evidence and unseals the client secret.                                 |

## 1. Vision

The broker lets an instance connect a provider that offers no key a person
can make and no dynamic client registration (Google Calendar first), through
one verified OAuth client, **without anyone who operates the broker being
able to use a person's tokens** — and lets anyone check that claim without
trusting the operator.

## 2. What it does

Four things for an instance, and the browser's way back between the first two
(ADR stateless D1, contract handbook):

1. **Start a flow** for a provider, with the scopes asked, the instance's
   return URL (refused unless on record for that instance) and the
   instance's own state and PKCE challenge. Answers the provider's consent
   page, carrying the broker's own state and its own PKCE challenge.
2. **Receive the person's browser** back from the provider, keep the
   provider's code in the flow **unexchanged**, and send the browser to the
   instance's return URL with a one-time grant, or with the provider's
   refusal.
3. **Redeem a grant**: only for the instance that started the flow, once,
   before it expires, and with the verifier of the instance's challenge;
   **then** exchange the code and answer the refresh token **sealed to that
   instance**, the access token and what the provider said of the account and
   the scopes. The flow is gone afterwards. Every failure gets the same answer.
4. **Refresh**: given a sealed refresh token, open it — for the instance that
   sealed it only —, add the client secret, ask the provider, answer the
   access token. **Revoke**: the same, relayed to the provider's revocation
   endpoint. A sealed token presented by another instance, or altered, is
   refused as an invalid grant.

Each instance may have a bounded number of flows in progress (500), beside a
bound for the whole broker, so that no instance can take the broker's memory
from the others.

And one thing for the instance's trust (D4, D6): **attest** — answer the
platform's evidence that this exact code runs in an enclave, bound to the key
of the TLS connection the instance is talking on, and recent. It is one
answer for everyone, kept in memory and renewed every few minutes: no nonce
of the instance's. A replayed answer is harmless, since whoever replays it
does not hold the enclave's private key, and the instance refuses an answer
that is not recent. Anyone may ask for it, without a key and without a body:
the instance sends nothing before it has verified the connection; the broker
limits how often it is asked.

## 3. What it keeps, and what it never keeps

| Kept                                                                                                     | Never kept                                                                                                               |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| The client secret of each provider it serves (unsealed into memory at start).                            | A refresh token or an access token, past the call that carries it.                                                       |
| The key that seals refresh tokens to their instance (unsealed into memory at start).                     | A refresh token in clear outside the call: what an instance keeps is sealed.                                             |
| The enrolled instances, as digests: of each broker key, of each return URL on record, with an opaque id. | An account, an email, a record of who connected what once a flow is gone. A customer's name or URL in the configuration. |
| Flows in progress, ten minutes at most, in memory only.                                                  | Anything on disk. Request bodies, tokens, codes, verifiers or keys in logs.                                              |
| The private key of its own TLS identity, generated at start, never released.                             |                                                                                                                          |

Provider data never transits the broker: the instance calls the provider with
the access token.

## 4. Trust model

- **The operator is not trusted with tokens.** It controls the machine, the
  network, the DNS, the public front and the configuration (enrollment). It
  must not be able to read a token, a secret or a code that can be exchanged.
- **The code is public, minimal, reproducible and signed** (D2): anyone
  rebuilds the same image digest from the source; the image is signed
  keylessly and the signature is in a public transparency log; each release
  publishes the digest and, per platform, the measurement.
- **It runs only in an attested enclave** (D3): memory encrypted, no shell,
  debug off. The client secret is released by the platform's key service only
  to an enclave whose attestation carries a published measurement. A modified
  broker starts without the secret.
- **The instance verifies before it sends** (D4, D6): before it sends a
  verifier or a refresh token, the instance checks the attestation (platform
  root of trust, debug off, measurement on the allowlist shipped with the
  gateway release) and that it binds the TLS key of the connection. A broker
  declared `attestation: none` by its own administrator is the only exception.
- **The public front sees a code it cannot use** (D6): the broker's own PKCE
  verifier toward the provider never leaves the enclave.
- **What the operator decides is harmless by construction:** the enrollment
  (which keys, which return URLs) is configuration; the provider endpoints and
  the scopes a provider may be asked for are part of the measured code, never
  configuration, so that no configuration can send the client secret elsewhere.
- **The configuration is readable by anyone.** The enclave platform measures
  the configuration into the attestation, which the broker gives to whoever
  asks. So it holds digests and opaque ids only. What remains readable: the
  broker's public URL and ports, each provider's client id (public anyway, it
  is in every consent URL), the platform settings (for Confidential Space, the
  Workload Identity Federation provider and the project holding the secrets),
  the number of instances enrolled and their opaque ids.
- **A stolen instance store is worthless on its own** (amendment "review"):
  its refresh tokens are sealed to that instance and open only with that
  instance's broker key, until the instance is unenrolled.
- **Remaining trust** (ADR consequences, amendment "review"): the hardware
  vendor and the platform that signs attestations; whoever owns the provider
  project, who can see a client secret when one is created and can create
  more at any time; whoever holds both an instance's store and its broker key,
  until that instance is unenrolled.

## 5. Portability

The core knows no platform (D5). A platform adapter produces the evidence and
unseals the secret; adding a platform is a new adapter, its published
measurement, and a gateway release that names it. No data moves, because the
broker keeps none. First platform: Google Confidential Space; second: AWS
Nitro Enclaves (D7). A development adapter exists whose evidence says "no
enclave"; an instance accepts it only for a broker declared `attestation: none`.

## 6. Out of scope

- An administration interface, accounts, a database, or any persistence.
- Proxying provider API calls (provider data never transits the broker).
- Restricted scopes (Gmail): not served (ADR google-calendar D4, rejected
  alternative "Gmail through the same broker").
- The gateway's side: the allowlist of measurements, the attestation verifier
  per platform, the `oauth_brokers` configuration.
- The commercial operation of a broker; the broker is a generic component
  anyone can run.

## 7. Open questions

Not settled by the ADRs; for the product owner.

1. **Key rotation and enrollment changes.** How an operator rotates an
   instance's broker key or adds a return URL without a window where flows
   fail (today: a restart with the new configuration drops flows in progress).
2. **A provider that rotates refresh tokens on refresh.** The refresh answer
   of the contract carries no refresh token; Google does not rotate, another
   provider might.
3. **Secret rotation at the provider.** When the client secret is rotated,
   what the broker answers for refresh tokens the provider then refuses with a
   client error rather than `invalid_grant` (today: a broker failure, not an
   expiry).
4. **Logs.** Whether the enclave may send its (non-sensitive) logs to the
   operator's logging, or must send none (the implementation chose to allow
   them; see the handbook).
5. **Rate and size limits** a shared broker applies per instance beyond the
   flows in progress (500 per instance).
6. **Rotating the sealing key.** Sealed tokens carry a key id (`v1`); how a
   second key is introduced and the first retired without disconnecting
   every instance is not settled.
7. ADR open points stand: Google's verification of a broker that keeps no
   token; creating the client secret inside the enclave.
