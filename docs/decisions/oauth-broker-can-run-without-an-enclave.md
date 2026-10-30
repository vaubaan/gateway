---
title: The OAuth broker image also runs without an enclave, behind the platform's TLS, and is then declared unattested
status: accepted
date: 2026-10-30
author: Renaud Pelissier (product owner), drafted with Claude
---

# The OAuth broker image also runs without an enclave, and is then declared unattested

## Context

[oauth-broker-stateless-in-an-attested-enclave](oauth-broker-stateless-in-an-attested-enclave.md)
runs the broker only in an attested enclave. The smallest Confidential Space setup costs about
90 $ a month whatever the number of instances (a confidential VM, its surcharge, the load
balancer of the callback). An operator with a few instances and no customer asking for an enclave
cannot justify it. The only way to run the published image elsewhere was the development adapter,
whose secrets sit in the configuration and whose API speaks TLS with a self-signed key that no
ordinary client accepts.

## Decision

The published image gains a production platform, `unattested`. It opens one plain HTTP listener
for the API, the callback and `/healthz`, behind the platform's TLS, and `/attest` answers 404.
It reads each secret from one environment variable (`OAUTH_BROKER_SECRET_<NAME>`) and removes it
from `process.env` once read. Everything else is unchanged: tokens sealed to their
instance, a configuration of digests and opaque ids, provider endpoints compiled in. A gateway
reaches such a broker only when its administrator declares it `attestation: none`, and its pages
say "not attested". Moving to an enclave later needs no data move: the same image, the same
sealing key in the enclave's secret store, and the gateways switched back to `required`.

## Consequences

- Whoever operates the platform can read both secrets and, since nothing proves which code runs,
  can run a modified image: it would see every refresh token before sealing and every access token
  it refreshes, also on the plain HTTP hop behind the platform's TLS. The customer trusts that
  operator as it trusts any hosted OAuth client. Sealing still makes a leak of the secrets alone,
  or of an instance's backups alone, useless. The gateway's pages say the broker is not attested.
- One image serves both modes, so the digest alone does not tell them apart: only an attestation
  does, which is why a gateway set to `attestation: none` does not rely on the digest.
- The enclave decision is unchanged for attested brokers. No gateway admits an unattested broker
  unless its administrator writes `attestation: none`.
- The platform is still fixed by `OAUTH_BROKER_PLATFORM`. In Confidential Space the launch policy
  forbids overriding it, so an attested deployment cannot be switched to this mode by its
  operator.

## Rejected alternatives

### The development adapter in production

Its secrets would sit in the configuration, which the broker treats as public. It also attests
with unsigned evidence, which tells the gateway nothing.

### Keeping the TLS listener, with a certificate from a public authority

The key would be held by the platform or a certificate robot, never by an enclave, so ending TLS in
the process would prove nothing. It also forces two ports where most platforms expose one host.

### Waiting for a customer who asks for the enclave

Google Calendar would stay unavailable to every instance until then.
