---
title: A plugin's trust level comes from its verified signature, checked offline; catalog plugins are signed keyless, private ones with a company key
status: accepted
date: 2026-11-17
---

# A plugin's trust level comes from its verified signature, checked offline; catalog plugins are signed keyless, private ones with a company key

## Context

An instance now installs archives itself, so an archive claiming to be an official plugin must be
told apart from one that is, without the instance calling anyone. The catalog must not hold a
long-lived private key, while a company's private plugin must not be named in a public log, and a
signature library matching identities loosely would let a look-alike signer pass.

## Decision

Every archive carries a manifest of its files' digests, and the signature covers that manifest. A
catalog archive is signed keyless by the catalog's release workflow (Sigstore public-good, a
message-signature bundle); the gateway verifies it offline against a trusted root embedded in each
release, and requires the exact workflow identity, issuer and repository id — never a substring
or an unanchored pattern. A private archive is signed with a company's ed25519 key, which an
administrator adds to the instance's trusted signers; an unsigned archive runs only if
`plugins.allow_unsigned` names its id, and an id of the catalog needs the Vaubaan signature.

## Consequences

- The trust level shown anywhere is computed from the verification at upload and at every start,
  never read from the archive.
- The catalog repository stays public: the public-good log does not serve a private one.
- Before an archive is published, the catalog CI verifies it against the root embedded in the oldest
  supported gateway release, so a new Sigstore key fails there first; an operator may point to a
  newer root for an air-gapped site.
- A keyless signature cannot be revoked: a compromised catalog version is answered by an advisory
  and a gateway release whose embedded deny list names its digest.

## Rejected alternatives

### A long-lived catalog key, as Grafana or a GPG-signed registry do

A secret the project must guard and rotate forever, whose leak signs anything; keyless ties each
signature to one reviewed workflow run.

### Sigstore for private plugins too

The public log would name each company's plugin repository; it stays an option for an author who
accepts that.

### The high-level signing client inside the gateway

It refreshes its trust metadata over the network about weekly; the gateway embeds only the
verification part.

### DSSE provenance attestations as the signed object

The verifier does not bind the archive to the statement, leaving that check to us; a plain
signature over the manifest is bound by the library itself.
