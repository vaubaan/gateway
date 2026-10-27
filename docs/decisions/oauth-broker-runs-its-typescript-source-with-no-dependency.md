---
title: The OAuth broker runs its TypeScript sources as they are, with no dependency and its configuration in one environment variable
status: proposed
date: 2026-10-27
author: drafted with Claude, for the product owner's review
---

# The OAuth broker runs its TypeScript sources as they are, with no dependency

## Context

Attestation proves which code runs, not that it is right
([oauth-broker-stateless-in-an-attested-enclave](oauth-broker-stateless-in-an-attested-enclave.md)):
every line and every dependency in the broker's image is code a reviewer must read or trust. Three
needs are not obvious without a dependency: running TypeScript, creating the self-signed
certificate of its TLS key, and reading a configuration where the operator sets only environment
variables (Confidential Space's `tee-env-*`).

## Decision

`apps/oauth-broker` uses Node's standard library only (no `dependencies`) and has no build step:
Node runs `src/*.ts` by type stripping, so the image holds the very sources a reviewer reads. Its
configuration is one JSON document in `OAUTH_BROKER_CONFIG`, the only variable its launch policy
lets the operator set.

## Consequences

- Sources use erasable syntax only (`erasableSyntaxOnly`: no enum, parameter property or
  namespace).
- The X.509 v1 certificate is ~40 lines of hand-written DER signed with `crypto.sign`, verified by
  a unit test; the gateway trusts the key through the attestation, so nothing more is needed.
- A new library, or a compiled artefact, needs this decision revisited.
- The configuration is public (measured into the attestation): digests and opaque ids only.

## Rejected alternatives

### A small certificate library

`selfsigned` brings `node-forge`; `@peculiar/x509` a dozen packages: more code to trust than the
forty lines it replaces.

### Compiling to JavaScript in the image

A toolchain in the build and a compiled artefact a reviewer would have to compare with the source.

### A configuration file mounted in the container

Confidential Space allows only tmpfs mounts; the file would come from the image (not the
operator's) or be fetched at start (another moving part).
