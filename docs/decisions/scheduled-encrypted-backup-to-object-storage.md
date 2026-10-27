---
title: The instance backs itself up to S3-compatible storage, encrypted under its master key and checked before upload
status: accepted
date: 2026-10-21
---

# The instance backs itself up to S3-compatible storage, encrypted under its master key and checked before upload

## Context

The store and the master key sit on the same volume, so a local copy or a platform snapshot does
not survive the loss of that volume. A self-hoster needs an off-host copy made without a shell,
unreadable by whoever holds the bucket, and known to restore before it is relied on. Mechanics,
format and keys: handbook [store](../handbook/store.md#backup).

## Decision

The server makes the backup itself on a schedule: the `backup` command's store copy, compressed
(Brotli) then encrypted in the `vaubaan-backup` format (AES-256-GCM STREAM, file key derived from
the master key by HKDF), restored in a dry run from the exact bytes before upload, and uploaded
through the gateway's own SigV4 client.

## Consequences

- The file format is a compatibility contract: restore keeps reading every earlier version, and a
  backup restores only on an image at least as new as the one that made it.
- A master key rotation keeps the previous key while a kept backup was made under it.
- A copy that fails its self-check is never uploaded, so retention never replaces a good copy by a
  bad one.
- Decompression is bounded by the authenticated declared size, never by a ratio.

## Rejected alternatives

### The AWS SDK or a small S3 library

Dozens of packages under the audit gate for four calls, or a library that still leaves multipart
and listing to us.

### An external tool (restic, rclone, a cron container)

Cannot run the self-check, and would hold the master key in its own configuration.

### Bucket server-side encryption

The storage provider holds the key.
