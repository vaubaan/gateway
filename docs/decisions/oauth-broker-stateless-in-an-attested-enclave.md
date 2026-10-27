---
title: The OAuth broker keeps no token, is open source and runs only in an attested enclave the gateway verifies; the enclave platform is replaceable
status: accepted
date: 2026-10-27
author: Renaud Pelissier (product owner), drafted with Claude
---

# The OAuth broker keeps no token and runs only in an attested enclave the gateway verifies

## Context

Google Calendar is reached through one verified OAuth client owned by a shared broker. A broker
keeping refresh tokens lets its operator read every connected calendar, against the rule that a
shared service's operator holds no usable customer secret. Moving the tokens to the instance is not
enough: Google refreshes with client secret plus refresh token, so a broker compromised while
running still sees every active connection. Only a hardware root of trust proves which code runs.

## Decision

The broker keeps only each provider's client secret, the enrolled instances (as digests) and flows
in progress (ten minutes at most); the instance keeps the refresh token, which the broker seals to
that instance's enrollment. The broker is open source, built reproducibly and signed, and runs only
in an attested enclave: before sending a verifier or a refresh token, the gateway checks a recent
attestation that names the TLS key of the very connection it is on and a measurement on the
allowlist shipped with its own release.

## Consequences

- A broker release needs a gateway release (the allowlist ships with it); both live in this
  repository. A self-run broker outside an enclave is declared `attestation: none` and shown so.
- The enclave platform is an adapter on both sides (evidence, unsealing; verifier); moving is a
  release and a DNS switch, no data moves. First Google Confidential Space, then AWS Nitro.
- The platform measures the broker's configuration into a public attestation: it holds digests and
  opaque ids only. One TLS key per broker, so one replica per enrolled address.
- Trust in the hardware vendor and the provider-project owner remains; the broker must stay small
  enough to read in an hour.

## Rejected alternatives

### A broker keeping the refresh tokens

One store reaching every connected calendar, backups included.

### A stateless broker on an ordinary host

Compromised while running, it still reaches every active connection, and nothing proves it is not.

### Hashing memory in software, or detection by canary accounts

A compromised machine reports its own hash; detection notices stolen tokens only after their use.

### A nonce chosen by each gateway on every attestation

Each call would cost a request to the platform's attestation service, a quota anyone could exhaust;
a cached attestation bound to the TLS key is as safe, since a replayer lacks the private key.

### An OAuth client declared by each organisation

Reintroduces the per-organisation setup the broker exists to avoid.
