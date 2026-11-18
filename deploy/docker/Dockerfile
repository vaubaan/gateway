# Vaubaan Gateway — one image, one Node process (Next.js standalone server).
# Build from the repository root:
#   docker build -f deploy/docker/Dockerfile -t vaubaan-gateway:local .
# ADR: docs/decisions/docker-image-and-config-format.md
# Handbook: docs/handbook/configuration.md, deploy/README.md

# ---------------------------------------------------------------------------
# base: debian-slim so the prebuilt native addons (better-sqlite3,
# ssh2's optional cpu-features) load against glibc without a compiler.
# Pinned by version and by digest (multi-architecture index); every other stage
# starts from this one. Written on the FROM line itself, not through an ARG,
# so that Dependabot proposes the bumps (it does not read ARG values). When a
# digest is present the registry ignores the tag: bump both together
# (deploy/README.md, "What the image contains").
# ---------------------------------------------------------------------------
FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS base
ENV NEXT_TELEMETRY_DISABLED=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app

# ---------------------------------------------------------------------------
# manifests: only the package manifests, so the dependency layer is cached
# until a lockfile or a package.json changes (npm workspaces need every one).
# ---------------------------------------------------------------------------
FROM base AS manifests
COPY . .
RUN mkdir -p /manifests \
 && find . \( -path ./node_modules -o -path './*/node_modules' -o -path ./.git \) -prune \
      -o \( -name package.json -o -name package-lock.json -o -name .npmrc \) -print \
    | tar -cf - -T - | tar -xf - -C /manifests

# ---------------------------------------------------------------------------
# deps: full install (dev dependencies are needed to build).
# Build tools are present only as a fallback when a prebuilt addon is missing.
# The install, and the lifecycle scripts of every package it runs, run as the
# base image's unprivileged `node` user, never as root (security audit
# 2026-10-31, L12); so does the build below.
# ---------------------------------------------------------------------------
FROM base AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && chown node:node /app
USER node
COPY --from=manifests --chown=node:node /manifests ./
RUN npm ci --no-audit --no-fund

# ---------------------------------------------------------------------------
# build: next build with output: 'standalone' (apps/gateway/next.config.ts).
# ---------------------------------------------------------------------------
FROM base AS build
RUN chown node:node /app
USER node
# No commit argument: the commit /healthz reports is read from
# apps/gateway/build-commit.txt, which `git archive` stamps (export-subst);
# a context that is not an archive builds `unknown`. A build argument could be
# fed by a stale platform variable (docs/workflow/coding-workflow.md).
# The whole dependency tree: the hoisted node_modules and the ones npm nests
# under a workspace when two majors of a package coexist (apps/gateway/node_modules).
COPY --from=deps --chown=node:node /app ./
COPY --chown=node:node . .
RUN npm run build --workspace @vaubaan/gateway-app

# ---------------------------------------------------------------------------
# runner: the traced standalone output only, non-root, /data volume.
# ---------------------------------------------------------------------------
# The socle (deploy/socle.json): the catalog's signed archives of the default plugins,
# each pinned by its sha256, downloaded and unpacked; the gateway checks the catalog's
# signature of each at every start and runs it in place of the compiled copy of the same
# version (apps/gateway/src/server/plugins/socle.ts).
FROM base AS socle
COPY deploy/socle.json deploy/socle.json
COPY scripts/fetch-socle.mjs scripts/fetch-socle.mjs
RUN node scripts/fetch-socle.mjs /socle

FROM base AS runner
# VAUBAAN_PLUGINS_DIR: where an operator pins plugins, one directory each, by an image
# built FROM this one that copies the /plugin directory of ghcr.io/vaubaan/plugin-<id>:<version>
# into /plugins/<id>, or a read-only mount (deploy/README.md "Pin a plugin"). Empty here.
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    VAUBAAN_PLUGINS_DIR=/plugins
# The running gateway needs node and nothing else: the package managers of the
# base image (npm, npx, corepack, yarn) are removed. They are never run in the
# container, and they carried most of what the image scan reported
# (scripts/image-scan.sh): a vulnerable dependency of npm is not shipped.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && groupadd --system --gid 10001 vaubaan \
 && useradd --system --uid 10001 --gid vaubaan --home-dir /app --shell /usr/sbin/nologin vaubaan \
 && mkdir -p /data /keys /config /plugins \
 && chown vaubaan:vaubaan /data /keys \
 && chmod 0700 /keys \
 && chmod 0755 /plugins
COPY --from=build --chown=vaubaan:vaubaan /app/apps/gateway/.next/standalone ./
COPY --from=build --chown=vaubaan:vaubaan /app/apps/gateway/.next/static ./apps/gateway/.next/static
COPY --from=build --chown=vaubaan:vaubaan /app/apps/gateway/public ./apps/gateway/public
# The licence and its notices travel with the image (Apache-2.0 §4).
COPY --chown=vaubaan:vaubaan LICENSE NOTICE ./
# Owned by root, read-only to the server: an archive is checked, never rewritten.
COPY --from=socle --chown=root:root /socle /app/socle
# Started as root (a platform whose volume is root-owned, e.g. Railway with
# RAILWAY_RUN_UID=0), it gives /data and /keys to vaubaan and drops to it; otherwise it
# execs the server as is (deploy/docker/entrypoint.sh).
COPY deploy/docker/entrypoint.sh /usr/local/bin/vaubaan-entrypoint
RUN chmod 0755 /usr/local/bin/vaubaan-entrypoint
USER vaubaan
# /plugins stays root's: the gateway reads its plugins, it never writes them, so a
# compromised process cannot plant code that the next start would load.
# No VOLUME instruction: /data (the store) and /keys (the master key, kept
# apart from the store) are mounted by the deployment (Compose volume, a
# platform volume such as Railway's, which refuses VOLUME, or `docker run -v`).
# Without a mount the database lives in the container and dies with it.
EXPOSE 3000
# Liveness through the same path the reverse proxy uses; no curl in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# Configuration: VAUBAAN_* environment variables and/or VAUBAAN_CONFIG_FILE
# (see deploy/config/). Missing keys stop the process with a named error.
ENTRYPOINT ["/usr/local/bin/vaubaan-entrypoint"]
CMD ["node", "apps/gateway/server.js"]
