---
title: The OAuth broker keeps no token, is open source and runs only in an attested enclave the gateway verifies; the enclave platform is replaceable
status: accepted
date: 2026-10-27
author: Renaud Pelissier (product owner), drafted with Claude
amends:
  - google-calendar-through-an-oauth-broker
---

# The OAuth broker keeps no token, is open source and runs only in an attested enclave the gateway verifies; the enclave platform is replaceable

> Decided by the product owner on 2026-10-27, before any broker was built or
> enrolled. Amends D1 and D2 of
> [google-calendar-through-an-oauth-broker](google-calendar-through-an-oauth-broker.md)
> and its amendment of the same day. Handbook to rewrite when it lands:
> [oauth-broker-contract](../handbook/oauth-broker-contract.md).

## Context

ADR [google-calendar-through-an-oauth-broker](google-calendar-through-an-oauth-broker.md)
reaches Google Calendar with one verified Google OAuth client owned by a
broker. As written, the broker keeps every person's refresh token; whoever
operates it holds the means to read and change every connected calendar. Before
a broker was built, the product owner refused that break with the rule that
the operator of a shared service holds no customer secret it could use.

Moving the refresh token to the instance does not settle it alone. Google
grants an access token only to whoever presents both the client secret and a
refresh token, so the broker sees the refresh tokens pass at every refresh
(about once an hour per connection). A broker compromised while it runs reaches,
within an hour, nearly every active connection, whatever it stores.

The ways weighed to make that verifiable without trusting the operator:
detection (canary accounts, cross-counting refreshes) only notices the use of
stolen tokens after the fact; hashing the memory in software, or two servers
hashing each other, proves nothing, since a compromised machine computes and
reports its own hash, and the host can read a VM's memory without changing a
byte of its code. What does prove it is a hardware root of trust: a
confidential-computing enclave whose processor measures the loaded code, signs
the measurement with a key it never releases, and encrypts the memory against
the host.

The product owner also asked that the enclave platform not lock the broker in:
it must be possible to move to another one when needed.

## Decision

### D1 — The broker keeps no token and no account

The broker keeps the client secret of each provider it serves, the instances
enrolled with it (the digest of each broker key, the return URLs on record),
and flows in progress for ten minutes at most. Nothing else: no refresh token,
no access token, no account email, no record of who connected what once a flow
is redeemed. The instance keeps the refresh token, sealed like any other
credential. The contract of
[google-calendar-through-an-oauth-broker](google-calendar-through-an-oauth-broker.md)
D2 changes accordingly:

| Call                  | Before                          | Now                                                                                                                                                                |
| --------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /flows`         | unchanged                       | unchanged; the provider's `code` waits in the flow, unexchanged                                                                                                    |
| `POST /grants/redeem` | answers a `grant_id`            | checks the instance and the PKCE verifier, **then** exchanges the code, answers `{refresh_token, access_token, expires_at, account, scopes}`, and deletes the flow |
| refresh               | `POST /grants/<grant_id>/token` | `POST /token {provider, refresh_token}`: the broker adds the client secret, calls the provider, answers the access token, writes nothing                           |
| revocation            | `DELETE /grants/<grant_id>`     | `POST /revoke {provider, refresh_token}`, relayed to the provider's revocation endpoint                                                                            |

A broker that answers `invalid_grant` from the provider on a refresh makes the
connection `expired`, as `grant_revoked` did.

### D2 — The broker is open source, minimal, reproducible and signed

The broker's source is public, under the gateway's licence, and does one thing:
the four calls above. No admin interface, no log of request bodies, no
dependency it does not need. Its image is built reproducibly in CI (anyone
rebuilds the same digest from the source) and signed keylessly with Sigstore
cosign, the signature recorded in the Rekor transparency log. Each release
publishes the image digest and, for every supported enclave platform, the
measurement that platform will report for it.

### D3 — The broker runs only in an attested enclave

The broker runs in a confidential-computing enclave: memory encrypted by the
processor, no shell, debug off. The client secret is sealed in the platform's
key service under a policy that releases it only to an enclave whose
attestation carries a published measurement. A modified broker starts without
the secret.

### D4 — The gateway verifies the attestation before it sends anything

Before a redeem, a refresh or a revocation, the gateway obtains the broker's
attestation, bound to the TLS key of the connection or to a nonce the gateway
chose, and checks: signed by the platform's root of trust, debug off, and a
measurement on the **allowlist shipped with the gateway release**. Otherwise it
sends no verifier and no refresh token, and the connection shows the broker's
failure. A new broker version therefore reaches instances only through a
public gateway release that names its measurement.

An administrator who runs a broker of their own, outside an enclave, declares
it explicitly (`oauth_brokers.<name>.attestation: none`); the gateway then
skips the check for that broker and says so on the connection's page.

### D5 — The enclave platform is an adapter on both sides

The broker's core knows no platform. A platform adapter does two things:
produce the attestation evidence, and unseal the client secret. The gateway's
verifier has one adapter per platform, and each allowlist entry names its
platform and its measurement (an image digest, a set of PCRs, a launch
measurement). Moving to another platform is: build and publish its
measurement, ship it in a gateway release beside the old one, seal the client
secret in the new key service, switch the broker's DNS, then drop the old
entry in a later release. No data moves, because the broker keeps none (D1).

### D6 — The attestation is bound to the broker's own TLS key

The gateway talks to the broker over TLS with a key the enclave generates at
start and never releases. The gateway does not trust it through a certificate
authority: it calls `POST /attest {nonce}` on the connection, receives the
platform's attestation carrying its nonce and the SHA-256 of the enclave's
public key, and accepts the connection only if that hash is the key the
connection presented. It pins that key for the attestation's lifetime (an hour
at most) and attests again after. Whoever controls the broker's DNS or obtains
a certificate for its name still cannot pose as the enclave.

The person's browser reaches the broker's callback through an ordinary public
HTTPS front, which sees the provider's `code` and the flow id. The broker
starts each flow with a PKCE verifier of its own toward the provider, generated
and kept in the enclave, so a `code` read at the front cannot be exchanged
without it.

### D7 — First platform, and where the source lives

The first platform adapter is **Google Confidential Space**: it runs the
container image as is, its attestation is a JWT signed by Google carrying the
image digest, and Workload Identity Federation releases the client secret on a
condition over that digest. **AWS Nitro Enclaves** is the second adapter, to
prove a move works. The broker's source lives **in this repository**, beside
the gateway, so that one release carries the broker and the allowlist that
admits it.

## Consequences

### Positive

- The operator of the broker cannot read a token, and anyone can check it
  without trusting the operator: the source is public, the build reproducible,
  the measurement attested by hardware and pinned in the gateway's release.
- A stolen broker store or backup yields no token; a stolen instance store
  yields refresh tokens useless without the client secret, which never leaves
  the enclave.
- Rotating the client secret at the provider kills every refresh token
  captured anywhere, in one move.
- Changing hosting is a release and a DNS switch, not a migration.

### Negative / constraints

- **Trust in the hardware vendor** (AMD, Intel) and in the platform that signs
  the attestation remains; side-channel attacks on enclaves exist and are
  patched over time.
- **Attestation proves which code runs, not that it is right**: the broker must
  stay small enough to be read in an hour.
- **More to build**: the broker itself, the reproducible signed build, a
  verifier per platform in the gateway, and the allowlist kept in each release.
- **A broker release needs a gateway release**, and an instance that does not
  upgrade keeps refusing a newer broker until it does.
- **An enclave costs more** than an ordinary machine of the same size.
- **The client secret is seen once** by whoever creates the client at the
  provider, which shows it at creation; it is pasted straight into the key
  service and no copy is kept. Combined with a stolen instance store, that one
  moment is the remaining way around the enclave; rotating the secret closes
  it.
- **The broker's API for gateways is not on the public certificate chain**
  (D6): it needs a TCP passthrough to the enclave, beside the public front
  for browsers.
- **The contract shipped in 2.0.0-alpha.10 changes** (D1). No broker was ever
  enrolled, so no connection is affected.

## Rejected alternatives

### The broker of the original ADR, keeping the refresh tokens

One store holding the means to reach every connected calendar, active or not,
backups included. Rejected by the product owner as a break of the
no-customer-secret rule.

### A stateless broker on an ordinary host

Nothing at rest, but a broker compromised while it runs still reaches every
active connection within an hour, and nothing proves it is not. Kept as the
broker's design (D1), not as its hosting.

### Detection only: canary accounts and cross-counted refreshes

Detects the use of stolen tokens after the fact and deters by chance; proves
nothing and protects nobody before the alert. May be added on top of D3; it is
not a substitute for it.

### Hashing memory in software, or two servers hashing each other

The compromised machine computes and reports its own hash, and the host reads
memory without changing code. Software-based attestation by timing (SWATT,
Pioneer) needs known hardware and a direct link, not a cloud VM.

### Decentralised enclave networks, multi-party computation, zkTLS

Enclave networks on a blockchain (Phala, Oasis, Marlin, Lit) still rest on the
enclave, adding unknown operators and uncertain availability. Splitting the
client secret across parties that open the TLS session to the provider together
is research, not production.

### An OAuth client declared by each organisation

Keeps every secret in the organisation, at no cost, and needs no verification
for a Google Workspace domain ("Internal" app). Not chosen as the way to reach
Google Calendar: it reintroduces the per-organisation setup the broker exists
to avoid, and the administrator-declared client removed by ADR
[gmail-over-imap-with-an-app-password](gmail-over-imap-with-an-app-password.md).
May come back beside the broker for organisations that want no shared client.

### Driving a browser signed in to the person's Google account

Blocked by Google's sign-in protections, against its terms, fragile, and a
session cookie opens the whole account instead of a calendar scope.

### A single enclave platform, without adapters

Simpler, but ties the broker to one vendor's prices, regions and terms; the
product owner asked to be able to move.

## Amendment of 2026-10-27 — review

An independent review of the first implementation (`apps/oauth-broker`,
handbook [oauth-broker](../handbook/oauth-broker.md)) found that it lets
through what this decision means to rule out. Settled the same day, before
any instance was enrolled:

- **Refresh tokens are sealed to their instance.** The redeem answers the
  provider's refresh token as an opaque blob: AES-256-GCM under a key of the
  broker's, a key id prefix (`v1.`), the instance's enrollment id and the
  provider as additional data. `POST /token` and `POST /revoke` open it only
  for the instance that authenticates with the same enrollment id; any other
  key, or an altered blob, is `400 invalid_grant`, and the provider is not
  called. The key (`refresh-token-sealing-key`, 32 random bytes) is a second
  secret of the platform's key service, released under the same condition as
  the client secret and unsealed at start by the platform adapter. The
  instance already keeps the refresh token as an opaque string: the wire
  contract does not change. The positive consequence "a stolen instance store
  yields refresh tokens useless without the client secret" now holds against
  everyone, **except whoever also holds that instance's broker key, until the
  instance is unenrolled**: unenrolling it, or enrolling it again under
  another id, ends every token it holds.
- **The attestation is cached and bound to the TLS key only (D4, D6
  read precisely).** `POST /attest` takes no body and no key, and answers a
  token the broker fetched from the platform in the background, every five
  minutes and again after a failure, whose only nonce is
  base64url(SHA-256(DER SPKI)) of the API's TLS key. No nonce of the gateway's:
  what secures the channel is that the token names the key of the very TLS
  connection the gateway is on, and that it is recent (the gateway refuses
  one issued more than ten minutes ago). A replayed token is harmless:
  whoever replays it does not hold the enclave's private key, so it cannot
  complete a TLS handshake for that key. Per-request attestation let anyone
  exhaust the platform's quota and starve every gateway; a cached answer
  cannot be made to reach the platform, and is rate-limited only generously.
- **The configuration holds digests only.** The platform measures the
  container's environment, values included, into the attestation (Confidential
  Space: `submods.container.env` and `env_override`), which anyone can now
  read. Instances are enrolled with an opaque id, the SHA-256 of their broker
  key and the SHA-256 of each exact return URL; the broker compares the digest
  of the URL a flow names and sends the browser to that URL. What stays
  readable: the broker's public URL and ports, the client ids (public in every
  consent URL), the platform settings (the federation provider and the project
  holding the secrets), and how many instances are enrolled.
- **Flows in progress are capped per instance** (500), beside the cap for the
  whole broker, so that one instance cannot take the memory of the others.
- **The client secret is not seen only once.** Whoever owns the provider's
  project can create further client secrets at any time, not only when the
  client is created; the "seen once" consequence reads: the owner of the
  provider project can obtain a valid client secret whenever they choose.
  With sealed refresh tokens, a client secret and a stolen instance store
  together no longer reach a calendar: the store holds sealed blobs, which
  only the broker opens. That project owner remains trusted for what a client
  secret alone allows at the provider.

## Amendment 2026-10-27 — no gateway nonce; one key per broker

Decided in the review of the gateway client and the broker, before any broker
was enrolled. Changes D6 as follows; everything else stands. Handbook:
[oauth-broker-contract](../handbook/oauth-broker-contract.md).

- **`POST /attest` takes no body and no broker key.** A nonce chosen by each
  gateway made every call of `/attest` cost the broker a request to the
  platform's attestation service, a way to deny service by exhausting its
  quota. The broker serves instead one cached attestation, refreshed every five
  minutes, whose only nonce is the SHA-256 of its TLS public key (SPKI). The
  gateway requires it issued at most ten minutes ago and pins the key for
  min(`exp`, one hour), as before.
- **A replayed attestation is harmless.** It names the enclave's TLS key, and
  whoever replays it does not hold that key's private half: the connection it
  answers on presents another key, and the gateway sends nothing.
- **The broker key travels only on a pinned, verified connection**, never to
  `/attest`, so whoever answers on the broker's address without being the
  enclave never learns it.
- **One key per broker: the broker runs as a single replica.** Scaling out is
  one address per replica, each enrolled as its own broker.
- **The refresh token the instance keeps is opaque** to it: the broker may
  answer a sealed blob bound to the instance around the provider's token.

## Open points

- Whether Google's verification of the shared client accepts a broker that
  keeps no token: to confirm when the verification is filed.
- Whether Google offers a way to create the client secret inside the enclave,
  which would remove the one moment a person sees it.

## References

- ADRs: [google-calendar-through-an-oauth-broker](google-calendar-through-an-oauth-broker.md),
  [gmail-over-imap-with-an-app-password](gmail-over-imap-with-an-app-password.md).
- Handbook: [oauth-broker-contract](../handbook/oauth-broker-contract.md).
- Google Cloud, "Confidential Space overview"; AWS, "Nitro Enclaves
  cryptographic attestation"; Sigstore cosign and Rekor; RFC 6749 §6
  (refreshing an access token), RFC 7009 (token revocation), RFC 7636 (PKCE).
