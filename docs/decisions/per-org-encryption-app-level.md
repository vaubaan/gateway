---
title: Credentials are encrypted at rest in the application with libsodium, under a key derived per connection
status: accepted
date: 2026-06-16
---

# Credentials are encrypted at rest in the application, under a key derived per connection

## Context

Provider credentials must be encrypted at rest so that a copy of the database alone reveals
nothing, with a blast radius smaller than every secret of the instance, on any host and without a
database extension. An in-database scheme (pgsodium) failed on Supabase hosted: the pooler could
not take the roles it needs.

## Decision

The application encrypts with libsodium XChaCha20-Poly1305 under a key derived per connection from
the instance master key (keyed BLAKE2b of the connection id), held outside the database. The
connection id is also the associated data, and each blob carries the master key version.

## Consequences

- Portable: any store, no extension, no special role.
- A database dump without the master key is useless; a compromised derived key exposes one
  connection; a blob moved to another row fails to open.
- The master key lives in process memory while the gateway runs: whoever operates the instance can
  read a decrypted credential.
- Shredding one connection is deleting its row; changing the master key reseals every blob
  ([master-key-rotation-reseals-every-blob](master-key-rotation-reseals-every-blob.md)).

## Rejected alternatives

### pgsodium in Postgres

Not deployable through the Supabase pooler (`SET ROLE` refused) and tied to one database.

### A single global key, no derivation

One key compromise exposes every credential, and blobs can be swapped between rows.

### An external KMS

The same trust boundary as the application for a single-host deployment, and one more service to
run.

### Zero knowledge

The gateway must decrypt a credential to call the provider.
