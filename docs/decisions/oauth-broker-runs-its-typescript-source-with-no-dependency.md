---
title: The OAuth broker runs its TypeScript sources as they are, with no dependency, its certificate written by hand, and its configuration in one environment variable
status: proposed
date: 2026-10-27
author: drafted with Claude, for the product owner's review
extends:
  - oauth-broker-stateless-in-an-attested-enclave
---

# The OAuth broker runs its TypeScript sources as they are, with no dependency, its certificate written by hand, and its configuration in one environment variable

> Implementation choices made while building `apps/oauth-broker`, below the
> level ADR
> [oauth-broker-stateless-in-an-attested-enclave](oauth-broker-stateless-in-an-attested-enclave.md)
> settles. Spec: [oauth-broker](../spec/oauth-broker.md). Handbook:
> [oauth-broker](../handbook/oauth-broker.md).

## Context

ADR D2 asks for a broker that is minimal, reproducible and "small enough to be
read in an hour" (consequences), because attestation proves which code runs,
not that it is right. Every line in the image, and every dependency, is code a
reviewer must trust or read. Three things the broker needs are not obvious
without a dependency: running TypeScript, creating the self-signed
certificate of its TLS key (Node can read and verify an X.509 certificate,
not create one), and reading a configuration on a platform where the operator
sets only environment variables (Confidential Space's `tee-env-*`).

## Decision

1. **No runtime dependency.** Node's standard library only (`node:http`,
   `node:https`, `node:crypto`, `fetch`). `package.json` has no
   `dependencies`.
2. **No build step.** Node 26 runs `.ts` files by type stripping; the image
   copies `src/*.ts` and runs `node src/main.ts`. The TypeScript is written
   with erasable syntax only (`erasableSyntaxOnly`): what the reviewer reads is
   byte for byte what runs, and the image has no compiled artefact to compare.
3. **The certificate is written by hand**: a P-256 key from
   `generateKeyPairSync`, and an X.509 **v1** certificate (serial, ECDSA-SHA256,
   `CN=oauth-broker`, a year of validity, the SPKI) encoded in about forty
   lines of DER and signed with `crypto.sign`. The gateway trusts the key
   through the attestation (ADR D6), so the certificate needs nothing else.
   The unit test parses it with `X509Certificate` and verifies its signature.
4. **The configuration is one JSON document in `OAUTH_BROKER_CONFIG`**, the
   only variable the image's launch policy lets the operator set; the
   platform is fixed by the image (`ENV OAUTH_BROKER_PLATFORM`). Since the
   platform measures it into the public attestation, it holds digests and
   opaque ids only (amendment "review" of the stateless ADR).
5. **Logs may leave the enclave** (`tee.launch_policy.log_redirect=always`),
   because the broker logs no sensitive value by construction (route
   templates, statuses, durations, error class names) and an operator without
   logs cannot run a service.
6. **The image's base is the gateway's pinned `node:…-bookworm-slim`**, with
   the package managers removed and the base's `node` user (no `useradd`,
   whose `/etc/shadow` date would break reproducibility).

## Consequences

### Positive

- The whole of what runs is about 1 800 lines in one folder, plus Node.
- No supply chain to audit beyond Node and the base image; nothing for an
  attacker to slip into a lockfile.
- The image is two `COPY` layers on a pinned base: two builds give the same
  digest, checked by the release workflow itself.

### Negative / constraints

- The broker depends on Node's type stripping (stable in Node 26): no enum,
  no parameter property, no namespace in its sources.
- Hand-written DER is code to review; it is short and tested, but it is ours.
- A JSON document in an environment variable is awkward to edit, and it must
  not contain the metadata delimiter the operator picks (`~` in the handbook).
- Logs leave the enclave: a future change that logs a value would leak it;
  the integration test asserts that no secret appears in the logs.

## Rejected alternatives

### A small certificate library

`selfsigned` brings `node-forge` (a large crypto library); `@peculiar/x509`
brings a dozen packages (ASN.1 schema, tsyringe, reflect-metadata). Each is
more code to trust than the forty lines it replaces.

### Compiling to JavaScript in the image

A build stage (`tsc`) adds a toolchain to the build and a compiled artefact a
reviewer would have to compare with the source.

### A configuration file mounted in the container

Confidential Space allows only tmpfs mounts chosen by the launch policy; a
file would have to come from the image (then it is not the operator's) or be
fetched at start (another moving part).

### `log_redirect=never`

The strictest, but an operator then has no signal at all from a broker that
fails to start; the spec lists it as an open question for the product owner.

## References

- ADR [oauth-broker-stateless-in-an-attested-enclave](oauth-broker-stateless-in-an-attested-enclave.md).
- Node.js, "Modules: TypeScript" (type stripping); RFC 5280 (X.509), RFC 5758
  (ECDSA signature identifiers).
