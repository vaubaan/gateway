---
title: The server never runs as root; the image entrypoint drops privileges when started as root
status: accepted
date: 2026-10-13
---

# The server never runs as root; the image entrypoint drops privileges when started as root

## Context

The image runs as `vaubaan` (uid 10001) with all its state under `/data`. Platforms such as Railway
mount a root-owned volume and their only answer for a non-root image is to start the whole
container as root (`RAILWAY_RUN_UID=0`). The process holds the master key and every decrypted
credential, so it must not hold container capabilities as well.

## Decision

`deploy/docker/entrypoint.sh` started as uid 0 gives `/data` to `vaubaan` if needed, then execs the
server through `setpriv` as `vaubaan`, with no inheritable or bounding capability and
`no_new_privs`; started as anyone else it execs the server as is. `USER vaubaan` stays in the image.

## Consequences

- Any host that must start the container as root (root-owned volume) is supported without the
  server running as root.
- The image smoke test runs both paths; a new entrypoint step must keep working under both.
- Nothing the server needs may require root at run time: setup that does belongs in the image
  build or in the entrypoint before the drop.

## Rejected alternatives

### Run as root on such platforms

The process would hold every container capability to save one `chown`.

### `gosu` or `su-exec`

A new package for what `setpriv`, already in the Debian base, does.

### Image user root, always dropping in the entrypoint

A container started with another `--entrypoint` would run as root.
