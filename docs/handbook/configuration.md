---
title: Instance configuration, crypto and composition root
status: current
date: 2026-10-13
last_synced: 2026-10-13
tracks:
  - apps/gateway/src/server/config/
  - apps/gateway/src/server/crypto/
  - apps/gateway/src/server/logging/
  - apps/gateway/src/server/compose/
  - apps/gateway/src/server/http/
  - apps/gateway/tests/integration/compose/
  - apps/gateway/src/instrumentation.ts
  - apps/gateway/src/app/healthz/route.ts
  - apps/gateway/next.config.ts
  - apps/gateway/tsconfig.json
  - apps/gateway/package.json
  - apps/gateway/tests/integration/standalone-native-addons.test.ts
  - apps/gateway/tests/unit/structural/no-hardcoded-config.test.ts
  - deploy/config/gateway.example.yaml
  - deploy/config/.env.example
  - scripts/gen-master-key.mjs
  - package.json
  - deploy/docker/smoke.sh
---

# Instance configuration, crypto and composition root

How the v5 process starts from configuration alone (spec §4.3, §6; ADR
[docker-image-and-config-format](../decisions/docker-image-and-config-format.md)).
Packaging and deployment are in [`deploy/README.md`](../../deploy/README.md).

## Layout

```
apps/gateway/src/
  instrumentation.ts            Next hook: register() → bootOrExit() on the Node runtime
  app/healthz/route.ts          GET /healthz, one-line adapter over server/http
  server/                       host-agnostic: never imports `next`
    config/
      types.ts                  InstanceConfig and its blocks; secretValues()
      sources.ts                KEYS table (YAML path ↔ env var); env + YAML readers; merge
      secret-refs.ts            ${NAME}, ${file:/path}, X_FILE
      load.ts                   loadInstanceConfig(): merge, validate, ConfigError
      errors.ts                 ConfigIssue / ConfigError / IssueList
      duration.ts               "30s" | "10m" | "24h" | "7d" → seconds
      telemetry-default.ts      the single default URL of the code base
      testing.ts                validEnv(), fakeFiles() for tests
    crypto/
      aead.ts                   XChaCha20-Poly1305 core, per-connection key, blob format
      encryptor.ts              Encryptor port + createEncryptor(config.encryption)
    logging/
      logger.ts                 JSON-lines logger with level threshold and child bindings
      redact.ts                 token-prefix and secret redaction
    compose/
      ports.ts                  StoreLiveness, RateLimiter, SessionStore; re-exports gateway-core's CacheClient
      memory.ts                 MemoryRateLimiter, MemorySessionStore  // single-process only; tests
      registry.ts               buildEmptyRegistry(), RegistryCatalogIndex, checkProviderApps()
      shipped-plugins.ts        SHIPPED_PLUGINS, buildShippedRegistry(): the plugins the image ships
      store.ts                  openEmbeddedStore(): the SQLite store from store.path
      root.ts                   buildRoot(), getRoot() (globalThis), resetRoot(); wires auth/, missions/,
                                rate-limit/, provider-apps/, connections/, requests/, audit/, budget/ and execution/
      boot.ts                   bootOrExit(): exit 78 on ConfigError, 1 otherwise
      testing.ts                memoryStoreDeps, fakePlugin() — tests only
    http/
      healthz.ts                healthResponse(deps: HealthDeps), healthHandler(getDeps) — the root satisfies HealthDeps
    auth/                       OIDC relying party, web session, bootstrap, admin rule (handbook authentication)
    provider-apps/              the company's app per provider: file or Admin page (handbook connections)
    connections/                connect flows, resources, credential broker (handbook connections)
    missions/, authority/       issuance, tokens, bootstrap kit (handbook missions)
    budget/, rate-limit/        session service, sliding windows (handbook budget-and-sessions)
    execution/                  the execution MCP door (handbook execution-door)
    requests/                   inbox, claim decisions, expiry sweeper (handbook requests)
    audit/                      audit search, mission session view, retention sweeper (handbook audit)
    store/                      the embedded SQLite store (handbook store)
scripts/gen-master-key.mjs      prints 32 random bytes, base64
deploy/config/                  gateway.example.yaml, .env.example (every key documented)
```

## Boot sequence

1. `next build` evaluates `instrumentation.ts` too, so `register()` returns
   immediately when `NEXT_PHASE === 'phase-production-build'` or the
   runtime is not `nodejs`.
2. At server start `register()` imports `compose/boot` and awaits
   `bootOrExit()`, which awaits `getRoot()`.
3. `getRoot()` memoises the promise of `buildRoot()` on
   `globalThis[Symbol.for('vaubaan.gateway.root')]`. Route handlers,
   server components and tests call the same function and get the same
   root; a rejected build is forgotten so the next call retries.
4. `buildRoot()`:
   - `loadInstanceConfig()` → typed `InstanceConfig` or `ConfigError`;
   - logger with a redactor fed by `secretValues(config)`; boot line
     `configuration loaded` (source, public origin, IdP origin or "not
     configured", admin rule kind, provider ids, telemetry flag,
     key version — never a secret);
   - `createEncryptor(config.encryption)` (awaits libsodium);
   - the plugin registry (`@vaubaan/plugin-sdk`'s `PluginRegistry`) from
     `RootDeps.buildRegistry`, by default `buildShippedRegistry`: the
     ten plugins imported by `compose/shipped-plugins.ts` (P1.4). A
     plugin that fails `definePlugin` or a duplicate id fails the boot;
   - `checkProviderApps`: every `providers.<id>` must name a registered
     plugin, otherwise a `ConfigError` naming `providers.<id>` and
     `VAUBAAN_PROVIDER_<ID>_*` (exit 78). Only a root built with an
     empty registry (tests, `buildEmptyRegistry`) downgrades the
     mismatch to a warning;
   - the embedded store from `RootDeps.openStore`, by default
     `openEmbeddedStore`: `openStore()` of [store](store.md) on `config.store.path`
     with the encryptor just built and a `RegistryCatalogIndex` (the store
     checks every persisted `RiskId` against the loaded catalogs,
     env-qualified ids included). Migrations run here; the boot line
     `store opened` carries `kind`, `path` and `schema_version`. A store
     that cannot open fails the boot with a message naming `store.path` and
     `VAUBAAN_STORE_PATH` (exit 1);
   - the web `SessionStore`: the store's own repository `store.webSessions`
     (table `web_sessions`, rows keyed by the SHA-256 of the session id)
     unless `RootDeps.sessions` injects another one,
     then `createAuthModule()` → `root.auth` (`sessions`, `idp`,
     `bootstrap`, `relyingParties`, `authenticator`, `handlers`; handbook
     [authentication](authentication.md)), with `RootDeps.oidc` for the
     relying party's outbound `fetch` and the test-only insecure issuer;
   - `createMissionsModule()` → `root.missions` (`authority`, `service`,
     `handlers`; handbook [missions](missions.md));
   - one `SlidingWindowRateLimiter` — the budget's per-risk windows and,
     unless `RootDeps.rateLimiter` injects another one, the surface
     `RateLimiter` — and the `MemoryCacheClient` unless `RootDeps.cache`
     injects another one;
   - `ProviderAppsService(config.providers, store.config, registry)` →
     `root.providerApps`, then `createConnectionsModule()` →
     `root.connections` (`service`, `credentials`, `notices`,
     `handlers`; handbook [connections](connections.md)), with
     `RootDeps.providerFetch` for the outbound HTTP of the connect flows
     and of plugin discovery (tests inject `mockFetch`);
   - `createRequestsModule()` → `root.requests` (`service`, `handlers`,
     `sweeper`, `requestUrl`; handbook [requests](requests.md)). This starts
     the inbox's expiry sweeper (an `unref`-ed interval); `root.close()`
     stops it before closing the store. The per-IP limit of `/r/*` goes
     through `root.rateLimiter` and reads `trusted_proxies`;
   - `createAuditModule()` → `root.audit` (`query`, `sessions`,
     `retention`; handbook [audit](audit.md)); the root awaits
     `retention.start()`, which purges the audit entries older than
     `retention_days` once and then every hour, and `root.close()` stops
     that timer before closing the store;
   - the budget's `SessionService` → `root.budget` (claim and approval URLs
     come from `root.requests.requestUrl`; handbook
     [budget-and-sessions](budget-and-sessions.md)), then
     `createExecutionModule()` → `root.execution` (`pipeline`,
     `credentialCache`, `door`, `handlers`; handbook
     [execution-door](execution-door.md)), with `RootDeps.delegatedTokens`
     for the resolver that lets the door refuse delegated tokens by kind;
   - the boot line `composition root ready` (`store`, `schema_version`,
     `plugins`, `build`) closes the sequence.

   `buildRoot()` itself is the short sequence above; the configuration line
   is `logConfigurationSummary()` and everything from the web `SessionStore`
   to the execution module is `wireModules()`. **A failure after the store is
   opened releases what was opened**: the store handle and each timer are
   registered as they open (`opened`), and a step that throws runs them in
   reverse (retention timer, request sweeper, then `store.close()`) before
   the error is rethrown. `getRoot()` retries a failed build, so a retry never
   finds a second handle on the same SQLite file. `root.close()` runs the same
   list.

5. On `ConfigError`, `bootOrExit()` prints the error to stderr with a
   pointer to `deploy/config/` and exits with code **78** (`EX_CONFIG`);
   any other failure exits with 1. Next waits for `register()` before
   serving, so an incomplete configuration never answers a request.

`/healthz` (`http/healthz.ts`) pings the store and answers 200
`{status:"ok", version, commit, uptime_seconds, store:{kind,status}}`, 503
`degraded` when the ping fails, 503 `unavailable` (with `reason`) when the
root cannot be built. `version` and `commit` are frozen into the bundle by `next.config.ts`
(`NEXT_PUBLIC_GATEWAY_VERSION`, `NEXT_PUBLIC_COMMIT_SHA`; `dev` outside a
build) and read by `config/build-info.ts` (`buildInfoFromEnv()`), like every
other read of the process environment. The handler does not take the root:
`healthResponse(deps: HealthDeps)` needs the store's liveness (`kind`,
`ping`), a logger, the build stamps, `startedAt` and an optional `now` (the
wall clock by default, a fixed instant in tests). `GatewayRoot` satisfies
`HealthDeps`, so the route passes `getRoot`.

## Framework

`apps/gateway` runs on **Next.js 16.4.0** with React 19.3.0 (P0.6, from
15.5.18 / 19.1.1). What the upgrade means for this module:

- `next build` and `next dev` use **Turbopack**; nothing here depends on
  webpack. The standalone output keeps the same entry (`apps/gateway/server.js`,
  now an ES module) and the same layout for the Dockerfile; it no longer
  copies the `packages/` and `plugins/` sources, which Turbopack bundles
  from `transpilePackages`. That list is derived from the `@vaubaan/*`
  dependencies of `apps/gateway/package.json` (`workspaceDependencies()`),
  never written by hand, so it is not a second provider list. Nothing in
  `next.config.ts` reads an instance configuration value: `next.config`
  values are frozen at build time (the former `ALLOWED_ORIGINS` read is
  gone for that reason).
- `serverExternalPackages`: `argon2` and `better-sqlite3` are in Next's
  default external list, `ssh2` is added. `outputFileTracingIncludes` lists
  the `argon2` prebuilds (nft does not follow `node-gyp-build`) and the
  runtime files of `better-sqlite3` (`package.json`, `lib/`, the `.node`
  binary, `bindings`, `file-uri-to-path`), `./migrations/*.sql`, which
  the store reads from disk at boot, and `../../plugins/*/src/**/*.yaml`,
  the risk catalogs the plugins read at import time (handbook
  [plugin-sdk](plugin-sdk.md)). Since P0.R the `/healthz` route graph
  reaches `better-sqlite3` through the root, so nft traces the package on
  its own; the explicit globs remain as the guarantee for the prebuilt
  binary and the SQL files.
- `output: 'standalone'` with `outputFileTracingRoot` set to the repository
  root: one image, one process, and the trace follows the workspace's
  hoisted `node_modules`.
- `generateBuildId: () => commitSha`: every replica of one image serves the
  same build id.
- `compress: false`: the TLS terminator compresses; Next's gzip stays off so
  streamed MCP responses are not buffered.
- `env.NEXT_PUBLIC_BUILD_TIME` stamps the build time into the bundle, next
  to `NEXT_PUBLIC_GATEWAY_VERSION` and `NEXT_PUBLIC_COMMIT_SHA`.
- `instrumentation.ts`, the `globalThis` root and `/healthz` behave the same
  in `next dev` and in the standalone `server.js` (checked by hand and by
  the container smoke test); `register()` still runs on the Node runtime
  only and is skipped during `next build`.
- `agentRules: false`: Next 16's `next dev` writes an `AGENTS.md` next to the
  app unless told otherwise; the harness owns that file in this repository.
- No `experimental.serverActions.allowedOrigins` is set: behind the reverse
  proxy Next compares `Origin` with `X-Forwarded-Host`, and a build-time
  list would not follow the instance configuration.
- `tsconfig.json` includes `.next/dev/types/**/*.ts` as well as
  `.next/types/**/*.ts`: development now writes to `.next/dev`, and
  `next-env.d.ts` (gitignored, generated) points at whichever ran last.
- No `middleware.ts` existed, so no `proxy.ts`; the 16.0 codemods
  (`remove-unstable-prefix`, `remove-experimental-ppr`, `middleware-to-proxy`,
  `next-experimental-turbo-to-turbopack`) changed nothing;
  `next-async-request-api` produced one false positive (a page already using
  `use(params)`) that was reverted.

## Configuration keys

Both sources map to the same tree; the **file wins over the environment**
key by key, silently; `deploy/config/gateway.example.yaml` therefore ships
with every key commented out, so a copy of it overrides nothing until a key
is uncommented (`load.test.ts` holds it to that: the example parses to an
empty document, and loaded as `VAUBAAN_CONFIG_FILE` next to a valid
environment every value still comes from the environment). The table below is `KEYS` in `sources.ts`; `(secret)` keys also
accept `<VAR>_FILE`.

| YAML path                       | Environment variable                   | Rule                                                                                                               |
| ------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `public_url`                    | `VAUBAAN_PUBLIC_URL`                   | **required**, https, no query or fragment; trailing slash stripped                                                 |
| `trusted_proxies`               | `VAUBAAN_TRUSTED_PROXIES`              | list of IPs / CIDR blocks; default none                                                                            |
| `store.path`                    | `VAUBAAN_STORE_PATH`                   | **required**                                                                                                       |
| `encryption.master_key`         | `VAUBAAN_MASTER_KEY` (secret)          | **required**, 32 bytes base64                                                                                      |
| `encryption.key_version`        | `VAUBAAN_MASTER_KEY_VERSION`           | integer >= 1, default 1                                                                                            |
| `encryption.previous_keys`      | `VAUBAAN_MASTER_KEY_PREVIOUS` (secret) | `{version: key}` / `1=<b64>,2=<b64>`; not the current one                                                          |
| `idp.issuer`                    | `VAUBAAN_IDP_ISSUER`                   | https; block optional, all-or-nothing                                                                              |
| `idp.client_id`                 | `VAUBAAN_IDP_CLIENT_ID`                |                                                                                                                    |
| `idp.client_secret`             | `VAUBAAN_IDP_CLIENT_SECRET` (secret)   |                                                                                                                    |
| `idp.claims.{sub,email,groups}` | `VAUBAAN_IDP_CLAIM_{SUB,EMAIL,GROUPS}` | defaults `sub`, `email`, `groups`                                                                                  |
| `idp.allowed_email_domains`     | `VAUBAAN_IDP_ALLOWED_EMAIL_DOMAINS`    | list, lower-cased; default any                                                                                     |
| `admin.group`                   | `VAUBAAN_ADMIN_GROUP`                  | **admin rule**: group and/or emails required                                                                       |
| `admin.emails`                  | `VAUBAAN_ADMIN_EMAILS`                 | list, lower-cased, must contain `@`                                                                                |
| `providers.<id>.<field>`        | `VAUBAAN_PROVIDER_<ID>_<FIELD>`        | fields `client_id`, `client_secret` (secret), `app_id`, `app_slug`, `private_key` (secret); `-` in id ↔ `_` in env |
| `bootstrap_token`               | `VAUBAAN_BOOTSTRAP_TOKEN` (secret)     | **required while `idp` is absent**, >= 32 chars; refused once `bootstrap.revoked_at` is set in the store           |
| `telemetry.enabled`             | `VAUBAAN_TELEMETRY_ENABLED`            | default false                                                                                                      |
| `telemetry.collector_url`       | `VAUBAAN_TELEMETRY_COLLECTOR_URL`      | https; default `DEFAULT_TELEMETRY_COLLECTOR_URL`                                                                   |
| `retention_days`                | `VAUBAAN_RETENTION_DAYS`               | integer >= 1, default 90                                                                                           |
| `requests.expiry`               | `VAUBAAN_REQUEST_EXPIRY`               | duration, default `24h`                                                                                            |
| `approvals.expiry`              | `VAUBAAN_APPROVAL_EXPIRY`              | duration, default `10m`                                                                                            |
| `mcp.rate_limit_per_minute`     | `VAUBAAN_MCP_RATE_LIMIT_PER_MINUTE`    | integer >= 1, default 600: requests per minute on the execution door, per mission (spec §6)                        |
| `log.level`                     | `VAUBAAN_LOG_LEVEL`                    | `debug` `info` `warn` `error`, default `info`                                                                      |

Not in the tree: `VAUBAAN_CONFIG_FILE` (path of the YAML; unset means
environment only; set but unreadable is an error), and the listener
variables `PORT` / `HOSTNAME` read by Next's standalone `server.js`.

Booleans accept `true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`. A secret
given both directly and through its `*_FILE` variable is an error
(`set either X or X_FILE, not both`). `VAUBAAN_MASTER_KEY_PREVIOUS` entries must
be `<integer>=<key>`; a malformed entry is reported by position and its
content is never echoed (a bare key pasted there carries `=` padding). A
YAML scalar that still contains `${...}` after resolution (for example the
Compose syntax `${VAR:-default}`) is an error naming the key, so an
unsupported reference never becomes a literal secret. `parseProviderEnvName`
is the pure parser of `VAUBAAN_PROVIDER_<ID>_<FIELD>` names;
`PROVIDER_APP_FIELD_PROPERTY` maps each field to its `ProviderAppConfig`
property exhaustively.

Secret references in YAML: `${NAME}` is replaced by the environment
variable (unset → error naming the key), `${file:/run/secrets/x}` by the
trimmed file content. Both may appear inside a longer string.

Error format (one message, every problem):

```
Invalid instance configuration (2 problems):
  - encryption.master_key: missing required key (env: VAUBAAN_MASTER_KEY or VAUBAAN_MASTER_KEY_FILE)
  - public_url: must use https (got http) (env: VAUBAAN_PUBLIC_URL)
```

The provider list is **not** known to the loader: any `providers.<id>` is
accepted structurally and the root compares ids with the `PluginRegistry`
(`checkProviderApps`): a configuration error (exit 78) for an id no
shipped plugin has. Which fields a provider's app needs is the plugin's
`CredentialSpec`; a `providers.<id>` block is the whole app configuration
of that provider and makes Admin → Provider apps read-only for it
(handbook [connections](connections.md), "Provider apps"); a block that
lacks a required field does not fail the boot — the provider is shown
`incomplete` and cannot be connected.

## Crypto at rest

`createEncryptor(config.encryption)` returns the `Encryptor` port:

- `encrypt(connectionId, plaintext)` → `{ keyVersion, blob }`, with
  `blob = 0x01 || nonce(24) || XChaCha20-Poly1305(plaintext)`;
- `decrypt(connectionId, { keyVersion, blob })` → plaintext;
- `currentKeyVersion` — the version stamped on new blobs.

The per-connection key is `BLAKE2b-256(key = master key of that version,
message = "vaubaan/connection-key/v1:" + connectionId)`; the connection id
is also the associated data, so a blob copied to another connection fails
to open (`CryptoError`, generic message, no oracle). `key_version` is the
store's business (a column next to the blob): on rotation the operator sets
a new `master_key` with `key_version: n+1` and keeps the old key under
`previous_keys`; blobs written under an older version still open, new blobs
carry the new version. A blob whose version has no key fails with a message
naming `encryption.previous_keys`.

Nothing reads a secret from `process.env` outside `server/config`: the v4
shim `lib/crypto/index.ts` and the v4 `lib/` code that read their own
`*_SECRET` / `*_KEY` variables were deleted with the v4 application.

## Logging

`createLogger({ level, redact })` writes one JSON object per line
(`time`, `level`, `msg`, bindings, fields) to stdout, errors to stderr. The
whole line goes through the redactor: `vbn_(live|test)_<prefix8>_<secret32>`
becomes `vbn_live_<prefix8>_[redacted]`, every configured secret (also in
its JSON-escaped form, for PEM keys) becomes `[redacted]`. A master key is
registered in every text form the loader accepts (standard base64 with and
without padding, base64url), so the form the operator configured is the one
redacted. `child()` adds
bindings. `silentLogger` is for tests.

## Ports and their single-process implementations

| Port             | Today                                                                                                                                                                                          | Hosted replacement                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `StoreLiveness`  | the embedded SQLite store of [store](store.md) (`openEmbeddedStore`)                                                                                                                           | Postgres behind the same repositories                                    |
| `PluginRegistry` | `@vaubaan/plugin-sdk`'s registry over `SHIPPED_PLUGINS` (`compose/shipped-plugins.ts`)                                                                                                         | same (static)                                                            |
| `RateLimiter`    | `SlidingWindowRateLimiter` (`server/rate-limit/`, handbook [budget-and-sessions](budget-and-sessions.md)): the same instance holds the budget's windows; `MemoryRateLimiter` remains for tests | one Redis sorted set per key                                             |
| `CacheClient`    | `@vaubaan/gateway-core`'s `MemoryCacheClient` (TTL in seconds, bounded): verified-token proofs and the plugins' derived upstream credentials ([execution-door](execution-door.md))             | Redis for the proofs; upstream credentials stay per replica or encrypted |
| `SessionStore`   | `store.webSessions` (`server/store/repositories/web-sessions.ts`, table `web_sessions`, migration 0003, rows keyed by SHA-256 of the id); `MemorySessionStore` remains for unit tests          | Redis, or Postgres rows behind the same port                             |

`GatewayRoot.store` is the full store with its repositories
(`StoreLiveness` of `ports.ts` is only the slice `/healthz` and `close()`
need); the `globalThis` handle of `getRoot()` is per process by design
(`// single-process only`: every replica builds its own root);
`GatewayRoot.registry` is the SDK registry itself, so every provider list
derives from one object; `GatewayRoot.auth` is the authentication module
(P1.1); `GatewayRoot.providerApps` and `GatewayRoot.connections` are the
provider-app settings and the connections module (P1.4), which share the
root's `SessionStore` (keys `connect:<state>` and `notice:<id>` next to
`session:` and `login:`) and its `RateLimiter` (key `connect:<userId>`);
`GatewayRoot.budget` and `GatewayRoot.execution` are the budget's session
service and the execution door (rate-limit keys `mission:<id>:risk:<id>`,
`mcp:mission:<id>`, `mcp-verify:<prefix>`; cache keys `mission-token:<hash>`,
`upstream-credential:<connection>:…`).
Features plug their factories through `RootDeps`
(`openStore(ctx: { config, logger, encryptor, catalog })`,
`buildRegistry(config, logger)`, `rateLimiter`, `cache`, `sessions`, `oidc`
(`fetch`, `allowInsecureIssuer`), `providerFetch`, `delegatedTokens`, plus
`loadConfig`, `logWrite` and `build` that tests override);
tests use `memoryStoreDeps` (the `:memory:` store) and `fakePlugin()` from
`compose/testing.ts`, and call `resetRoot()` between cases.

## Tests

Co-located `*.test.ts` under `src/server/**` (config loader: named
failures, https rule, precedence, admin rule, secret references, provider
env parsing, key rotation; crypto: round trip, AD mismatch, tampering,
`key_version`; logging: redaction; compose: the store receives the
encryptor and a registry-backed catalog index, provider-app check as a
warning then as a `ConfigError`, a failure after the store is opened closes
the handle and stops the timers, `close()` does the same once, `getRoot()` memoisation, `bootOrExit()`
exit codes, in-memory ports; http: `/healthz` states, and `healthResponse` on
plain `HealthDeps` with a fixed clock), the integration
test `apps/gateway/tests/integration/compose/boot.test.ts` (the production
wiring against a temporary SQLite file: database created, migrations
applied, ping, `/healthz` reports `sqlite`, secrets sealed with the
configured master key and reopened without re-migrating, a risk id of a
provider the shipped registry does not hold refused (`UnknownRiskIdError`),
unreadable `store.path` named in the exit
message) plus
the structural test `apps/gateway/tests/unit/structural/no-hardcoded-config.test.ts`
(no literal URL, secret or project ref in the v5 perimeter except
`telemetry-default.ts` and `deploy/config/*.example*`),
`apps/gateway/tests/unit/structural/example-config-providers.test.ts` (the
`providers:` block of the example YAML and the `VAUBAAN_PROVIDER_*` lines of
`.env.example`, commented or not, checked against the shipped plugins: no
unknown provider, none that takes no app, no undeclared field, every
required field shown, every non-experimental provider that takes an app
present, the same providers in both files) and
`apps/gateway/tests/integration/standalone-native-addons.test.ts` (skipped
without a build: the `/healthz` route trace lists the `argon2` and
`better-sqlite3` binaries, and both load from the standalone
`node_modules`). The container smoke test is `deploy/docker/smoke.sh`; it
loads `argon2` and `better-sqlite3` inside the image.
