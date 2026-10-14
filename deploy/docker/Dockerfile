# Vaubaan Gateway — one image, one Node process (Next.js standalone server).
# Build from the repository root:
#   docker build -f deploy/docker/Dockerfile -t vaubaan-gateway:local .
# ADR: docs/decisions/docker-image-and-config-format.md
# Handbook: docs/handbook/configuration.md, deploy/README.md

# Pinned by version and by digest (multi-architecture index). One argument on
# purpose: when a digest is present the registry ignores the tag, so a
# separate version argument could be overridden without any effect. Bump the
# tag and the digest together (deploy/README.md, "What the image contains").
ARG NODE_IMAGE=node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

# ---------------------------------------------------------------------------
# base: debian-slim so the prebuilt native addons (argon2, better-sqlite3,
# ssh2's optional cpu-features) load against glibc without a compiler.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
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
# ---------------------------------------------------------------------------
FROM base AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=manifests /manifests ./
# The optional private dependency is skipped when NPM_READ_TOKEN is unset.
RUN npm ci --no-audit --no-fund

# ---------------------------------------------------------------------------
# build: next build with output: 'standalone' (apps/gateway/next.config.ts).
# ---------------------------------------------------------------------------
FROM base AS build
ARG GIT_COMMIT_SHA=unknown
ENV GIT_COMMIT_SHA=${GIT_COMMIT_SHA}
# The whole dependency tree: the hoisted node_modules and the ones npm nests
# under a workspace when two majors of a package coexist (apps/gateway/node_modules).
COPY --from=deps /app ./
COPY . .
RUN npm run build --workspace @vaubaan/gateway-app

# ---------------------------------------------------------------------------
# runner: the traced standalone output only, non-root, /data volume.
# ---------------------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN groupadd --system --gid 10001 vaubaan \
 && useradd --system --uid 10001 --gid vaubaan --home-dir /app --shell /usr/sbin/nologin vaubaan \
 && mkdir -p /data /config \
 && chown vaubaan:vaubaan /data
COPY --from=build --chown=vaubaan:vaubaan /app/apps/gateway/.next/standalone ./
COPY --from=build --chown=vaubaan:vaubaan /app/apps/gateway/.next/static ./apps/gateway/.next/static
COPY --from=build --chown=vaubaan:vaubaan /app/apps/gateway/public ./apps/gateway/public
USER vaubaan
# No VOLUME instruction: /data is mounted by the deployment (Compose volume, a
# platform volume such as Railway's, which refuses VOLUME, or `docker run -v`).
# Without a mount the database lives in the container and dies with it.
EXPOSE 3000
# Liveness through the same path the reverse proxy uses; no curl in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# Configuration: VAUBAAN_* environment variables and/or VAUBAAN_CONFIG_FILE
# (see deploy/config/). Missing keys stop the process with a named error.
CMD ["node", "apps/gateway/server.js"]
