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
  - apps/gateway/tests/unit/structural/example-config-providers.test.ts
  - deploy/config/gateway.example.yaml
  - deploy/config/.env.example
  - scripts/gen-master-key.mjs
  - package.json
  - deploy/docker/smoke.sh
  - apps/gateway/migrations/0011_users_keyed_by_issuer_and_subject.sql
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
      sources.ts                KEYS table (YAML path ↔ env var, defaults, bounds); env + YAML readers; merge
      secret-refs.ts            ${NAME}, ${file:/path}, X_FILE
      load.ts                   loadInstanceConfig(): merge, validate, ConfigError
      errors.ts                 ConfigIssue / ConfigError / IssueList
      duration.ts               "30s" | "10m" | "24h" | "7d" → seconds
      build-info.ts             buildInfoFromEnv(): the version and commit stamps frozen by next.config.ts
      telemetry-default.ts      the single default URL of the code base
      testing.ts                validEnv(), fakeFiles() for tests
      keys-doc.test.ts          structural test: the key table of this handbook against KEYS
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
      management.ts             wireManagementDoor(): the management door's ports as closures (handbook management-door)
      root.ts                   buildRoot(), getRoot() (globalThis), resetRoot(); wires authority/, auth/, missions/,
                                rate-limit/, provider-apps/, connections/, shares/, groups/, requests/, audit/, budget/,
                                telemetry/, oauth-as/, users/, execution/ and the management door
      boot.ts                   bootOrExit(): exit 78 on ConfigError, 1 otherwise
      testing.ts                memoryStoreDeps, fakePlugin() — tests only
    http/
      healthz.ts                healthResponse(deps: HealthDeps), healthHandler(getDeps) — the root satisfies HealthDeps
      client-ip.ts              clientIpResolver(), isTrustedProxyEntry(): the one reading of trusted_proxies and X-Forwarded-For
      return-to.ts              resolveReturnTo(), isLocalPath(): return addresses limited to the public origin
    auth/                       OIDC relying party, web session, bootstrap, admin rule (handbook authentication)
    users/                      the operator's deactivation and reactivation of a user (handbook authentication)
    provider-apps/              the company's app per provider: file or Admin page (handbook connections)
    providers/                  the provider reference pages: links, planes, reference model (handbook web-app)
    connections/                connect flows, resources, credential broker (handbook connections)
    missions/                   issuance, tokens, bootstrap kit (handbook missions)
    authority/, shares/, groups/  owner or union of shares, mission grounds, local groups (handbook authority)
    budget/, rate-limit/        session service, sliding windows (handbook budget-and-sessions)
    execution/                  the execution MCP door (handbook execution-door)
    oauth-as/, management/      the authorization server and the management MCP door (handbook management-door)
    telemetry/                  community telemetry: sink, toggle, validation status (handbook telemetry)
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
     configured", admin rule kind, provider ids, telemetry flag (or "not set"),
     key version, `trusted_proxies` as the number of entries — never a
     secret). When `trusted_proxies` is empty, one `warn` line follows
     (`NO_TRUSTED_PROXY_WARNING`, whose message starts
     `trusted_proxies is empty:` and says that no client address is resolved,
     so the address-keyed limits are shared by all callers)
     with `key`, `env` (`VAUBAAN_TRUSTED_PROXIES`), `affected` (the
     request page's per-IP window, the execution door's token-verification
     window per token prefix — a flood of wrong secrets on a known prefix
     holds a not-yet-verified agent at 429 —, the authorization server's
     registration window and token window, one each for everybody — one
     caller can hold every delegated client at 429 when it renews its
     token —, `client_ip` absent from the audit) and `remedy`. Nothing is bypassed and the boot continues: the
     shared window is an accepted risk that the instance states (ADR
     [execution-door-json-faithful-arguments-and-shared-throttle](../decisions/execution-door-json-faithful-arguments-and-shared-throttle.md));
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
     unless `RootDeps.sessions` injects another one;
   - `createAuthorityModule()` → `root.authority` (`service`, `grounds`,
     `membership`; handbook [authority](authority.md)). It reads the store
     only and is built first: every module below checks, derives or watches
     authority through it;
   - `createAuthModule()` → `root.auth` (`sessions`, `idp`,
     `bootstrap`, `relyingParties`, `authenticator`, `handlers`; handbook
     [authentication](authentication.md)), with `RootDeps.oidc` for the
     relying party's outbound `fetch` and the test-only insecure issuer, and
     `membershipsChanging` bound to `authority.membership` (a sign-in that
     changes the user's groups is settled there);
   - `createMissionsModule()` → `root.missions` (`authority`, `service`, `team`,
     `handlers`; handbook [missions](missions.md)), handed
     `authority.service` and `authority.grounds`;
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
   - `createSharesModule()` → `root.shares` (`service`, `handlers`), handed
     `authority.service` (who owns a connection now) and `authority.grounds`,
     and `createGroupsModule()` → `root.groups` (`service`, `handlers`): the
     shares of a connection and the operator's local groups (handbook
     [authority](authority.md));
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
     `createTelemetryModule()` → `root.telemetry` (`sink`, `settings`,
     `stats`, `handlers`, `overview()`; handbook [telemetry](telemetry.md)),
     with `RootDeps.telemetryFetch` for the outbound HTTP to the collector
     (tests assert on it); it reads the stored toggle once, logs the
     `telemetry` line (`enabled`, `source`, `collector`) and registers
     `telemetry.stop()` (the queue's timer) on `opened`; then
     `createOAuthAsModule()` → `root.oauth` (`endpoints`, `clients`, `authorization`,
     `tokens`, `delegations`, `verifier`, `handlers`; handbook
     [management-door](management-door.md)), with
     `RootDeps.clientDocumentFetch` for the outbound fetch of Client ID
     Metadata Documents (unused unless enabled) and the build stamps for the
     footer of its pages; then
     `createUsersModule()` → `root.users` (`service`, `handlers`; handbook
     [authentication](authentication.md), "Deactivating a user"), after the
     authorization server because deactivating a user revokes their
     delegations (`oauth.delegations`), revokes the tokens they hold as a
     member of other people's missions (`missions.team`) and settles through
     `authority.membership`; then
     `createExecutionModule()` → `root.execution` (`pipeline`,
     `credentialCache`, `tokens`, `door`, `handlers`; handbook
     [execution-door](execution-door.md)), which refuses delegated tokens
     by kind through `root.oauth.verifier` (`RootDeps.delegatedTokens`
     replaces it in tests of the door alone); then
     `wireManagementDoor()` (`compose/management.ts`) → `root.management`
     (`gate`, `tools`, `door`, `handlers.mcp`): the gate identifies mission
     tokens through `root.execution.tokens`, and the door is handed ports of
     closures over the mission service, the catalogs and the rate limiter
     (handbook [management-door](management-door.md), "The hard deny");
   - the boot line `composition root ready` (`store`, `schema_version`,
     `plugins`, `build`) closes the sequence.

   `buildRoot()` itself is the short sequence above; the configuration line
   is `logConfigurationSummary()` and everything from the web `SessionStore`
   to the management door is `wireModules()`. **A failure after the store is
   opened releases what was opened**: the store handle and each timer are
   registered as they open (`opened`), and a step that throws runs them in
   reverse (telemetry queue timer, retention timer, request sweeper, then
   `store.close()`) before the error is rethrown; every closer runs even
   when one of them fails. `getRoot()` retries a failed build, so a retry never
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
other read of the process environment. The version is the `version` of the
root `package.json` and has no other source; the footer of the interface and
the telemetry field `gateway_version` show the same stamp
([coding workflow, "One version"](../workflow/coding-workflow.md#one-version)). The handler does not take the root:
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
environment every value still comes from the environment).

The table below is the whole configuration surface: one row per entry of
`KEYS` in `sources.ts`, the table the loader reads its defaults and bounds
from, plus the `providers.<id>.<field>` family. **It is machine-checked**:
`config/keys-doc.test.ts` parses it out of this file and fails when a key of
the loader has no row, when a row is not a key of the loader, or when a type,
a default, a bound or a variable differs from the loader's. To change a
default or a bound, change `KEYS` and this table together.

| Key                                               | Type       | Default                                    | Bounds                                                                                                                                                                       | Environment variable                                                                                                 | Consumed by                                                                                                                                                                                        |
| ------------------------------------------------- | ---------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public_url`                                      | URL        | required                                   | https; no query or fragment; a trailing `/` is stripped, a sub-path is kept                                                                                                  | `VAUBAAN_PUBLIC_URL`                                                                                                 | every module that builds an address: provider callbacks, request URLs, the bootstrap kit, the OAuth issuer and its endpoints, origin checks                                                        |
| `trusted_proxies`                                 | list       | —                                          | —; each entry an IP address or a CIDR block (prefix 0–32 for IPv4, 0–128 for IPv6)                                                                                           | `VAUBAAN_TRUSTED_PROXIES`                                                                                            | `http/client-ip.ts`, the one reading of `X-Forwarded-For`: execution door, request page, OAuth endpoints, management gate                                                                          |
| `store.path`                                      | string     | required                                   | —; not empty                                                                                                                                                                 | `VAUBAAN_STORE_PATH`                                                                                                 | `compose/store.ts` (`openEmbeddedStore`)                                                                                                                                                           |
| `encryption.master_key`                           | secret     | required                                   | —; exactly 32 bytes, in base64 or base64url                                                                                                                                  | `VAUBAAN_MASTER_KEY`, `VAUBAAN_MASTER_KEY_FILE`                                                                      | `crypto/encryptor.ts`                                                                                                                                                                              |
| `encryption.key_version`                          | integer    | `1`                                        | >= 1                                                                                                                                                                         | `VAUBAAN_MASTER_KEY_VERSION`                                                                                         | `crypto/encryptor.ts`: the version stamped on new blobs                                                                                                                                            |
| `encryption.previous_keys`                        | secret map | —                                          | —; `{version: key}` (`1=<b64>,2=<b64>` in the variable); a version is an integer >= 1 other than `key_version`; each key 32 bytes, base64                                    | `VAUBAAN_MASTER_KEY_PREVIOUS`, `VAUBAAN_MASTER_KEY_PREVIOUS_FILE`                                                    | `crypto/encryptor.ts`: opens the blobs written before a rotation                                                                                                                                   |
| `idp.issuer`                                      | URL        | required once `idp` is set                 | https                                                                                                                                                                        | `VAUBAAN_IDP_ISSUER`                                                                                                 | `auth/` (`IdpSettingsService`); the `idp` block is optional and all-or-nothing. Not what names a user's issuer: that is the `iss` of the validated ID token (see "Changing the identity provider") |
| `idp.client_id`                                   | string     | required once `idp` is set                 | —                                                                                                                                                                            | `VAUBAAN_IDP_CLIENT_ID`                                                                                              | `auth/` (`IdpSettingsService`)                                                                                                                                                                     |
| `idp.client_secret`                               | secret     | required once `idp` is set                 | —                                                                                                                                                                            | `VAUBAAN_IDP_CLIENT_SECRET`, `VAUBAAN_IDP_CLIENT_SECRET_FILE`                                                        | `auth/` (`IdpSettingsService`)                                                                                                                                                                     |
| `idp.claims.sub`                                  | string     | `sub`                                      | —                                                                                                                                                                            | `VAUBAAN_IDP_CLAIM_SUB`                                                                                              | `auth/claims.ts`: the claim carrying the stable subject, unique within its issuer: a user is the pair (issuer, subject)                                                                            |
| `idp.claims.email`                                | string     | `email`                                    | —                                                                                                                                                                            | `VAUBAAN_IDP_CLAIM_EMAIL`                                                                                            | `auth/claims.ts`: the claim carrying the email address                                                                                                                                             |
| `idp.claims.groups`                               | string     | `groups`                                   | —                                                                                                                                                                            | `VAUBAAN_IDP_CLAIM_GROUPS`                                                                                           | `auth/claims.ts`: the claim carrying the groups                                                                                                                                                    |
| `idp.allowed_email_domains`                       | list       | —                                          | —; lower-cased; an empty list admits any domain                                                                                                                              | `VAUBAAN_IDP_ALLOWED_EMAIL_DOMAINS`                                                                                  | `auth/handlers.ts`: the sign-in callback                                                                                                                                                           |
| `admin.group`                                     | string     | —                                          | —; **admin rule**: at least one of `admin.group` and `admin.emails`                                                                                                          | `VAUBAAN_ADMIN_GROUP`                                                                                                | `auth/` (the admin rule), `groups/`                                                                                                                                                                |
| `admin.emails`                                    | list       | —                                          | —; lower-cased; each entry contains `@`                                                                                                                                      | `VAUBAAN_ADMIN_EMAILS`                                                                                               | `auth/` (the admin rule)                                                                                                                                                                           |
| `providers.<id>.<field>`                          | string     | —                                          | `client_id`, `client_secret`, `app_id`, `app_slug`, `private_key`; the field is one of these and its value is not empty; the id is a registered plugin (checked by the root) | `VAUBAAN_PROVIDER_<ID>_<FIELD>` (`_FILE` for `client_secret` and `private_key`; `-` in the id ↔ `_` in the variable) | `provider-apps/` (`ProviderAppsService`)                                                                                                                                                           |
| `bootstrap_token`                                 | secret     | required while `idp` is absent             | at least 32 characters; refused once `bootstrap.revoked_at` is set in the store                                                                                              | `VAUBAAN_BOOTSTRAP_TOKEN`, `VAUBAAN_BOOTSTRAP_TOKEN_FILE`                                                            | `auth/` (`BootstrapService`)                                                                                                                                                                       |
| `telemetry.enabled`                               | boolean    | `false`                                    | —                                                                                                                                                                            | `VAUBAAN_TELEMETRY_ENABLED`                                                                                          | `telemetry/settings.ts`. Not set: off, and Admin → Telemetry decides; set (true or false): that value, and the Admin toggle is read-only (`TelemetryConfig.enabledSetByConfig`)                    |
| `telemetry.collector_url`                         | URL        | `https://telemetry.vaubaan.com/v1/reports` | https; a query is allowed (the collector's public key as `?apikey=`)                                                                                                         | `VAUBAAN_TELEMETRY_COLLECTOR_URL`                                                                                    | `telemetry/`. The default is `DEFAULT_TELEMETRY_COLLECTOR_URL`, a placeholder the client refuses to send to                                                                                        |
| `retention_days`                                  | integer    | `90`                                       | >= 1                                                                                                                                                                         | `VAUBAAN_RETENTION_DAYS`                                                                                             | `audit/retention.ts` (the purge of audit entries); shown on the Audit page                                                                                                                         |
| `requests.expiry`                                 | duration   | `24h`                                      | —                                                                                                                                                                            | `VAUBAAN_REQUEST_EXPIRY`                                                                                             | `budget/session-service.ts`: how long a request to the creator stays answerable, a claim and an approval request alike                                                                             |
| `approvals.expiry`                                | duration   | `10m`                                      | —                                                                                                                                                                            | `VAUBAAN_APPROVAL_EXPIRY`                                                                                            | `requests/request-service.ts` (applied when the creator grants) and `budget/session-service.ts` (told to the executor as `approval_valid_seconds`): how long a granted approval stays usable       |
| `mcp.rate_limit_per_minute`                       | integer    | `600`                                      | >= 1                                                                                                                                                                         | `VAUBAAN_MCP_RATE_LIMIT_PER_MINUTE`                                                                                  | `execution/door.ts`: requests per minute on the execution door, per mission (spec §6; key `mcp:mission:<id>`)                                                                                      |
| `oauth.access_token_ttl`                          | duration   | `15m`                                      | at most 3600 s; that is `1h`                                                                                                                                                 | `VAUBAAN_OAUTH_ACCESS_TOKEN_TTL`                                                                                     | `oauth-as/token-service.ts`: lifetime of a delegated access token ([management-door](management-door.md))                                                                                          |
| `oauth.refresh_token_ttl`                         | duration   | `30d`                                      | —; longer than `oauth.access_token_ttl`                                                                                                                                      | `VAUBAAN_OAUTH_REFRESH_TOKEN_TTL`                                                                                    | `oauth-as/token-service.ts`: lifetime of a refresh token; restarts at every renewal                                                                                                                |
| `oauth.refresh_reuse_window_seconds`              | integer    | `30`                                       | 0 to 60; `0` disables the window                                                                                                                                             | `VAUBAAN_OAUTH_REFRESH_REUSE_WINDOW_SECONDS`                                                                         | `oauth-as/token-service.ts`: how long the refresh token rotated last may be presented once more (two sessions renewing together)                                                                   |
| `oauth.client_registration.policy`                | enum       | `operator-approved`                        | `open`, `operator-approved`, `closed`                                                                                                                                        | `VAUBAAN_OAUTH_CLIENT_REGISTRATION_POLICY`                                                                           | `oauth-as/clients.ts`, `oauth-as/handlers.ts`: who may become an OAuth client                                                                                                                      |
| `oauth.client_registration.auto_approve_loopback` | boolean    | `true`                                     | —                                                                                                                                                                            | `VAUBAAN_OAUTH_CLIENT_REGISTRATION_AUTO_APPROVE_LOOPBACK`                                                            | `oauth-as/clients.ts`: under `operator-approved`, loopback-only clients need no approval                                                                                                           |
| `oauth.client_registration.metadata_documents`    | boolean    | `false`                                    | —                                                                                                                                                                            | `VAUBAAN_OAUTH_CLIENT_REGISTRATION_METADATA_DOCUMENTS`                                                               | `oauth-as/`: accept Client ID Metadata Documents (outbound https fetches) and advertise it in the server metadata                                                                                  |
| `log.level`                                       | enum       | `info`                                     | `debug`, `info`, `warn`, `error`                                                                                                                                             | `VAUBAAN_LOG_LEVEL`                                                                                                  | `compose/root.ts`: the threshold of the logger                                                                                                                                                     |

How to read it:

- **Default**: the value used when neither source sets the key; `required`
  means the instance does not start without it; `—` means the key is optional
  and absent by default (an empty list, no group, no previous key).
- **Bounds**: the text before the first `;` is what the key table carries as
  data and is checked by the test — `>= 1` and `0 to 60` are inclusive, and
  an integer has **no upper bound** unless one is written. What follows a `;`
  is checked by the loader but not by the test: a rule across two keys, or
  the format of an entry.
- **Types**: a `duration` is a whole number greater than 0 followed by one
  unit, `s`, `m`, `h` or `d` (`30s`, `10m`, `24h`, `7d`), with no upper bound
  unless one is written; a `list` is a YAML sequence, or comma-separated in
  the variable; a `secret` also accepts the `_FILE` variable shown, which
  names a file holding the value; a `secret map` is a YAML mapping.
- **Consumed by**: the module that reads the value from `InstanceConfig`,
  under `apps/gateway/src/server/`.

Not in the tree: `VAUBAAN_CONFIG_FILE` (path of the YAML; unset means
environment only; set but unreadable, not valid YAML or not a mapping is an
error), and the listener variables `PORT` / `HOSTNAME` read by Next's
standalone `server.js`.

In an environment variable a boolean accepts `true`/`false`, `1`/`0`,
`yes`/`no`, `on`/`off` (any case) and an integer is parsed from the text; in
the YAML file the value must be a YAML boolean (`true` / `false`) or number —
a quoted `"true"` or a bare `yes` is refused (`expected true or false`).

A secret
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

### Changing the identity provider

A user of the instance is the pair (issuer, subject), where the issuer is
the `iss` claim of the ID token the relying party validated — not
`idp.issuer`, which is what the operator typed and may differ from `iss` by
a trailing slash (handbook [authentication](authentication.md), "A user is
(issuer, subject)"; ADR
[users-keyed-by-issuer-and-subject](../decisions/users-keyed-by-issuer-and-subject.md)).
Two consequences for whoever edits `idp.*`:

- Pointing `idp.issuer` at another identity provider does not carry the
  accounts over. Everyone who signs in through the new provider gets a new
  account, even with the same subject and the same email; the earlier
  accounts keep what they held and nobody reaches them.
- **Upgrade note.** The accounts created before the store recorded an issuer
  are bound, all at once, to the issuer of the first sign-in the instance
  validates after the upgrade (migration `0011`). Upgrade, let somebody sign
  in once, and only then change the identity provider: changing it in the
  same restart as the upgrade binds the existing accounts to the new
  provider. The bind is logged once at `warn` (`existing accounts bound to
the identity provider of this sign-in`, with the issuer and the count).

`idp.claims.groups` names where the groups are read. When the ID token does
not carry that claim and the userinfo request fails, the sign-in is refused
(`groups-unavailable`) rather than read as "no group": an IdP whose groups
come from userinfo alone refuses sign-ins for the length of a userinfo
outage. Open sessions are not affected.

The provider list is **not** known to the loader: any `providers.<id>` is
accepted structurally and the root compares ids with the `PluginRegistry`
(`checkProviderApps`): a configuration error (exit 78) for an id no
shipped plugin has. Which fields a provider's app needs is the plugin's
`CredentialSpec`; a `providers.<id>` block is the whole app configuration
of that provider and makes Admin → Provider apps read-only for it
(handbook [connections](connections.md), "Provider apps"); a block that
lacks a required field does not fail the boot — the provider is shown
`incomplete` and cannot be connected.

## Fixed in code (not configurable)

The key table above is the whole configuration surface. The lifetimes,
windows, limits and timeouts below look like settings but are constants of
the code: none is read from `InstanceConfig`, none has a key or a variable,
and changing one is a release, not a setting. **These tables are written by
hand and no test checks them** (the key table is the machine-checked one):
they were compared with the code on 2026-10-13. Each row gives the constant's
name and the module that declares it, never a line number; a path without a
package prefix is under `apps/gateway/src/server/`. A rate limit is a count
per sliding window on the root's `RateLimiter`, under the key shown.

Authorization server of the management door (`oauth.*` has six keys;
everything else is fixed):

| What                                                                                          | Value            | Constant                                                          | Module                                 |
| --------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------- | -------------------------------------- |
| Longest `oauth.access_token_ttl`                                                              | 3600 s (1 h)     | `maxSeconds` of the key in `KEYS`                                 | `config/sources.ts`                    |
| Longest `oauth.refresh_reuse_window_seconds`                                                  | 60 s             | `max` of the key in `KEYS`                                        | `config/sources.ts`                    |
| Lifetime of an authorization code                                                             | 60 s             | `AUTHORIZATION_CODE_TTL_MS`                                       | `oauth-as/authorization.ts`            |
| Time to answer the consent screen                                                             | 10 min           | `CONSENT_TTL_MS`                                                  | `oauth-as/authorization.ts`            |
| Longest `state` of an authorization request                                                   | 1024 characters  | `MAX_STATE_LENGTH`                                                | `oauth-as/authorization.ts`            |
| Token and revocation requests per client address                                              | 60 per minute    | `TOKEN_REQUESTS_PER_WINDOW`, `TOKEN_WINDOW_MS`                    | `oauth-as/handlers.ts`                 |
| Token requests per confidential client, once its secret matched (`oauth:token:client:<id>`)   | 120 per minute   | `TOKEN_REQUESTS_PER_CLIENT`, `TOKEN_WINDOW_MS`                    | `oauth-as/handlers.ts`                 |
| Renewals per delegation, once the refresh token is recognised (`oauth:token:delegation:<id>`) | 120 per minute   | `RENEWALS_PER_DELEGATION`, `RENEWAL_WINDOW_MS`                    | `oauth-as/token-service.ts`            |
| Client registrations per client address                                                       | 20 per 10 min    | `REGISTRATIONS_PER_WINDOW`, `REGISTRATION_WINDOW_MS`              | `oauth-as/handlers.ts`                 |
| Client registrations, whole instance                                                          | 300 per hour     | `REGISTRATIONS_PER_INSTANCE`, `REGISTRATION_INSTANCE_WINDOW_MS`   | `oauth-as/handlers.ts`                 |
| Largest token, revocation or registration body                                                | 16 384 bytes     | `MAX_REQUEST_BYTES`                                               | `oauth-as/handlers.ts`                 |
| Redirect URIs per registered client                                                           | 10               | `MAX_REDIRECT_URIS`                                               | `oauth-as/clients.ts`                  |
| Longest redirect URI                                                                          | 1024 characters  | `MAX_REDIRECT_URI_LENGTH`                                         | `oauth-as/redirect-uri.ts`             |
| An undecided client nobody consented to is forgotten after                                    | 30 days          | `UNUSED_CLIENT_RETENTION_MS`                                      | `oauth-as/clients.ts`                  |
| Metadata-document fetches per requesting user                                                 | 10 per minute    | `DOCUMENT_FETCHES_PER_WINDOW`, `DOCUMENT_FETCH_WINDOW_MS`         | `oauth-as/clients.ts`                  |
| Metadata document: longest client-id URL                                                      | 512 characters   | `MAX_CLIENT_ID_URL_LENGTH`                                        | `oauth-as/client-metadata-document.ts` |
| Metadata document: largest body                                                               | 16 384 bytes     | `MAX_DOCUMENT_BYTES`                                              | `oauth-as/client-metadata-document.ts` |
| Metadata document: fetch timeout                                                              | 5 s              | `DOCUMENT_FETCH_TIMEOUT_MS`                                       | `oauth-as/client-metadata-document.ts` |
| Metadata document: redirect URIs                                                              | 10               | `MAX_DOCUMENT_REDIRECT_URIS`                                      | `oauth-as/client-metadata-document.ts` |
| Metadata document: longest client name                                                        | 80 characters    | `MAX_CLIENT_NAME_LENGTH`                                          | `oauth-as/client-metadata-document.ts` |
| Metadata document: reuse of a fetched document (min, default, max)                            | 5 min, 1 h, 24 h | `MIN_CACHE_SECONDS`, `DEFAULT_CACHE_SECONDS`, `MAX_CACHE_SECONDS` | `oauth-as/client-metadata-document.ts` |
| Sweep of expired codes and tokens: at most every                                              | 1 h              | `PURGE_INTERVAL_MS`                                               | `oauth-as/token-service.ts`            |
| An expired code or token is kept (a replay is still recognised)                               | 24 h             | `PURGE_GRACE_MS`                                                  | `oauth-as/token-service.ts`            |

The refresh reuse window itself is a key (`oauth.refresh_reuse_window_seconds`,
30 s by default); only its 60 s ceiling is fixed.

Management door:

| What                                                        | Value          | Constant                                                           | Module                |
| ----------------------------------------------------------- | -------------- | ------------------------------------------------------------------ | --------------------- |
| Requests per delegation (`mgmt:delegation:<id>`)            | 120 per minute | `MANAGEMENT_REQUESTS_PER_WINDOW`, `MANAGEMENT_REQUEST_WINDOW_MS`   | `management/door.ts`  |
| Mutations per delegation (`mgmt:delegation:<id>:mutations`) | 60 per hour    | `MANAGEMENT_MUTATIONS_PER_WINDOW`, `MANAGEMENT_MUTATION_WINDOW_MS` | `management/tools.ts` |

Execution door, requests and approvals (`mcp.*`, `requests.*` and
`approvals.*` have one key each):

| What                                                                     | Value          | Constant                                                 | Module                                  |
| ------------------------------------------------------------------------ | -------------- | -------------------------------------------------------- | --------------------------------------- |
| Window of `mcp.rate_limit_per_minute`                                    | 1 min          | `SURFACE_RATE_WINDOW_MS`                                 | `execution/door.ts`                     |
| A verified-token proof is kept after its last use                        | 15 min         | `VERIFIED_TOKEN_TTL_SECONDS`                             | `execution/token-verifier.ts`           |
| Token verifications per token prefix and client address (`mcp-verify:…`) | 30 per minute  | `VERIFY_ATTEMPTS_PER_WINDOW`, `VERIFY_WINDOW_MS`         | `execution/token-verifier.ts`           |
| Longest time a derived upstream credential is cached                     | 55 min         | `MAX_UPSTREAM_CREDENTIAL_TTL_SECONDS`                    | `execution/credential-cache.ts`         |
| Longest agent label                                                      | 64 characters  | `AGENT_LABEL_MAX_LENGTH`                                 | `missions/bootstrap-kit.ts`             |
| Longest `User-Agent` kept in the audit                                   | 256 characters | `USER_AGENT_MAX_LENGTH`                                  | `execution/request-meta.ts`             |
| Longest upstream error summary kept in the audit                         | 200 characters | `UPSTREAM_ERROR_SUMMARY_MAX_LENGTH`                      | `packages/gateway-core/src/pipeline.ts` |
| Longest structural rejection reason kept in the audit                    | 500 characters | `AUDIT_REASON_MAX_LENGTH`                                | `packages/gateway-core/src/pipeline.ts` |
| Stack frames logged when a decision stage fails                          | 12             | `STACK_FRAMES_LOGGED`                                    | `execution/index.ts`                    |
| A token's "last used" is written at most once per                        | 60 s           | `TOKEN_LAST_USED_GRANULARITY_SECONDS`                    | `execution/door.ts`                     |
| Request page `/r/<id>` per client address (`request-page:ip:…`)          | 30 per minute  | `REQUEST_PAGE_RATE_LIMIT`, `REQUEST_PAGE_RATE_WINDOW_MS` | `requests/handlers.ts`                  |
| Expiry sweep of claims and approval requests                             | every minute   | `REQUEST_SWEEP_INTERVAL_MS`                              | `requests/sweeper.ts`                   |
| Session events shown on the request page                                 | 20             | `SESSION_EVENTS_SHOWN`                                   | `requests/request-service.ts`           |

The execution door has no request-body size limit and no upstream call
timeout of its own: no such constant exists.

Telemetry (`telemetry.enabled` and `telemetry.collector_url` are the two
keys):

| What                                                | Value                                  | Constant                         | Module                             |
| --------------------------------------------------- | -------------------------------------- | -------------------------------- | ---------------------------------- |
| Reports per batch                                   | 50                                     | `QUEUE_DEFAULTS.batchSize`       | `packages/telemetry/src/queue.ts`  |
| Flush interval                                      | 1 min                                  | `QUEUE_DEFAULTS.flushIntervalMs` | `packages/telemetry/src/queue.ts`  |
| Reports held in memory                              | 1000                                   | `QUEUE_DEFAULTS.maxQueued`       | `packages/telemetry/src/queue.ts`  |
| Back-off after a failed send                        | from 30 s to 1 h, factor 2, jitter 0.2 | `QUEUE_DEFAULTS.backoff`         | `packages/telemetry/src/queue.ts`  |
| Send timeout                                        | 10 s                                   | `DEFAULT_SEND_TIMEOUT_MS`        | `packages/telemetry/src/client.ts` |
| Re-read of the stored toggle                        | every 30 s                             | `REFRESH_MS`                     | `telemetry/settings.ts`            |
| Plugin statistics: cached                           | 6 h                                    | `STATS_TTL_SECONDS`              | `telemetry/stats.ts`               |
| Plugin statistics: a failed read is not retried for | 10 min                                 | `FAILURE_TTL_SECONDS`            | `telemetry/stats.ts`               |
| Plugin statistics: fetch timeout                    | 5 s                                    | `STATS_TIMEOUT_MS`               | `telemetry/stats.ts`               |
| Plugin statistics: largest body                     | 512 KiB                                | `STATS_MAX_BYTES`                | `telemetry/stats.ts`               |

`TelemetryModuleDeps.queue` and `TelemetryClientOptions.sendTimeoutMs` exist
for tests; the composition root passes neither.

Sign-in, connections, missions, audit, store and caches:

| What                                                    | Value          | Constant                                       | Module                                            |
| ------------------------------------------------------- | -------------- | ---------------------------------------------- | ------------------------------------------------- |
| Web session, absolute lifetime                          | 8 h            | `SESSION_TTL_MS`                               | `auth/session-service.ts`                         |
| Time to come back from the IdP                          | 10 min         | `LOGIN_TTL_MS`                                 | `auth/session-service.ts`                         |
| Clock skew tolerated on an ID token                     | 60 s           | `DEFAULT_CLOCK_TOLERANCE_SECONDS`              | `auth/relying-party.ts`                           |
| Connect attempts per user (`connect:<user>`)            | 10 per minute  | `CONNECT_RATE_LIMIT`, `CONNECT_RATE_WINDOW_MS` | `connections/service.ts`                          |
| Resource discovery timeout                              | 30 s           | `DISCOVERY_TIMEOUT_MS`                         | `connections/service.ts`                          |
| Provider token endpoint timeout                         | 15 s           | `TOKEN_REQUEST_TIMEOUT_MS`                     | `connections/oauth2.ts`                           |
| An access token expiring within this delay is refreshed | 60 s           | `REFRESH_SKEW_MS`                              | `connections/credentials.ts`                      |
| Pending connect flow, and its notice                    | 10 min, 5 min  | `CONNECT_TTL_MS`, `NOTICE_TTL_MS`              | `connections/pending.ts`                          |
| Installation pages read before a connection is refused  | 20             | `MAX_INSTALLATION_PAGES`                       | `connections/install-verification.ts`             |
| Longest connection name                                 | 80 characters  | `MAX_NAME_CHARS`                               | `connections/input.ts`                            |
| Longest mission name                                    | 120 characters | `MISSION_NAME_MAX_LENGTH`                      | `missions/preview.ts`                             |
| Longest name of a named mission token                   | 60 characters  | `TOKEN_NAME_MAX_LENGTH`                        | `missions/token-name.ts`                          |
| Shortest and longest recurring period of a mission      | 60 s, 366 days | `MIN_PERIOD_SECONDS`, `MAX_PERIOD_SECONDS`     | `missions/preview.ts`                             |
| Longest local group name                                | 80 characters  | `GROUP_NAME_MAX_LENGTH`                        | `groups/errors.ts`                                |
| Retention sweep of the audit (after the one at boot)    | every hour     | `RETENTION_SWEEP_INTERVAL_MS`                  | `audit/retention.ts`                              |
| Audit page size; session timeline page size             | 50; 100        | `AUDIT_PAGE_SIZE`, `SESSION_EVENTS_PAGE_SIZE`  | `audit/query-service.ts`, `audit/session-view.ts` |
| SQLite busy timeout                                     | 5 s            | `DEFAULT_BUSY_TIMEOUT_MS`                      | `store/db.ts`                                     |
| Entries of the in-memory cache                          | 10 000         | `DEFAULT_MAX_ENTRIES`                          | `packages/gateway-core/src/cache.ts`              |
| Keys after which the sliding-window limiter prunes      | 10 000         | `DEFAULT_PRUNE_THRESHOLD`                      | `rate-limit/sliding-window.ts`                    |

Limits that belong to one plugin are in that plugin's page under
[providers](providers/README.md) (the GitHub installation-token cache in
[github](providers/github.md), for instance).

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
`mcp:mission:<id>`, `mcp-verify:<prefix>:<client address>`; cache keys
`mission-token:<hash>`, `upstream-credential:<connection>:…`);
`GatewayRoot.authority`, `GatewayRoot.shares` and `GatewayRoot.groups` are
the authority, share and local-group modules (P2.2); `GatewayRoot.users` is
Administration → Users (the operator's deactivation and reactivation of a
user);
`GatewayRoot.telemetry` is community telemetry (P2.5; cache key
`telemetry:plugin-stats`); `GatewayRoot.oauth` is the authorization server
(P2.3; `SessionStore` key `oauth-consent:<id>`, rate-limit keys
`oauth:register:ip:<address>`, `oauth:register`, `oauth:token:ip:<address>`,
`oauth:token:client:<id>`, `oauth:token:delegation:<id>`, `oauth:client-document:<requester>`) and
`GatewayRoot.management` is the management door (P2.4; rate-limit keys
`mgmt:delegation:<id>` and `mgmt:delegation:<id>:mutations`). The request
page keys its per-address limit on `request-page:ip:<address>`.
Features plug their factories through `RootDeps`
(`openStore(ctx: { config, logger, encryptor, catalog })`,
`buildRegistry(config, logger)`, `rateLimiter`, `cache`, `sessions`, `oidc`
(`fetch`, `allowInsecureIssuer`), `providerFetch`, `delegatedTokens`,
`telemetryFetch`, `clientDocumentFetch`, plus
`loadConfig`, `logWrite` and `build` that tests override);
tests use `memoryStoreDeps` (the `:memory:` store) and `fakePlugin()` from
`compose/testing.ts`, and call `resetRoot()` between cases.

## Tests

Co-located `*.test.ts` under `src/server/**` (config loader: named
failures, https rule, precedence, admin rule, secret references, provider
env parsing, key rotation, `KEYS` against both example files, the
authorization-server keys (defaults, both sources, the `1h` cap, a refresh
token that outlives the access token, the 60 s reuse-window cap), the
boolean and integer spellings each source accepts;
`config/keys-doc.test.ts`, the structural test that parses the key table of
this handbook and checks it against `KEYS` in both directions (a row per
key and no other row; type, default or requirement, bounds and variables
equal to the loader's); crypto: round trip, AD mismatch, tampering,
`key_version`; logging: redaction; compose: the store receives the
encryptor and a registry-backed catalog index, provider-app check as a
warning then as a `ConfigError`, a failure after the store is opened closes
the handle and stops the timers, `close()` does the same once, `getRoot()` memoisation, `bootOrExit()`
exit codes, in-memory ports, one warning at boot when `trusted_proxies` is
empty — naming the key, the variable and the 429 it costs — and none once it
is set, with the count in the configuration line; http: `/healthz` states, `healthResponse` on
plain `HealthDeps` with a fixed clock, and the client-address rule of
`client-ip.ts` with `isTrustedProxyEntry`), the integration
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
loads `argon2` and `better-sqlite3` inside the image, and its last step
fails when a test, spec, fixture or demo file of the repository was shipped
in it ([e2e-tests](../tests/e2e-tests.md), "Container smoke").
