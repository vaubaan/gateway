---
title: Deploying Vaubaan Gateway — the image, for maintainers
status: current
date: 2026-10-13
last_synced: 2026-11-20
tracks:
  - deploy/docker/
  - deploy/compose.yaml
  - deploy/caddy/
  - deploy/config/
  - deploy/collector/
  - .github/workflows/ci.yml
  - .github/workflows/release.yml
  - apps/gateway/tests/unit/structural/base-images-pinned.test.ts
---

# Deploying Vaubaan Gateway

One image, one process, one SQLite file on a volume, behind your TLS
terminator. Decisions and rationale: ADR
[docker-image-and-config-format](../docs/decisions/docker-image-and-config-format.md);
every configuration key: handbook
[configuration](../docs/handbook/configuration.md).

**Installing or operating an instance?** The procedures live on the site, one
page each
([ADR](../docs/decisions/user-and-author-docs-live-on-the-site.md)):

| To                                         | Read                                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| install with Docker Compose                | [vaubaan.com/docs/install/docker-compose](https://vaubaan.com/docs/install/docker-compose)   |
| install on Railway                         | [vaubaan.com/docs/install/railway](https://vaubaan.com/docs/install/railway)                 |
| run the image behind your own proxy        | [vaubaan.com/docs/install/own-proxy](https://vaubaan.com/docs/install/own-proxy)             |
| pull and verify a released image           | [vaubaan.com/docs/install/verify-an-image](https://vaubaan.com/docs/install/verify-an-image) |
| install, pin or activate a plugin          | [vaubaan.com/docs/operations/plugins](https://vaubaan.com/docs/operations/plugins)           |
| health, logs, retention, proxy, git remote | [vaubaan.com/docs/operations](https://vaubaan.com/docs/operations)                           |
| back up, restore, rotate the key, upgrade  | [vaubaan.com/docs/operations](https://vaubaan.com/docs/operations)                           |
| run your own OAuth broker                  | [vaubaan.com/docs/operations/oauth-broker](https://vaubaan.com/docs/operations/oauth-broker) |
| community telemetry                        | [vaubaan.com/docs/operations/telemetry](https://vaubaan.com/docs/operations/telemetry)       |

This file keeps what a maintainer of the image needs: the file map, the smoke
test, and what the image contains.

```
deploy/
  docker/Dockerfile        multi-stage build (node:26.13.1-bookworm-slim pinned by digest, non-root, HEALTHCHECK)
  docker/smoke.sh          container smoke test (run by CI and, per architecture, by the release pipeline)
  docker/entrypoint.sh     started as root (a root-owned volume), gives /data to uid 10001 and drops root
  railway.md               what the image does on Railway (the procedure is on the site)
  compose.yaml             gateway + data volume + key volume + Caddy (automatic TLS)
  caddy/Caddyfile          reverse proxy, streaming-friendly (the gateway sets the security headers)
  config/gateway.example.yaml  every key, documented, all commented out
  config/.env.example          every environment variable, documented
  collector/schema.sql     the community telemetry collector (optional; not part of an instance)
  collector/README.md      how the project runs it, what it stores, the published thresholds
```

## Released images

Every release publishes one image for `linux/amd64` and `linux/arm64` at
`ghcr.io/vaubaan/gateway`, with a signed build-provenance attestation and an
SBOM per architecture; a release cut while the repository is private is
`linux/amd64` only, without attestation, and its notes say so. The tags, the
verify commands and the identity to expect:
[verify an image](https://vaubaan.com/docs/install/verify-an-image). How a
release is cut and what a version promises:
[`docs/workflow/coding-workflow.md`](../docs/workflow/coding-workflow.md#release).

## Pin a plugin

Moved to the site: [plugins on an instance, Pin a plugin](https://vaubaan.com/docs/operations/plugins#pin-a-plugin)
(installing from Administration, trusted signers and safe mode are on the
same page). Internals: handbook [plugin-loading](../docs/handbook/plugin-loading.md).

## Operations

Moved to the site: [operations](https://vaubaan.com/docs/operations). One
check stays here, for maintainers.

**Smoke test an image**: `npm run docker:build && npm run docker:smoke`
(`deploy/docker/smoke.sh vaubaan-gateway:local`; needs Docker and curl)
checks the fail-fast exit (within 60 seconds), the https rule, `/healthz`,
secret redaction, native addons, the non-root user, that no env file and no
test, fixture or demo file of the repository is shipped, the security
headers of a page, and a start as root on a root-owned volume (the server
still runs as uid 10001, without capability). `SMOKE_EXPECT_VERSION`,
`SMOKE_EXPECT_COMMIT` and `SMOKE_EXPECT_ARCH` (`x64`, `arm64`) make it also
check what `/healthz` answers and the architecture of the image, as the
release pipeline does. The version and the commit are compared with the body
of one more `/healthz` answer, which the script keeps and prints when a stamp
is not the expected one.

The community telemetry collector, the other end of an instance's opt-in
reports, is described in [`collector/README.md`](collector/README.md): what
it stores, the published validation thresholds, how to keep addresses out of
its logs. You do not need it to run a gateway.

## What the image contains

Next.js 16 standalone output built with Turbopack (`apps/gateway/server.js`,
traced `node_modules`, `.next/static`, `public`), running as uid 10001. The
entrypoint (`deploy/docker/entrypoint.sh`) execs the server as is; started as
root — a platform whose volume is root-owned, such as Railway with
`RAILWAY_RUN_UID=0` — it first gives `/data` to uid 10001 when anything there
belongs to someone else, then drops to that user with `setpriv` (no
capability, no new privilege). The smoke test runs both.
`compose.yaml` adds what the platform can enforce: a read-only root
filesystem, every capability dropped, `no-new-privileges`, and `/tmp` as a
tmpfs; the server writes nothing but `/data` and `/tmp`. Give the same four
settings on another platform when it offers them; the smoke test runs the
server with them.
Native addons (`argon2`, `better-sqlite3`) are prebuilt for glibc, which is
why the base is Debian slim rather than Alpine; `next.config.ts` traces
their binaries and runtime files explicitly (`outputFileTracingIncludes`)
and the smoke test loads both inside the image. The image takes **no
build argument**: the commit shown by `/healthz` is read from
`apps/gateway/build-commit.txt`, which `git archive` stamps
(`export-subst`; the CI runs `scripts/stamp-commit.sh` on its checkout);
a context that is not stamped builds `unknown` (see
[coding-workflow](../docs/workflow/coding-workflow.md)). The base image is not an argument:
it is written, with its digest, on the first `FROM` line. Nothing else than
`node` runs in the container: the package managers of the base image (npm,
npx, corepack, yarn) are removed from it, and the smoke test checks it.
Beside the server, `apps/gateway/import-v4.mjs` is the one-shot importer of
a v4 organization, bundled into the standalone output at build time; it
refuses to run as root, so on Railway it is started through
`vaubaan-entrypoint` (handbook
[import-from-v4](../docs/handbook/import-from-v4.md)).

The Dockerfile has no `# syntax=` line: it is built by the frontend built
into BuildKit (it uses no heredoc, no `--mount` and no `--link`), so no
frontend image is pulled and run at build time. Every `COPY --from=` names a
stage of the file, never an image. The structural test
`apps/gateway/tests/unit/structural/base-images-pinned.test.ts` holds both:
a frontend line that appears must be pinned by digest like the base images.

Both base images are pinned by full version and by digest, so one commit
builds one image: `node:26.13.1-bookworm-slim` in the Dockerfile and
`caddy:2.11.9-alpine` in `compose.yaml`. The digests are those of the
multi-architecture index. To bump one, read the new digest from the registry
and change version and digest together:

```bash
docker buildx imagetools inspect node:<version>-bookworm-slim   # "Digest:" line
docker buildx imagetools inspect caddy:<version>-alpine
```

The digest is what is pulled: once it is present the registry ignores the
tag, which is why version and digest are written together on one line. The
base must stay a Debian (glibc) image. Dependabot proposes the bumps every
week (a new major of Node excepted: the runtime of the image is a decision);
they are also checked by hand before every release and on a Node or Debian
security release — the procedure is in
[`docs/workflow/coding-workflow.md`](../docs/workflow/coding-workflow.md#refreshing-the-base-image-digests).
