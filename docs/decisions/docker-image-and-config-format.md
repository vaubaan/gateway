---
title: Docker image, process shape and configuration format
status: accepted
date: 2026-10-13
extends:
  - pivot-v4-to-v5-on-prem-mission-tokens
  - repository-layout-and-contribution-workflow
---

# Docker image, process shape and configuration format

> Settles how the v5 gateway is packaged and started (one image, one
> process), how its configuration reaches it, and the two platform moves
> the doors depend on (Next.js 16, MCP SDK v2). Implemented by feature P0.4;
> the transport note binds P1.6. Plan §5.7.

## Context

ADR D1 of the pivot decides "one Docker image, Node server + Next.js UI in
the same process, SQLite on a mounted volume". The plan (§3.1) left three
things open because they shape every later feature:

1. **Process shape.** Next.js `output: 'standalone'` and a custom server
   are mutually exclusive ("it does not trace custom server files… these
   cannot be used together"). The MCP doors, the OAuth authorization
   server, the OIDC callback and `/healthz` are not UI; where do they run?
   Renaud's constraint: the shape must not preclude horizontal scaling
   later.
2. **Configuration.** Spec §4.3 lists what the operator provides and
   requires "startup fails with a message naming the variable"; the plan
   adds "env vars and/or a mounted file", precedence and secret references
   to decide.
3. **Image.** Base image, user, volume, health check, how native addons
   (`argon2`, soon `better-sqlite3`, `ssh2`) survive Next's file tracing.

Inputs: the research note `v5-process-shape.md` (eleven OSS projects
surveyed on 2026-10-13: Cal.com, Documenso, Formbricks, Plane, Supabase
Studio, Dub, Twenty, Infisical, Umami, Outline, Payload), the Next.js
documentation on standalone output, `instrumentation.ts` and self-hosting,
and the MCP TypeScript SDK v2 documentation. Facts quoted below come from
that note.

## Decision

### 1. Process shape: one Next.js standalone process, everything as route handlers (option a)

- The image runs `node apps/gateway/server.js`, the `server.js` that
  `next build` generates for `output: 'standalone'`. One container, one
  Node process, one listener (`PORT`, `HOSTNAME`), behind the company's TLS
  terminator.
- **Every non-UI endpoint is an App Router route handler** on the Node
  runtime: `/mcp` and `/mcp/manage` (doors), `/oauth/*` and
  `/.well-known/*` (authorization server and metadata), `/auth/*` (OIDC),
  `/r/<id>` (request pages), `/api/*`, `/healthz`. Route handlers return
  web-standard `Response` objects and stream (`ReadableStream`), which is
  what the MCP SDK's web-standard transport consumes.
- **The server code never imports `next`.** `apps/gateway/src/server/**`
  (config, crypto, logging, compose, http) is host-agnostic; route handlers
  under `src/app/**` are one-line adapters (`app/healthz/route.ts` is the
  model). A hosted version can mount the same handlers from another HTTP
  host without touching them.

Evidence: every surveyed project still on Next.js that ships Docker runs the
standalone `server.js` as its only process (Formbricks, Supabase Studio,
Umami, Payload; Cal.com builds standalone and runs `next start`); none
embeds Next in a custom Node/Express/Hono server; the projects that wanted a
"real" API server left Next altogether rather than run two servers. Formbricks
and Supabase Studio serve MCP from Next route handlers today.

### 2. Composition root: built once, reached through `getRoot()` on `globalThis`

- `buildRoot()` wires `config → logger → encryptor → store → registry →
rate limiter / cache / sessions` and returns a `GatewayRoot`.
- `getRoot()` memoises **the promise** of that build on
  `globalThis[Symbol.for('vaubaan.gateway.root')]`. Reason: Next bundles
  each route and `instrumentation.ts` into separate module graphs and
  `next dev` re-evaluates modules on HMR, so a module-level singleton can
  be instantiated several times per process; `globalThis` is the only
  reliable shared handle (Payload's `getPayload()`, Umami, Prisma's
  documented pattern). A failed build is forgotten so the next call retries.
- `instrumentation.ts#register()` (Node runtime only, skipped during
  `next build`) awaits `getRoot()` before the server accepts a request and
  **exits the process** on a `ConfigError` (exit code 78, `EX_CONFIG`) with
  the full list of problems, or with code 1 on any other boot failure. This
  is the fail-fast gate spec §4.3 requires; no separate pre-exec script is
  needed because Next waits for `register()` before serving. The sweepers
  of later features start from the same hook.
- Ports: `Store`, `Encryptor`, `PluginRegistry`, `RateLimiter`,
  `CacheClient`, `SessionStore`. The in-memory implementations
  (`MemoryRateLimiter`, `MemoryCache`, `MemorySessionStore`) are marked
  `// single-process only` and name their hosted replacement (Redis,
  store-backed). `NullStore` and `EmptyPluginRegistry` are placeholders
  until P0.3 and P0.2 plug their factories into `RootDeps`.
- No module-level mutable state anywhere in `src/server/**` or in
  `@vaubaan/*` packages (they are transpiled into the same chunks).

### 3. Configuration format

- **Two sources, one tree.** `VAUBAAN_*` environment variables and an
  optional YAML file named by `VAUBAAN_CONFIG_FILE`, both mapped to the same
  key paths (`deploy/config/gateway.example.yaml`, `.env.example`). The
  table `KEYS` in `src/server/config/sources.ts` is the single source of
  truth for the mapping.
- **Precedence: file over environment, key by key.** The mounted file is
  the operator's declarative deployment artefact; the environment is the
  12-factor fallback (hosted platforms, quick starts). When an operator
  wants an environment value to win for one key, the file says so
  explicitly with `${NAME}`.
- **Secret references.** In YAML: `${NAME}` (environment variable) and
  `${file:/path}` (file content, trimmed) anywhere in a string. In the
  environment: every secret variable `X` accepts `X_FILE`. Setting both `X`
  and `X_FILE` is an error.
- **Validation collects everything.** One `ConfigError` lists every
  missing or invalid key as `path: problem (env: VAR or VAR_FILE)`. Rules:
  `public_url` https only, no query; `trusted_proxies` IPs or CIDR;
  `encryption.master_key` 32 base64 bytes; `key_version >= 1` with
  `previous_keys` for rotation; the IdP block all-or-nothing (issuer https);
  the **admin rule** `admin.group` and/or `admin.emails` (required);
  `bootstrap_token` (>= 32 chars) required while no IdP is configured;
  provider apps `providers.<id>.{client_id,client_secret,app_id,app_slug,
private_key}` with no provider list in the loader (ids are checked
  against the plugin registry by the root: a warning now, a boot failure
  once the registry is wired in P1.2); `telemetry.enabled` default false
  with the single default collector URL in `telemetry-default.ts`;
  `retention_days` default 90; `requests.expiry` 24h and `approvals.expiry`
  10m (plan §8-Q11 assumptions); `log.level`.
- **Logging.** JSON lines, redacted as a whole line: mission tokens keep
  their prefix and lose the secret; every configured secret is replaced by
  `[redacted]`.

### 4. Crypto at rest

XChaCha20-Poly1305 (libsodium) kept from v4; the key is now derived **per
connection** with a keyed BLAKE2b hash of the connection id, the connection
id is the associated data, and the blob is `format(1) || nonce(24) ||
ciphertext`. The master key version travels in a `key_version` column, not
in the blob. `scripts/gen-master-key.mjs` prints a key.

### 5. Image

- `node:22-bookworm-slim` for every stage: glibc, so the prebuilt binaries
  of `argon2`, `better-sqlite3` and `ssh2`'s optional `cpu-features` load
  without a compiler in the runtime image (alpine/musl rejected, see
  below). Build tools exist only in the `deps` stage as a fallback.
- Four stages: `manifests` (package manifests only, for a cached dependency
  layer), `deps` (`npm ci`), `build` (`next build`, `GIT_COMMIT_SHA` build
  arg — removed on 2026-10-16: the commit is stamped by `git archive`, ADR
  [deployed-commit-stamped-by-git-archive](deployed-commit-stamped-by-git-archive.md)),
  `runner` (standalone output + `.next/static` + `public`).
- Non-root user `vaubaan` (uid 10001), `/data` owned by it (no `VOLUME`
  instruction since 2026-10-14: some platforms refuse it; the deployment
  mounts `/data`), `EXPOSE 3000`,
  `HEALTHCHECK` calling `/healthz` with Node's `fetch` (no curl in the
  image), `CMD ["node", "apps/gateway/server.js"]`.
- `next.config.ts`: `outputFileTracingIncludes` for `argon2/prebuilds` and
  `better-sqlite3/build`, because nft does not follow node-gyp-build
  lookups; `serverExternalPackages: ['ssh2']`; `generateBuildId` from the
  commit so every replica of one image shares a build id; `compress: false`
  (the TLS terminator compresses; Next's gzip would buffer streamed
  responses). The container smoke test asserts argon2 loads in the image.
- Reference deployment `deploy/compose.yaml`: gateway + `gateway-data`
  volume + Caddy with automatic TLS, `flush_interval -1` and forwarded
  headers; nothing company-specific in the file, everything in
  `deploy/config/.env` and `gateway.yaml`.
- CI builds the image and runs `deploy/docker/smoke.sh` on every push and
  PR. Publishing (GHCR, tags `v2.x.y`) belongs to the release pipeline
  (P3.2).
  _2026-10-13: the release pipeline is written
  (`.github/workflows/release.yml`: image to GHCR on a `v2.x.y` tag, with
  provenance) and has never run; see
  [known limitations](../handbook/known-limitations.md)._

### 6. Platform moves recorded for the next features

- **Next.js 16.** The repo is on 15.5.x, whose Maintenance LTS window
  closes around 2026-10-21; every surveyed project is on 16.x. P0.4 does not
  upgrade (out of perimeter); a dedicated "Next 16 upgrade" feature is
  scheduled right after the P0 wave. The root is designed to survive it:
  no `middleware.ts` (16 renames it `proxy.ts`), no module-level state,
  nothing that depends on webpack (16 defaults to Turbopack).
  _2026-10-13, P0.6: done — 16.4.0 / React 19.3.0, Turbopack build, no
  change to the process shape; the standalone output no longer copies the
  `packages/` and `plugins/` sources (Turbopack bundles the transpiled
  workspaces), and `better-sqlite3`'s runtime files are traced explicitly
  until the store is imported by the route graph. Details in the handbook
  [configuration](../handbook/configuration.md#framework)._
- **MCP SDK v2 before P1.6.** The repo is on `@modelcontextprotocol/sdk`
  1.29. v2 (`@modelcontextprotocol/server` 2.3.x) implements the 2026-07-28
  stateless Streamable HTTP through `createMcpHandler().fetch(Request,
{ authInfo })`, which drops straight into a route handler and "scales
  horizontally as-is"; it requires zod ^4.2 (the repo is on zod 3, so
  `shared`, the plugins and the UI forms move too); its resource-server
  helpers (`requireBearerAuth`, `oauthMetadataResponse`) are first-class
  while its authorization-server helpers are frozen and deprecated in
  `@modelcontextprotocol/server-legacy/auth`. P1.6 writes the execution
  door against v2 so the migration is done once; the management door's
  authorization server (P2.3) is therefore in-house or a dedicated library,
  not the frozen helpers. Streaming policy for the doors: JSON by default,
  SSE on notifications, `X-Accel-Buffering: no`, no compression in Next.

## Consequences

- One `docker compose up` serves the UI stub and `/healthz`; a container
  with an incomplete configuration stops with exit code 78 and a message
  naming every missing key (verified by `deploy/docker/smoke.sh`).
- Every later feature receives its configuration from `GatewayRoot.config`
  and its collaborators from the root; a runtime `process.env` read outside
  `src/server/config/` is a review defect (the `NEXT_PUBLIC_*` build stamps
  inlined by Next excepted). Literal URLs, secrets and project references
  are caught by the structural test `no-hardcoded-config.test.ts`, whose
  scope widens as v4 code is deleted.
- Horizontal scaling later means: Postgres `Store`, Redis `RateLimiter` /
  `CacheClient` / `SessionStore`, a shared `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`
  and `deploymentId` on every replica — no change to the doors.
- The v4 UI and `lib/` still compile through a legacy shim
  (`lib/crypto/index.ts`) over the new encryptor; they go away in Phase 1.
- Operators learn one key table; the YAML and the `.env` example are
  generated from the same `KEYS` constant and must stay in sync (checked by
  reading; a generator is a Phase 3 nicety).

## Rejected alternatives

- **(b) Custom Node/Hono/Express server embedding Next's request handler.**
  Full control of the HTTP layer and native MCP adapters, but it gives up
  standalone output (image carries the whole `node_modules`, 0.5–1.5 GB in
  reports), the official guide calls it a last resort that drops
  optimisations, `app.prepare()` internals change across majors, and no
  surveyed Next project does it. Nothing it offers is needed: the SDK's
  web-standard transport streams from a route handler.
- **(c) Two listeners or two processes in one container.** Second port
  breaks the "one port behind the TLS terminator" model; a supervisor as
  PID 1 doubles health checks, log streams and shutdown coordination; no
  surveyed project does it (Twenty's s6 image is dev-only).
- **(d) Separate API server, UI as a static SPA.** The right end state for
  Twenty, Infisical and Plane, but it means leaving Next SSR and shipping
  two deploy units to a self-hoster for a single-tenant product; Supabase's
  split is between products, not inside Studio.
- **Pre-exec shell script for config validation and migrations
  (Formbricks/Umami pattern).** Would duplicate the TypeScript loader in a
  second runtime or require a separate bundle; `register()` already runs
  before the server is ready and has the real loader. Recorded as the
  fallback if `register()` semantics change in Next 16.
- **Environment wins over file.** Common in 12-factor tooling, but it makes
  a mounted file silently partial and hides which value is live; with file
  precedence the file is the complete declaration and `${NAME}` makes every
  environment indirection visible.
- **Secrets only through `*_FILE`.** Simplest, but hosted platforms inject
  secrets as environment variables; both conventions cost a few lines.
- **alpine/musl base image.** Smaller, but `argon2` and `better-sqlite3`
  prebuilds target glibc first, Supabase excludes `sharp` on slim for the
  same class of problem, and compiling in the runtime image defeats the
  size gain.
- **Upgrading Next.js or the MCP SDK inside P0.4.** Both are needed soon,
  but each is a repo-wide change (Turbopack, zod 4) that would couple a
  foundation feature with a migration; they are scheduled as their own
  features with this ADR as their brief.
