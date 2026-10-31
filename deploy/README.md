---
title: Deploying Vaubaan Gateway
status: current
date: 2026-10-13
last_synced: 2026-10-14
tracks:
  - deploy/docker/
  - deploy/railway.md
  - deploy/compose.yaml
  - deploy/caddy/
  - deploy/config/
  - deploy/collector/
  - .github/workflows/ci.yml
  - .github/workflows/release.yml
  - apps/gateway/tests/unit/structural/base-images-pinned.test.ts
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
  docker/Dockerfile        multi-stage build (node:26.12.1-bookworm-slim pinned by digest, non-root, HEALTHCHECK)
  docker/smoke.sh          container smoke test (run by CI and, per architecture, by the release pipeline)
  docker/entrypoint.sh     started as root (a root-owned volume), gives /data to uid 10001 and drops root
  railway.md               deploying on Railway: one service, one volume, GitHub sign-in
  compose.yaml             gateway + data volume + Caddy (automatic TLS)
  caddy/Caddyfile          reverse proxy, streaming-friendly (the gateway sets the security headers)
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
openssl rand -hex 24                       # paste into VAUBAAN_BOOTSTRAP_TOKEN
$EDITOR deploy/config/.env                 # GATEWAY_DOMAIN, VAUBAAN_PUBLIC_URL, VAUBAAN_ADMIN_EMAILS, the token
docker compose --env-file deploy/config/.env -f deploy/compose.yaml up -d --build
curl -s https://<your domain>/healthz
```

The encryption key is generated on the data volume at the first start: the
example `.env` sets `VAUBAAN_MASTER_KEY_FILE=/data/master.key` and
`VAUBAAN_MASTER_KEY_GENERATE=1`, the gateway writes the file (32 random
bytes, base64, mode 0600) and the setup page hands it to you — download it
and keep it outside the host; a backup of the store opens with it only.
Nothing is generated once the store holds data: a key missing on an existing
store stops the container with exit code 78. To provide the key yourself
instead, `npm run gen-master-key` (needs Node.js) into `VAUBAAN_MASTER_KEY`
or a secret file named by `VAUBAAN_MASTER_KEY_FILE`, and leave the generate
variable unset. An administrator can download the key again later from
Administration → Encryption, after a fresh sign-in; every download is
recorded in the activity (handbook
[configuration](../docs/handbook/configuration.md#master-key-generated-at-the-first-start)).

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
and paste the bootstrap token; on **Settings → Administration → Sign-in**
add a sign-in provider — your company's OpenID Connect directory (redirect URI
`https://<your domain>/auth/callback/<id>`), or GitHub — then "Test". The
first sign-in of a user matching the admin rule revokes the bootstrap token.
You may instead put the providers in the configuration (`idp.*` for one
OpenID Connect provider, whose callback stays `https://<your domain>/auth/callback`,
and `sign_in.<id>.*` for any number); they are then read-only on that page and
no bootstrap token is needed. Several providers may be offered at once; a
provider where anyone can open an account (GitHub, personal Google or
Microsoft) needs allowed email domains or "invitation only", and invitations
are made on Settings → People (handbook
[authentication](../docs/handbook/authentication.md)). On Railway, follow
[railway.md](railway.md).

Then the company apps (**Settings → Administration → Company apps**): one app
per service in use, registered by your company — this gateway never uses an
app shared with another one. For GitHub, "Create the GitHub App" does it from
the page: choose the organisation (or your own account), the name and the
permissions, confirm at GitHub, and the App's id, key and secrets come back
stored encrypted — nothing to copy. The other services' apps are registered
at the service and entered on the same page, or set in the configuration
(`providers.<id>.*`, then read-only there).

Minimum to start: `public_url` (https), `store.path`,
`encryption.master_key` (or its file with `encryption.generate_master_key`),
the admin rule (`admin.group` or `admin.emails`)
and `bootstrap_token` (until an IdP is configured). Anything missing stops
the container with exit code 78 and a message naming every key:

```
Invalid instance configuration (1 problem):
  - encryption.master_key: missing required key (env: VAUBAAN_MASTER_KEY or VAUBAAN_MASTER_KEY_FILE)
```

## Released images

Every release publishes one image for `linux/amd64` and `linux/arm64` on the
GitHub Container Registry, under the repository's name
(`ghcr.io/vaubaan/gateway`). A release cut while the repository is
private — this one before it is public, or a fork kept private — is
`linux/amd64` only and carries no attestation; its release notes say so
under "Built from a private repository". The first release, `2.0.0-alpha.1`
(2026-10-18), is such a one: `linux/amd64` only, no attestation. The quick
start still builds the image from the sources.

| Tag               | Moves?                            | Use it for                                    |
| ----------------- | --------------------------------- | --------------------------------------------- |
| `2.1.3`           | never                             | production: pin it, or better, pin its digest |
| `2.1`             | to each patch of 2.1              | following the fixes of one minor              |
| `latest`          | to each final release             | trying the product                            |
| `2.2.0-rc.1`, ... | never; pre-releases have no alias | testing what comes next                       |

```bash
docker pull ghcr.io/vaubaan/gateway:2.1.3
```

To run a released image with the reference Compose file, replace the
`build:` block and the `image:` line of the `gateway` service by
`image: ghcr.io/vaubaan/gateway:<version>` and drop `--build`.
The version you run is on `/healthz` (`version`, `commit`) and in the footer
of every page.

**Verify what you pulled.** The release pipeline signs a build-provenance
attestation for the image: it states that this digest was built by the
`release` workflow of this repository, from the commit of the tag, on
GitHub's runners. Check it with the GitHub CLI before the first start:

```bash
gh attestation verify oci://ghcr.io/vaubaan/gateway:2.1.3 \
  --repo vaubaan/gateway \
  --signer-workflow vaubaan/gateway/.github/workflows/release.yml \
  --source-ref refs/tags/v2.1.3
```

A zero exit code means the image is the one that tag built; anything else,
do not run it. The command needs a recent GitHub CLI (`gh attestation`),
signed in. Attestations exist for releases published while the repository
is public, or private on GitHub Enterprise Cloud; a release published from
any other private repository has none, says so in its notes, and gives no
verify command — pin its digest and rely on the SBOM below. The release
pipeline runs this same verification on the digest right after it signs
it, and publishes no release when it fails.

The expected identity, whatever the tool: the certificate was issued by
GitHub Actions' OIDC provider to **the `release.yml` workflow of this
repository, running on a `v2.*` tag**. Without the GitHub CLI, Sigstore's
`cosign` (2.4 or later, which reads the bundle the pipeline stores next to
the image) checks the same thing:

```bash
cosign verify-attestation \
  --new-bundle-format \
  --type slsaprovenance1 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/vaubaan/gateway/\.github/workflows/release\.yml@refs/tags/v2\.' \
  ghcr.io/vaubaan/gateway:2.1.3 > /dev/null && echo verified
```

Then **run the digest you verified**, not the tag: `docker buildx
imagetools inspect ghcr.io/vaubaan/gateway:2.1.3` prints it (`Digest:`), and
`image: ghcr.io/vaubaan/gateway@sha256:<digest>` in the Compose file pins it.
A tag can be moved; a digest cannot.

**Bill of materials.** Each GitHub release carries the SBOM of the image
(SPDX JSON, one file per architecture): every Debian and npm package in the
image, with its version. Feed it to your own scanner to follow new
advisories after the release — for instance
`trivy sbom vaubaan-gateway-2.1.3-linux-amd64.spdx.json` or
`grype sbom:vaubaan-gateway-2.1.3-linux-amd64.spdx.json`. Every release was
scanned before it was published (no HIGH or CRITICAL vulnerability with a
fix, as of that day). The image also carries BuildKit's own SBOM and
provenance:

```bash
docker buildx imagetools inspect ghcr.io/vaubaan/gateway:2.1.3 --format '{{ json .SBOM }}'
docker buildx imagetools inspect ghcr.io/vaubaan/gateway:2.1.3 --format '{{ json .Provenance }}'
```

What a version number promises (configuration keys, refusal codes, the
plugin contract, catalog ids), and how a release is cut:
[`docs/workflow/coding-workflow.md`](../docs/workflow/coding-workflow.md#release).

## Running the image without Compose

```bash
docker build -f deploy/docker/Dockerfile -t vaubaan-gateway:local .
docker run -d --name vaubaan -p 127.0.0.1:3000:3000 \
  -v vaubaan-data:/data \
  -e VAUBAAN_PUBLIC_URL=https://gateway.example.com \
  -e VAUBAAN_STORE_PATH=/data/gateway.db \
  -e VAUBAAN_MASTER_KEY_FILE=/data/master.key -e VAUBAAN_MASTER_KEY_GENERATE=1 \
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

**The gateway sets the security headers itself**, on every response (handbook
[configuration](../docs/handbook/configuration.md)):
your proxy must not add or override them.

| Header                      | Value                                                                                                     | Why                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `Content-Security-Policy`   | `default-src 'self'; script-src 'self' 'nonce-<per request>' 'strict-dynamic'; …; frame-ancestors 'none'` | only the gateway's own scripts run; no page can frame the UI                                    |
| `X-Frame-Options`           | `DENY`                                                                                                    | framing refused by browsers that ignore `frame-ancestors`                                       |
| `X-Content-Type-Options`    | `nosniff`                                                                                                 | a response is never re-interpreted as another type                                              |
| `Referrer-Policy`           | `same-origin`                                                                                             | no path leaks to another site; same-origin requests keep `Referer`, the origin check's fallback |
| `Permissions-Policy`        | camera, microphone, geolocation… `=()`                                                                    | no page may use a device                                                                        |
| `Strict-Transport-Security` | `max-age=31536000`, when `public_url` is https                                                            | browsers never fall back to http for this host                                                  |

They do not affect the MCP door (non-browser clients ignore them, streaming
is untouched). The OAuth consent pages (`/oauth/authorize`) carry a stricter
policy of their own.

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
  and the session history of the same age (timeline events, the counters of
  periods that are over), at boot and then hourly. What the current period is
  computed from is kept; decided requests and approvals are not purged.
- **Data**: everything is in `/data` (`gateway.db` and its WAL files). Back
  it up with a volume snapshot or SQLite's `VACUUM INTO` (`store.backupTo()`
  in the [store handbook](../docs/handbook/store.md#backup); inside the
  container, `node apps/gateway/backup.mjs` makes that copy on the volume).
  Off the host: set the `backup.s3.*` keys (`VAUBAAN_BACKUP_S3_*`, examples in
  `config/.env.example`) and the gateway uploads a backup to an S3-compatible
  bucket on its own schedule (`VAUBAAN_BACKUP_EVERY`, `VAUBAAN_BACKUP_AT`,
  `VAUBAAN_BACKUP_KEEP`), encrypted under a key derived from the master key and
  restored into a temporary file before it leaves; Settings → Encryption and
  `GET /healthz` (`backup`) report the latest one, the activity each run (handbook
  [store](../docs/handbook/store.md#backup)). Restore one like any copy,
  with the SHA-256 of the object and the master key of the version it names.
- **Restore, moving hosts**: `node apps/gateway/restore.mjs <file or https URL>
--sha256 <hex>` inside the container puts a copy back after checking its hash,
  its integrity, its schema and that this instance's keys open its secrets
  (`--dry-run` checks only; a store that exists is replaced only with
  `--force`, gateway stopped, and kept aside). A new instance can also start
  from a copy: set `VAUBAAN_RESTORE_FROM` and `VAUBAAN_RESTORE_SHA256` and its
  first boot restores it before opening the store (handbook
  [store](../docs/handbook/store.md#restore); the whole move:
  [railway.md](railway.md#9-moving-an-instance)). Without the key file on
  the new volume (`VAUBAAN_MASTER_KEY_FILE` named, file absent), the gateway
  starts in setup mode: `/admin/bootstrap` asks for the bootstrap token and
  the key file the former instance handed out, then runs the same restore
  (handbook [configuration](../docs/handbook/configuration.md#setup-mode-the-setup-receives-the-key-for-a-restore)). With Compose, stop the
  gateway and run the command with `docker compose run --rm gateway node
apps/gateway/restore.mjs …`.
- **Key rotation**: generate a new key, set `encryption.key_version` to
  `n+1`, move the old key under `encryption.previous_keys.<n>`, restart;
  back up first (`node apps/gateway/backup.mjs` inside the container, handbook
  store), then run `node apps/gateway/reseal.mjs` inside the container (a dry run),
  again with `--apply`, and remove the previous key once the report says
  every blob is under the new version (handbook
  [configuration](../docs/handbook/configuration.md#rotating-the-master-key)).
  Until the reseal, the old key still opens every credential stored before.
- **Upgrade**: read the release notes, pull the new image and restart;
  schema migrations run at boot (forward-only, checksummed; see the
  [store handbook](../docs/handbook/store.md)). A patch or a minor release
  needs nothing else; a major one says what to change first
  ([versioning policy](../docs/workflow/coding-workflow.md#versioning-policy)).
  There is no downgrade: an older image refuses a newer database.
- **Changing the identity provider**: a user is the pair (issuer, subject),
  so another identity provider means new accounts for everybody; the earlier
  ones keep their connections and missions and are reached by nobody. When
  you upgrade an instance that already has users, let somebody sign in once
  **before** you change `idp.*`: the existing accounts are bound to the
  issuer of the first sign-in after the upgrade (handbook
  [configuration](../docs/handbook/configuration.md)).
- **Smoke test an image**: `npm run docker:build && npm run docker:smoke`
  (`deploy/docker/smoke.sh vaubaan-gateway:local`; needs Docker and curl)
  checks the fail-fast exit (within 60 seconds), the https rule,
  `/healthz`, secret redaction, native addons, the non-root user, that
  no env file and no test, fixture or demo file of the repository is
  shipped, the security headers of a page, and a start as root on a
  root-owned volume (the server still runs as uid 10001, without capability). `SMOKE_EXPECT_VERSION`, `SMOKE_EXPECT_COMMIT` and
  `SMOKE_EXPECT_ARCH` (`x64`, `arm64`) make it also check what `/healthz`
  answers and the architecture of the image, as the release pipeline does.
  The version and the commit are compared with the body of one more
  `/healthz` answer, which the script keeps and prints when a stamp is not
  the expected one.
- **Declare your reverse proxy** (`trusted_proxies`). Without it the instance
  believes no client address: the per-address limits (the request page, the
  token verification of the execution door, client registration and token
  requests of the authorization server) become one window shared by all
  callers, and the audit records no address. It says so in one warning
  at boot. `deploy/config/.env.example` sets it to Docker's address pool (the
  Caddy container of the reference Compose file); narrow it to your proxy.
- **Git remote**: `https://<public_url>/git/<owner>/<repo>.git` is the agents'
  git remote (handbook [git-remote](../docs/handbook/git-remote.md)). A push
  body is the pack itself, streamed and never stored: the reverse proxy must
  not cap or buffer request bodies under `/git/` (the reference Caddyfile
  does neither). `git.max_pack_mb` (default 200 MiB) caps a push and
  `git.request_timeout` (default 10 minutes) caps one git request; Node's own
  server stops receiving a request body after 5 minutes (`requestTimeout`),
  which bounds the upload time whatever the key says. Temporary refs
  (`refs/vaubaan/*`) appear in the repositories for the length of a push, or
  of a pending approval; the instance removes them, and a sweep every five
  minutes takes those a crash left behind.
- **Management door**: the instance is also the OAuth authorization server of
  `/mcp/manage` (handbook
  [management-door](../docs/handbook/management-door.md)). Defaults: access
  tokens 15 minutes, refresh tokens 30 days, client registration
  `operator-approved` with loopback-only clients (CLI agents) approved
  automatically, Client ID Metadata Documents off. The `oauth.*` keys
  (`VAUBAAN_OAUTH_*`) change them; an administrator approves or disables clients on
  Settings → Administration → Registered apps. Nothing to configure on the proxy.

## Community telemetry (optional)

Off at installation, and the only outbound dependency of the product. When
an operator opts in, the instance reports what `telemetry.level` selects:
`plugin-health`, one report per call a plugin executed (plugin, plugin
version, gateway version, tool, outcome, error class, duration bucket), or
`usage-stats` (the default), which adds each call's decision with its base
risk ids and one instance profile a day with bucketed counts. Every field
comes from a closed vocabulary or a bucket. Never arguments or their hash,
resource refs, mission or user identifiers, an instance identifier or an
address. Settings → Administration → Telemetry shows the exact payload
before anything is enabled; the body is documented in
[`deploy/collector/README.md`](collector/README.md).

- **Decide from the interface**: leave `telemetry.enabled` unset; an
  administrator toggles it on Settings → Administration → Telemetry (stored in
  the database, audited).
- **Decide from the configuration**: set `telemetry.enabled` to `true` or
  `false`; the page becomes read-only. `false` guarantees nothing is sent.
- **The collector URL**: the built-in default is the project's collector
  (the one default URL of the code base, `telemetry-default.ts`; the other
  end is described in [`deploy/collector/README.md`](collector/README.md));
  an enabled instance sends there unless `telemetry.collector_url`
  (`VAUBAAN_TELEMETRY_COLLECTOR_URL`) names another one: its reports
  endpoint, https, with its public key as the `apikey` query parameter when
  it needs one.
- **Outbound traffic**: once enabled, `POST` batches to that URL (at most every
  60 seconds) and one `GET` of the public statistics every six hours, which
  feeds the "validated by the community" tag on the page of an account and in
  Reference. A firewall that blocks them costs nothing but the reports and
  the tag.

`deploy/collector/` holds the collector itself — a SQL schema for a dedicated
Supabase project and its [README](collector/README.md) (what is stored, the
published validation thresholds, how to keep addresses out of its logs). You
do not need it to run a gateway; it is there so that anyone can audit, or
run, the other end.

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
builds one image: `node:26.12.1-bookworm-slim` in the Dockerfile and
`caddy:2.11.7-alpine` in `compose.yaml`. The digests are those of the
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
