---
title: Railway deployment — an entrypoint that drops root, a verified build deployed by hand
status: accepted
date: 2026-10-13
extends:
  - docker-image-and-config-format
---

# Railway deployment — an entrypoint that drops root, a verified build deployed by hand

> The dogfooding instance runs on Railway. Guide:
> [deploy/railway.md](../../deploy/railway.md).

## Context

The image runs as `vaubaan` (uid 10001) and stores everything under `/data`.
Railway mounts a volume owned by root; its documented answer for a non-root
image is `RAILWAY_RUN_UID=0`, which runs the whole container as root. Railway's
edge terminates TLS and forwards the client address in `X-Real-IP`; its
documentation lists no `X-Forwarded-For` and publishes no source address range.
Railway deploys on every push of a connected branch by default.

## Decision

- **Entrypoint `deploy/docker/entrypoint.sh`** (`/usr/local/bin/vaubaan-entrypoint`):
  started as uid 0, it gives `/data` to `vaubaan` when anything there belongs to
  someone else (`chown -R`, once) and execs the server through `setpriv`
  (util-linux, already in the Debian base: no new package) as `vaubaan`, with
  no inheritable or bounding capability and `no_new_privs`; started as anyone
  else it execs the server as is. `USER vaubaan` stays in the image. The smoke
  test runs both paths, on a root-owned volume for the first.
- **Railway**: a service built from the Dockerfile
  (`RAILWAY_DOCKERFILE_PATH=deploy/docker/Dockerfile`), one volume at `/data`,
  `RAILWAY_RUN_UID=0` with the entrypoint, `PORT` honoured by the server.
- **Deploy a verified build**, not every push: automatic deployments off; the
  build that passed `npm run ci`, the end-to-end suite and the image smoke is
  uploaded with `railway up` from a clean archive of that commit.
- **`trusted_proxies` stays empty on Railway** until the address the process
  sees is verified on the deployment: the documented header is `X-Real-IP`,
  which the gateway does not read, and believing `X-Forwarded-For` from an
  undocumented range could let a client choose its own address. The cost is
  accepted risk A2 (address-keyed limits shared), which the boot log states.

## Consequences

- The image works on platforms with root-owned volumes without running the
  server as root.
- Backups are the operator's: the volume (Railway's backups, or `VACUUM INTO`
  through `railway ssh`) and, separately, the master key, without which a copy
  of the volume opens nothing.

## Rejected alternatives

- **Running as root on Railway.** The process would hold every capability of
  the container for the price of one `chown`.
- **`gosu` / `su-exec`.** A new package for what `setpriv` already does.
- **Changing the image's user to root and dropping in the entrypoint always.**
  A container started without the entrypoint (a `docker run --entrypoint`)
  would then run as root.
- **Reading `X-Real-IP`.** A new configuration surface (which header to
  believe); to decide once a real deployment shows what Railway sends (a
  question for the owner).
