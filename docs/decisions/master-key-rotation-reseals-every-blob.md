---
title: A master-key rotation seals every stored blob again, with a command shipped in the image
status: accepted
date: 2026-10-13
---

# A master-key rotation seals every stored blob again, with a command shipped in the image

## Context

Every stored secret (credentials, instance secrets, sealed approval arguments) is an AEAD blob
sealed under a key derived from the master key, tagged with its `key_version`. Keeping the old key
in `VAUBAAN_MASTER_KEY_PREVIOUS` let old blobs need it forever: after a suspected leak, a rotation
changed nothing for stored credentials and the leaked key had to stay configured.

## Decision

A rotation ends with the `reseal` command shipped in the image: it opens every sealed blob, seals
the stale ones under the current key with compare-and-swap writes, and only its clean report allows
removing the previous key. The gateway never reseals on its own, at boot or on read.

## Consequences

- Every sealed column is listed once in `store.sealedBlobs`; a new sealed column must join it or it
  is left under the old key.
- After a reseal the old key opens nothing in the store but still opens earlier backups: keep it
  with them or destroy them.
- The boot probe warns about a version no configured key opens; it never refuses to start.
- The procedure (backup, deploy both keys, dry run, `--apply`, remove the previous key) is in the
  [configuration handbook](../handbook/configuration.md), "Rotating the master key".

## Rejected alternatives

### Reseal at boot

Every restart rewrites blobs under a write lock while serving, and a missing key turns boot into a
partial migration.

### Lazy reseal on read

Unread blobs stay under the old key forever, so the operator never knows when the previous key may
go.

### "Reconnect every account" as the rotation

Loses curation and shares, and leaves instance secrets and pending approval arguments under the old
key.
