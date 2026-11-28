---
title: The store copies itself beside its file before a start migrates it
status: accepted
date: 2026-11-28
---

# The store copies itself beside its file before a start migrates it

## Context

Migrations go forward only and an older image refuses a newer store
([embedded-store-sqlite-and-migrations](embedded-store-sqlite-and-migrations.md)): going back after
a bad release is a restore of a copy made before the upgrade. That copy depended on the operator
backing up by hand or on the scheduled backup being configured and recent; the desktop app, which
updates itself, has neither.

## Decision

When `openStore` opens a file store that already records migrations and finds some pending, it
first writes a `VACUUM INTO` copy at `<store dir>/pre-migration/<store name>.<time>.<from>-to-<to>.sqlite`
and keeps the three most recent; a copy that cannot be written aborts the boot before any
migration runs. A new store and `:memory:` are not copied. Going back is the previous image plus
`restore.mjs <copy> --force`.

## Consequences

- Every upgrade has a way back with no configuration, on a server and on the desktop app alike.
- The copy holds the same sealed secrets as the store, under the same master key, on the same
  volume: it adds no exposure the store does not already have, and it is no off-site backup.
- A start that migrates needs free space for one more copy of the store; a full disk is said at
  boot instead of half-way through a migration.

## Rejected alternatives

### Rely on the scheduled backup

Optional, off by default on a local instance, and possibly a day old when the upgrade runs.

### Down migrations

Every migration written twice, the reverse one never run until the day it is needed; data a
forward migration dropped cannot come back anyway.

### Copy before every start

Costs a full copy on every restart for nothing: a start that migrates nothing changes no schema.
