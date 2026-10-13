# Deploying Vaubaan Gateway

One image, one process, one SQLite file on a volume, behind your TLS
terminator. Decisions and rationale: ADR
[docker-image-and-config-format](../docs/decisions/docker-image-and-config-format.md);
every configuration key: handbook
[configuration](../docs/handbook/configuration.md).

```
deploy/
  docker/Dockerfile        multi-stage build (node:22-bookworm-slim, non-root, HEALTHCHECK)
  docker/smoke.sh          container smoke test (also run by CI)
  compose.yaml             gateway + data volume + Caddy (automatic TLS)
  caddy/Caddyfile          reverse proxy, streaming-friendly
  config/gateway.example.yaml  every key, documented
  config/.env.example          every environment variable, documented
```

## Quick start (Docker Compose)

Requirements: Docker with Compose v2, a DNS name pointing at the host,
ports 80 and 443 reachable (Caddy obtains the certificate).

```bash
git clone <this repository> && cd vaubaan-gateway
cp deploy/config/.env.example deploy/config/.env
cp deploy/config/gateway.example.yaml deploy/config/gateway.yaml
node scripts/gen-master-key.mjs            # paste into VAUBAAN_MASTER_KEY (or a secret file)
openssl rand -hex 24                       # paste into VAUBAAN_BOOTSTRAP_TOKEN
$EDITOR deploy/config/.env deploy/config/gateway.yaml
docker compose -f deploy/compose.yaml up -d --build
curl -s https://<your domain>/healthz
```

Both files are gitignored. The YAML wins over the environment key by key;
you may use either alone. Secrets go in through `${NAME}` /
`${file:/path}` references in the YAML or `*_FILE` variables.

Minimum to start: `public_url` (https), `store.path`,
`encryption.master_key`, the admin rule (`admin.group` or `admin.emails`)
and `bootstrap_token` (until an IdP is configured). Anything missing stops
the container with exit code 78 and a message naming every key:

```
Invalid instance configuration (1 problem):
  - encryption.master_key: missing required key (env: VAUBAAN_MASTER_KEY or VAUBAAN_MASTER_KEY_FILE)
```

## Running the image without Compose

```bash
docker build -f deploy/docker/Dockerfile -t vaubaan-gateway:local .
docker run -d --name vaubaan -p 127.0.0.1:3000:3000 \
  -v vaubaan-data:/data \
  -e VAUBAAN_PUBLIC_URL=https://gateway.example.com \
  -e VAUBAAN_STORE_PATH=/data/gateway.db \
  -e VAUBAAN_MASTER_KEY="$(node scripts/gen-master-key.mjs)" \
  -e VAUBAAN_ADMIN_EMAILS=ops@example.com \
  -e VAUBAAN_BOOTSTRAP_TOKEN="$(openssl rand -hex 24)" \
  vaubaan-gateway:local
```

Put your own reverse proxy in front (the gateway speaks plain HTTP on
`PORT`, default 3000). Requirements for the proxy: terminate TLS for the
host of `public_url`, forward `X-Forwarded-Host` / `X-Forwarded-Proto`, do
not buffer responses (the MCP doors stream), and list its address in
`trusted_proxies` so client IPs are read from `X-Forwarded-For`.

## Operations

- **Health**: `GET /healthz` → 200 `{"status":"ok",...}`; 503 when the
  store does not answer. The image's `HEALTHCHECK` and `compose.yaml` use
  it.
- **Logs**: JSON lines on stdout/stderr; mission tokens appear by prefix
  only, configured secrets are redacted. `VAUBAAN_LOG_LEVEL=debug` for more.
- **Data**: everything is in `/data` (`gateway.db` and its WAL files). Back
  it up with a volume snapshot or SQLite's `VACUUM INTO` (store feature
  P0.3 documents the exact command).
- **Key rotation**: generate a new key, set `encryption.key_version` to
  `n+1`, move the old key under `encryption.previous_keys.<n>`, restart.
  Old credentials still open; new ones use the new key.
- **Upgrade**: pull the new image and restart; schema migrations run at
  boot (P0.3).
- **Smoke test an image**: `deploy/docker/smoke.sh vaubaan-gateway:local`
  (needs Docker and curl) checks the fail-fast exit, the https rule,
  `/healthz`, secret redaction, native addons and the non-root user.

## What the image contains

Next.js 16 standalone output built with Turbopack (`apps/gateway/server.js`,
traced `node_modules`, `.next/static`, `public`), running as uid 10001.
Native addons (`argon2`, `better-sqlite3`) are prebuilt for glibc, which is
why the base is Debian slim rather than Alpine; `next.config.ts` traces
their binaries and runtime files explicitly (`outputFileTracingIncludes`)
and the smoke test loads both inside the image. Build-time arguments:
`NODE_VERSION` (22) and `GIT_COMMIT_SHA` (shown by `/healthz`).
