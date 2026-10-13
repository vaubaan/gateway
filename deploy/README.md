---
title: Deploying Vaubaan Gateway
status: current
date: 2026-10-13
last_synced: 2026-10-13
tracks:
  - deploy/docker/
  - deploy/compose.yaml
  - deploy/caddy/
  - deploy/config/
  - deploy/collector/
  - .github/workflows/ci.yml
  - scripts/gen-master-key.mjs
---

# Deploying Vaubaan Gateway

One image, one process, one SQLite file on a volume, behind your TLS
terminator. Decisions and rationale: ADR
[docker-image-and-config-format](../docs/decisions/docker-image-and-config-format.md);
every configuration key: handbook
[configuration](../docs/handbook/configuration.md).

```
deploy/
  docker/Dockerfile        multi-stage build (node:22.23.3-bookworm-slim pinned by digest, non-root, HEALTHCHECK)
  docker/smoke.sh          container smoke test (also run by CI)
  compose.yaml             gateway + data volume + Caddy (automatic TLS)
  caddy/Caddyfile          reverse proxy, streaming-friendly, security headers
  config/gateway.example.yaml  every key, documented, all commented out
  config/.env.example          every environment variable, documented
  collector/schema.sql     the community telemetry collector (optional; not part of an instance)
  collector/README.md      how the project runs it, what it stores, the published thresholds
```

## Quick start (Docker Compose)

Requirements: Docker with Compose v2, a DNS name pointing at the host,
ports 80 and 443 reachable (Caddy obtains the certificate).

```bash
git clone <this repository> && cd vaubaan-gateway
cp deploy/config/.env.example deploy/config/.env
cp deploy/config/gateway.example.yaml deploy/config/gateway.yaml
npm run gen-master-key                     # paste into VAUBAAN_MASTER_KEY (or a secret file)
openssl rand -hex 24                       # paste into VAUBAAN_BOOTSTRAP_TOKEN
$EDITOR deploy/config/.env                 # GATEWAY_DOMAIN, VAUBAAN_PUBLIC_URL, VAUBAAN_ADMIN_EMAILS, the two secrets
docker compose --env-file deploy/config/.env -f deploy/compose.yaml up -d --build
curl -s https://<your domain>/healthz
```

Pass `--env-file deploy/config/.env` on every Compose command (`up`, `down`,
`logs`, `config`): Compose reads `GATEWAY_DOMAIN` from it and hands that one
variable to the proxy. Without it the command stops with a message naming
`GATEWAY_DOMAIN`. The proxy container receives nothing else: the master key,
the bootstrap token and the IdP secret go to the gateway container only.
`GATEWAY_DOMAIN` must be the host of `VAUBAAN_PUBLIC_URL`; nothing checks it
for you.

Both files are gitignored (`deploy/config/.env`, `deploy/config/gateway.yaml`;
the `*.example*` files are tracked). The YAML wins over the environment key by
key, silently, so `gateway.example.yaml` ships with **every key commented
out**: the copy changes nothing and `.env` decides until you uncomment a key.
Uncomment only what you want the file to own, replace the example value
(`gateway.example.com`, `gateway-admins`, `ops@example.com` are examples), and
remove the twin variable from `.env`. You may use either source alone. Secrets
go in through `${NAME}` / `${file:/path}` references in the YAML or `*_FILE`
variables.

First sign-in: open `https://<your domain>/login`, follow the bootstrap link
and paste the bootstrap token; on **Administration → Identity provider**
enter your OpenID Connect issuer, client id and secret (redirect URI
`https://<your domain>/auth/callback`), then "Test login". The first
sign-in of a user matching the admin rule revokes the bootstrap token. You
may instead put the IdP in the configuration (`idp.*`); the Admin page is
then read-only and no bootstrap token is needed
(handbook [authentication](../docs/handbook/authentication.md)).

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
host of `public_url`, do not buffer responses (the MCP door streams),
append the client address to `X-Forwarded-For`, and list the proxy's
address in `trusted_proxies` so that header is believed. The gateway builds
every URL from `public_url`, never from forwarded host or scheme headers.

The gateway sets no security header itself; the proxy does. Send these four
on every response, as `deploy/caddy/Caddyfile` does:

| Header                      | Value                    | Why                                                                                                  |
| --------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `Strict-Transport-Security` | `max-age=31536000`       | browsers never fall back to http for this host                                                       |
| `X-Content-Type-Options`    | `nosniff`                | a response is never re-interpreted as another type                                                   |
| `Content-Security-Policy`   | `frame-ancestors 'none'` | no page can frame the UI (one-click forms change security settings); framing only, not a full policy |
| `Referrer-Policy`           | `same-origin`            | no path leaks to another site; same-origin requests keep `Referer`, the origin check's fallback      |

They do not affect the MCP door (non-browser clients ignore them, streaming
is untouched). Do not use `no-referrer`: a same-origin form post that
carries no `Origin` header is accepted on its `Referer`.

Give the proxy only what it needs (its host name), never the gateway's
environment.

## Operations

- **Health**: `GET /healthz` → 200 `{"status":"ok",...}`; 503 `degraded`
  when the store does not answer, 503 `unavailable` when the process could
  not build its composition root. The image's `HEALTHCHECK` and
  `compose.yaml` use it.
- **Logs**: JSON lines on stdout/stderr; mission tokens appear by prefix
  only, configured secrets are redacted. `VAUBAAN_LOG_LEVEL=debug` for more.
- **Retention**: `retention_days` (default 90) purges the **audit trail**
  only, at boot and then hourly. Session events, decided requests and
  approvals are not purged and stay for the life of the store.
- **Data**: everything is in `/data` (`gateway.db` and its WAL files). Back
  it up with a volume snapshot or SQLite's `VACUUM INTO` (`store.backupTo()`
  in the [store handbook](../docs/handbook/store.md#backup); there is no
  operator CLI yet).
- **Key rotation**: generate a new key, set `encryption.key_version` to
  `n+1`, move the old key under `encryption.previous_keys.<n>`, restart.
  Old credentials still open; new ones use the new key.
- **Upgrade**: pull the new image and restart; schema migrations run at
  boot (forward-only, checksummed; see the
  [store handbook](../docs/handbook/store.md)).
- **Smoke test an image**: `npm run docker:build && npm run docker:smoke`
  (`deploy/docker/smoke.sh vaubaan-gateway:local`; needs Docker and curl)
  checks the fail-fast exit (within 60 seconds), the https rule,
  `/healthz`, secret redaction, native addons, the non-root user and that
  no env file is shipped.
- **Management door**: the instance is also the OAuth authorization server of
  `/mcp/manage` (handbook
  [management-door](../docs/handbook/management-door.md)). Defaults: access
  tokens 15 minutes, refresh tokens 30 days, client registration
  `operator-approved` with loopback-only clients (CLI agents) approved
  automatically, Client ID Metadata Documents off. The `oauth.*` keys
  (`VAUBAAN_OAUTH_*`) change them; an operator approves or disables clients on
  Administration → OAuth clients. Nothing to configure on the proxy.

## Community telemetry (optional)

Off at installation, and the only SaaS dependency of the product. When an
operator opts in, the instance reports, per call a plugin executed, six
fields: plugin, plugin version, gateway version, tool, outcome, error class.
Never arguments or their hash, resource refs, mission or user identifiers,
an instance identifier or an address. Administration → Telemetry shows the
exact payload before anything is enabled.

- **Decide from the interface**: leave `telemetry.enabled` unset; an operator
  toggles it on Administration → Telemetry (stored in the database, audited).
- **Decide from the configuration**: set `telemetry.enabled` to `true` or
  `false`; the page becomes read-only. `false` guarantees nothing is sent.
- **The collector URL**: the built-in default is a **placeholder** — the
  project's collector is not published yet — and the gateway sends nothing
  while the URL is that default, whatever the toggle says. To contribute to
  a collector that exists, set `telemetry.collector_url`
  (`VAUBAAN_TELEMETRY_COLLECTOR_URL`) to its reports endpoint, https, with its
  public key as the `apikey` query parameter when it needs one.
- **Outbound traffic**: only then, `POST` batches to that URL (at most every
  60 seconds) and one `GET` of the public statistics every six hours, which
  feeds the "validated by the community" badge on the Connections pages. A
  firewall that blocks them costs nothing but the reports and the badge.

`deploy/collector/` holds the collector itself — a SQL schema for a dedicated
Supabase project and its [README](collector/README.md) (what is stored, the
published validation thresholds, how to keep addresses out of its logs). You
do not need it to run a gateway; it is there so that anyone can audit, or
run, the other end.

## What the image contains

Next.js 16 standalone output built with Turbopack (`apps/gateway/server.js`,
traced `node_modules`, `.next/static`, `public`), running as uid 10001.
Native addons (`argon2`, `better-sqlite3`) are prebuilt for glibc, which is
why the base is Debian slim rather than Alpine; `next.config.ts` traces
their binaries and runtime files explicitly (`outputFileTracingIncludes`)
and the smoke test loads both inside the image. Build-time arguments:
`NODE_IMAGE` (the whole base image reference, tag and digest; it replaces
the former `NODE_VERSION`) and `GIT_COMMIT_SHA` (shown by `/healthz`).

Both base images are pinned by full version and by digest, so one commit
builds one image: `node:22.23.3-bookworm-slim` in the Dockerfile and
`caddy:2.11.7-alpine` in `compose.yaml`. The digests are those of the
multi-architecture index. To bump one, read the new digest from the registry
and change version and digest together:

```bash
docker buildx imagetools inspect node:<version>-bookworm-slim   # "Digest:" line
docker buildx imagetools inspect caddy:<version>-alpine
```

The digest is what is pulled: once it is present the registry ignores the
tag, which is why the Dockerfile takes one `NODE_IMAGE` argument rather than
a version on its own. The base must stay a Debian (glibc) image. Nothing
proposes these bumps automatically yet.
