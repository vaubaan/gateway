---
title: Instance configuration, crypto and composition root
status: current
date: 2026-10-13
last_synced: 2026-10-23
tracks:
  - apps/gateway/src/server/config/
  - apps/gateway/src/server/instance/
  - apps/gateway/src/app/api/admin/instance-name/route.ts
  - apps/gateway/tests/integration/instance/
  - apps/gateway/src/server/crypto/
  - apps/gateway/src/server/master-key/
  - apps/gateway/src/server/setup/
  - apps/gateway/src/app/api/setup/
  - apps/gateway/src/app/admin/bootstrap/page.tsx
  - apps/gateway/src/app/admin/(guarded)/encryption/page.tsx
  - apps/gateway/src/app/api/admin/master-key/
  - apps/gateway/src/server/reseal/
  - apps/gateway/src/server/restore/first-boot.ts
  - apps/gateway/src/server/store/repositories/sealed-blobs.ts
  - scripts/build-commands.mjs
  - apps/gateway/src/server/logging/
  - apps/gateway/src/server/compose/
  - apps/gateway/src/server/mail/
  - apps/gateway/src/server/http/
  - apps/gateway/tests/integration/compose/
  - apps/gateway/src/instrumentation.ts
  - apps/gateway/src/proxy.ts
  - deploy/docker/entrypoint.sh
  - apps/gateway/src/app/healthz/route.ts
  - apps/gateway/next.config.ts
  - apps/gateway/build-commit.txt
  - apps/gateway/tests/unit/structural/deployed-commit.test.ts
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
      sign-in.ts                sign-in providers: ids, issuerKey(), the open issuers, admissionProblem(), resolveAdminGroup()
      sources.ts                KEYS table (YAML path ↔ env var, defaults, bounds); env + YAML readers; merge
      secret-refs.ts            ${NAME}, ${file:/path}, X_FILE; the trace of secret files read or absent
      load.ts                   loadInstanceConfig(): merge, validate, ConfigError; loadInstanceConfigOrSetup(): the one tolerated absence
      errors.ts                 ConfigIssue / ConfigError / IssueList
      duration.ts               "30s" | "10m" | "24h" | "7d" → seconds
      self-resources.ts         readSelfResources(), isSelfResource(): the instance's own resources (RAILWAY_PROJECT_ID, FLY_APP_NAME + self_resources)
      build-info.ts             buildInfoFromEnv(): the version and commit stamps frozen by next.config.ts
      telemetry-default.ts      the single default URL of the code base
      testing.ts                validEnv(), fakeFiles() for tests
      keys-doc.test.ts          structural test: the key table of this handbook against KEYS
    crypto/
      master-key-file.ts        the key file: 32 random bytes, base64, 0600, never over an existing file; parents created (0700) at generation and by the setup
    master-key/                 the master key as the instance speaks of it: generated here or not, handed over or not, download (root.masterKey)
    setup/                      setup mode: the state on globalThis, the handler that receives the key of a copy to restore
      aead.ts                   XChaCha20-Poly1305 core, per-connection key, blob format
      encryptor.ts              Encryptor port + createEncryptor(config.encryption)
    logging/
      logger.ts                 JSON-lines logger with level threshold and child bindings
      redact.ts                 token-prefix and secret redaction
    compose/
      boot-config.ts            loadBootConfig(): the boot's loader; writes the master key file at the first start when told to
      ports.ts                  StoreLiveness, RateLimiter, SessionStore; re-exports gateway-core's CacheClient
      memory.ts                 MemoryRateLimiter, MemorySessionStore  // single-process only; tests
      registry.ts               buildEmptyRegistry(), RegistryCatalogIndex, checkSelfResources()
      shipped-plugins.ts        SHIPPED_PLUGINS, buildShippedRegistry(): the plugins the image ships
      store.ts                  openEmbeddedStore(): the SQLite store from store.path
      management.ts             wireManagementDoor(): the management door's ports as closures (handbook management-door)
      root.ts                   buildRoot(), getRoot() (globalThis), resetRoot(); wires authority/, auth/, missions/,
                                rate-limit/, connections/, shares/, groups/, requests/, audit/, budget/,
                                telemetry/, oauth-as/, users/, execution/ and the management door
      boot.ts                   bootOrExit(): exit 78 on ConfigError, 1 otherwise
      testing.ts                memoryStoreDeps, fakePlugin() — tests only
    http/
      healthz.ts                healthResponse(deps: HealthDeps), healthHandler(getDeps) — the root satisfies HealthDeps
      client-ip.ts              clientIpResolver(), isTrustedProxyEntry(): the one reading of trusted_proxies and X-Forwarded-For
      return-to.ts              resolveReturnTo(), isLocalPath(): return addresses limited to the public origin
      security-headers.ts       securityHeaders(), contentSecurityPolicy(): the headers src/proxy.ts sets on every response
  proxy.ts                      Next proxy: the security headers and the CSP nonce (see "Security headers")
    auth/                       OIDC relying party, web session, bootstrap, administrators (handbook authentication)
    users/                      the operator's deactivation and reactivation of a user (handbook authentication)
    providers/                  the provider reference pages: links, planes, reference model (handbook web-app)
    connections/                connect flows, resources, credential broker (handbook connections)
    missions/                   issuance, tokens, bootstrap kit (handbook missions)
    authority/, shares/, groups/  owner or union of shares, mission grounds, local groups (handbook authority)
    budget/, rate-limit/        session service, sliding windows (handbook budget-and-sessions)
    execution/                  the execution MCP door (handbook execution-door)
    oauth-as/, management/      the authorization server and the management MCP door (handbook management-door)
    telemetry/                  community telemetry: sink, toggle, validation status (handbook telemetry)
    requests/                   the creator's requests ("Waiting for you"), claim decisions, expiry sweeper (handbook requests)
    audit/                      audit search, mission session view, retention sweeper (handbook audit)
    store/                      the embedded SQLite store (handbook store)
    backup/                     the backup command, the scheduled encrypted backup and its S3 client (handbook store)
    restore/                    the restore command and the first-boot restore (handbook store)
scripts/gen-master-key.mjs      prints 32 random bytes, base64
deploy/config/                  gateway.example.yaml, .env.example (every key documented)
```

## Boot sequence

1. `next build` evaluates `instrumentation.ts` too, so `register()` returns
   immediately when `NEXT_PHASE === 'phase-production-build'` or the
   runtime is not `nodejs`.
2. At server start `register()` imports `compose/boot` and awaits
   `bootOrExit()`, which awaits `startInstance()`: `loadBootConfigOrSetup()`
   then `getRoot()` with the loaded configuration — or, when the master key
   file is absent, `restore.from` is set and the store is empty, **setup
   mode** ([below](#setup-mode-the-setup-receives-the-key-for-a-restore)):
   no root, the setup page receives the key.
3. `getRoot()` memoises the promise of `buildRoot()` on
   `globalThis[Symbol.for('vaubaan.gateway.root')]`. Route handlers,
   server components and tests call the same function and get the same
   root; a rejected build is forgotten so the next call retries.
4. `buildRoot()`:
   - `loadBootConfig()` (`compose/boot-config.ts`) → typed `InstanceConfig` or
     `ConfigError`. It is `loadProcessConfig()` with one more outcome: the
     master key file named by the configuration does not exist and
     `encryption.generate_master_key` is on → the file is written and the
     configuration loaded again with it ([below](#master-key-generated-at-the-first-start));
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
     window per prefix of a token an earlier build stored as argon2id — a
     flood of wrong secrets on such a prefix holds its agent at 429 until the
     token has been used once —, the authorization server's
     registration window and token window, one each for everybody — one
     caller can hold every delegated client at 429 when it renews its
     token —, `client_ip` absent from the audit) and `remedy`. Nothing is bypassed and the boot continues: the
     shared window is an accepted risk that the instance states (ADR
     [execution-door-json-faithful-arguments-and-shared-throttle](../decisions/execution-door-json-faithful-arguments-and-shared-throttle.md));
   - when the key was generated at this start, one `info` line (`master key
generated at the first start: the setup hands it over`, with the path
     and the key version, never the key);
   - `createEncryptor(config.encryption)` (awaits libsodium);
   - the plugin registry (`@vaubaan/plugin-sdk`'s `PluginRegistry`) from
     `RootDeps.buildRegistry`, by default `buildShippedRegistry`: the
     plugins imported by `compose/shipped-plugins.ts`. A
     plugin that fails `definePlugin` or a duplicate id fails the boot;
   - `logRetiredKeys`: one `warn` line per retired key or variable the
     configuration still sets (`config.retiredKeys`: the `providers.<id>.*`
     keys and the `VAUBAAN_PROVIDER_*` variables of earlier versions, see
     "Retired keys"), naming it, never its value; the boot goes on;
   - the embedded store from `RootDeps.openStore`, by default
     `openEmbeddedStore`. When `restore.from` is set it first calls
     `restoreAtFirstBoot` (`restore/first-boot.ts`): with no store file yet (or an
     empty one) the copy is restored and verified ([store](store.md#restore)),
     `store restored` is logged (bytes, sha256, schema version, key versions —
     never the source) and the boot goes on; a refused restore fails the boot
     (exit 1) and writes no store; with a store already there, one `warn` line
     (`RESTORE_SKIPPED_STORE_EXISTS`) and nothing else. Then `openStore()` of [store](store.md) on `config.store.path`
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
   - `createConnectionsModule()` →
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
     the requests' expiry sweeper (an `unref`-ed interval); `root.close()`
     stops it before closing the store. The per-IP limit of `/r/*` goes
     through `root.rateLimiter` and reads `trusted_proxies`;
   - `createAuditModule()` → `root.audit` (`query`, `sessions`,
     `retention`; handbook [audit](audit.md)); the root awaits
     `retention.start()`, which purges the audit entries and the session
     history older than `retention_days` once and then every hour, and `root.close()` stops
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
     `createBackupModule()` → `root.backup` (handbook
     [store](store.md#scheduled-backup)), whose `start()` arms the scheduled
     backup's timer when `backup.s3.*` is set — a run one minute after the
     boot when the store records no attempt within the last period — and whose
     `stop()` is registered on `opened` (it waits for a run in progress); then
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
`{status:"ok", version, commit, uptime_seconds, store:{kind,status}, backup}`, 503
`degraded` when the ping fails, 503 `unavailable` (with `reason`) when the
root cannot be built. `version` and `commit` are frozen into the bundle by `next.config.ts`
(`NEXT_PUBLIC_GATEWAY_VERSION`, `NEXT_PUBLIC_COMMIT_SHA`; `dev` outside a
build) and read by `config/build-info.ts` (`buildInfoFromEnv()`), like every
other read of the process environment. The commit is `resolveCommitSha`
(`next.config.ts`): the stamp `git archive` writes into
`apps/gateway/build-commit.txt` (`.gitattributes`: `export-subst`; a
checkout holds the placeholder `$Format:%H$`, which `commitFromStamp`
rejects), else the checkout's own HEAD (7 characters, `-dirty` when tracked
files differ), else `unknown`. No environment variable and no build
argument feed it: a hand-set `GIT_COMMIT_SHA` once kept an old commit on a
Railway instance (ADR
[deployed-commit-stamped-by-git-archive](../decisions/deployed-commit-stamped-by-git-archive.md);
`tests/unit/structural/deployed-commit.test.ts` archives a commit and reads
it back). The version is the `version` of the
root `package.json` and has no other source; the footer of the interface and
the telemetry field `gateway_version` show the same stamp
([coding workflow, "One version"](../workflow/coding-workflow.md#one-version)). The handler does not take the root:
`healthResponse(deps: HealthDeps)` needs the store's liveness (`kind`,
`ping`), a logger, the build stamps, `startedAt`, an optional `backup` (its
`health()`: `{configured:false}` or the latest run, no endpoint, bucket or
credential — handbook [store](store.md#scheduled-backup)) and an optional `now` (the
wall clock by default, a fixed instant in tests). `GatewayRoot` satisfies
`HealthDeps`, so the route passes `getRoot`.

## Security headers

`src/proxy.ts` (the Next 16 request hook, Node runtime; its `config.matcher`
skips `/git/`, the git remote, whose request bodies the hook would buffer and
cut — handbook [git-remote](git-remote.md)) sets on every other
response the headers of `server/http/security-headers.ts` (ADR
[security-headers-set-by-the-application](../decisions/security-headers-set-by-the-application.md)):
a Content-Security-Policy whose `script-src` admits `'self'`, the request's
nonce and `'strict-dynamic'` (no inline script without the nonce; `style-src`
keeps `'unsafe-inline'` for the `style` attributes React renders; `default-src
'self'`, `object-src 'none'`, `base-uri 'none'`, `frame-src 'none'`,
`frame-ancestors 'none'`; no `form-action`, which would break the posts that
end at a provider), `X-Frame-Options: DENY`, `X-Content-Type-Options:
nosniff`, `Referrer-Policy: same-origin`, a `Permissions-Policy` granting no
device, and `Strict-Transport-Security: max-age=31536000` when `public_url` is
https. The nonce reaches Next through the request's own `Content-Security-Policy`
header (and `x-nonce`); Next puts it on its scripts. Every HTML page is
rendered per request (the root layout reads the theme cookie), so every page
has its nonce. `buildRoot()` publishes whether `public_url` is https
(`publishHttps`, on `globalThis`); the proxy reads it and imports nothing of
the root. The OAuth consent documents (`/oauth/authorize/**`,
`OWN_POLICY_PATHS`) set their own, stricter headers and the proxy leaves them
alone. The reference Caddyfile sets none of these headers (one source; a
structural test in `security-headers.test.ts` holds it, and that only the
module, the proxy and the consent documents write a CSP).

## Framework

`apps/gateway` runs on **Next.js 16.4.1** with React 19.3.0 (from
15.5.18 / 19.1.1; 16.4.0 → 16.4.1 for the advisories of 2026-10-14, security
review 2026-10-15 M1). What the upgrade means for this module:

- `images: { unoptimized: true }`: no page uses `next/image`, so the image
  optimizer (`/_next/image`, sharp and libvips parsing bytes an
  unauthenticated caller chooses) is not served.

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
  runtime files of `better-sqlite3` (`package.json`, `lib/`, and since 13
  the prebuilt `prebuilds/<platform>-<arch>.node` of the building platform;
  nft adds the other systems' binaries of the same architecture, read from
  the loader), `./migrations/*.sql`, which
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
- No `middleware.ts` existed when 16.0 came (`src/proxy.ts` was added later,
  for the security headers only); the 16.0 codemods
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
from, plus the `sign_in.<id>.<field>` family. **It is machine-checked**:
`config/keys-doc.test.ts` parses it out of this file and fails when a key of
the loader has no row, when a row is not a key of the loader, or when a type,
a default, a bound or a variable differs from the loader's. To change a
default or a bound, change `KEYS` and this table together.

| Key                                               | Type       | Default                                    | Bounds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Environment variable                                                                                                                                                                                                                                                                   | Consumed by                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------- | ---------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public_url`                                      | URL        | required                                   | https; no query or fragment; a trailing `/` is stripped, a sub-path is kept                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `VAUBAAN_PUBLIC_URL`                                                                                                                                                                                                                                                                   | every module that builds an address: provider callbacks, request URLs, the bootstrap kit, the OAuth issuer and its endpoints, origin checks                                                                                                                                                                                                                                   |
| `instance_name`                                   | string     | —                                          | 1 to 64 characters; trimmed; no control character, line or paragraph separator, nor bidirectional override or isolate (`checkInstanceName`, `config/instance-name.ts`); blank is not set                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `VAUBAAN_INSTANCE_NAME`                                                                                                                                                                                                                                                                | `instance/settings.ts` (`InstanceNameService`). Not set: Setup (`/admin`) decides, and without a name the host of `public_url` is shown; set: that name, and the field is read-only                                                                                                                                                                                           |
| `trusted_proxies`                                 | list       | —                                          | —; each entry an IP address or a CIDR block (prefix 0–32 for IPv4, 0–128 for IPv6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `VAUBAAN_TRUSTED_PROXIES`                                                                                                                                                                                                                                                              | `http/client-ip.ts`, the one reading of `X-Forwarded-For`: execution door, request page, OAuth endpoints, management gate                                                                                                                                                                                                                                                     |
| `self_resources`                                  | list       | —                                          | —; each entry `<provider>:<ref>` (a plugin id, then the resource ref as discovery stores it); `railway:$RAILWAY_PROJECT_ID` is always added when Railway sets that variable, `fly:$FLY_APP_NAME` when Fly sets that one                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `VAUBAAN_SELF_RESOURCES`                                                                                                                                                                                                                                                               | `config/self-resources.ts`: the instance's own resources, never reachable by a mission — refused at issuance (`resource-self`), left out of the mission context at execution, flagged on the account page                                                                                                                                                                     |
| `client_ip_header`                                | enum       | —                                          | `x-real-ip`, `cf-connecting-ip`, `true-client-ip`, `fly-client-ip`; not together with `trusted_proxies`; off by default                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `VAUBAAN_CLIENT_IP_HEADER`                                                                                                                                                                                                                                                             | `http/client-ip.ts`: trusted-edge mode, the client address is that header's value (one IP, else unknown); safe only behind an edge that overwrites it (ADR [client-address-from-a-trusted-edge-header](../decisions/client-address-from-a-trusted-edge-header.md))                                                                                                            |
| `store.path`                                      | string     | required                                   | —; not empty                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `VAUBAAN_STORE_PATH`                                                                                                                                                                                                                                                                   | `compose/store.ts` (`openEmbeddedStore`)                                                                                                                                                                                                                                                                                                                                      |
| `restore.from`                                    | secret     | —                                          | —; an https URL (a redirect only to https, five at most) or an absolute file path; http refused; never echoed nor logged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `VAUBAAN_RESTORE_FROM`, `VAUBAAN_RESTORE_FROM_FILE`                                                                                                                                                                                                                                    | `restore/first-boot.ts`, called by `compose/store.ts` before the store opens: the copy restored when the store file does not exist yet (ignored with one `warn` once it does); the default source of `restore.mjs`                                                                                                                                                            |
| `restore.sha256`                                  | string     | —                                          | —; 64 hexadecimal characters; required with `restore.from`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `VAUBAAN_RESTORE_SHA256`                                                                                                                                                                                                                                                               | `restore/restore.ts`: the expected SHA-256 of the copy, checked before anything else is read                                                                                                                                                                                                                                                                                  |
| `restore.max_mb`                                  | integer    | `1024`                                     | 1 to 65536; in mebibytes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `VAUBAAN_RESTORE_MAX_MB`                                                                                                                                                                                                                                                               | `restore/restore.ts`: the largest copy accepted, by `Content-Length` before the download and by count during it; also the largest store an encrypted backup of format v2 may decompress to (its header declares it)                                                                                                                                                           |
| `encryption.master_key`                           | secret     | required                                   | —; exactly 32 bytes, in base64 or base64url                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `VAUBAAN_MASTER_KEY`, `VAUBAAN_MASTER_KEY_FILE`                                                                                                                                                                                                                                        | `crypto/encryptor.ts`                                                                                                                                                                                                                                                                                                                                                         |
| `encryption.key_version`                          | integer    | `1`                                        | >= 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `VAUBAAN_MASTER_KEY_VERSION`                                                                                                                                                                                                                                                           | `crypto/encryptor.ts`: the version stamped on new blobs                                                                                                                                                                                                                                                                                                                       |
| `encryption.previous_keys`                        | secret map | —                                          | —; `{version: key}` (`1=<b64>,2=<b64>` in the variable); a version is an integer >= 1 other than `key_version`; each key 32 bytes, base64                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `VAUBAAN_MASTER_KEY_PREVIOUS`, `VAUBAAN_MASTER_KEY_PREVIOUS_FILE`                                                                                                                                                                                                                      | `crypto/encryptor.ts`: opens the blobs written before a rotation                                                                                                                                                                                                                                                                                                              |
| `encryption.generate_master_key`                  | boolean    | `false`                                    | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `VAUBAAN_MASTER_KEY_GENERATE`                                                                                                                                                                                                                                                          | `compose/boot-config.ts`: when the key file named for `master_key` does not exist at a start, the boot writes it (32 random bytes, base64, mode 0600), then loads the configuration again; refused when the store already holds data (exit 78), with `restore.from`, and when the key is given by value instead of a file ([below](#master-key-generated-at-the-first-start)) |
| `idp.issuer`                                      | URL        | required once `idp` is set                 | https                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `VAUBAAN_IDP_ISSUER`                                                                                                                                                                                                                                                                   | `auth/` (`IdpSettingsService`); the `idp` block is optional and all-or-nothing. Not what names a user's issuer: that is the `iss` of the validated ID token (see "Changing the identity provider")                                                                                                                                                                            |
| `idp.client_id`                                   | string     | required once `idp` is set                 | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `VAUBAAN_IDP_CLIENT_ID`                                                                                                                                                                                                                                                                | `auth/` (`IdpSettingsService`)                                                                                                                                                                                                                                                                                                                                                |
| `idp.client_secret`                               | secret     | required once `idp` is set                 | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `VAUBAAN_IDP_CLIENT_SECRET`, `VAUBAAN_IDP_CLIENT_SECRET_FILE`                                                                                                                                                                                                                          | `auth/` (`IdpSettingsService`)                                                                                                                                                                                                                                                                                                                                                |
| `idp.claims.sub`                                  | string     | `sub`                                      | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `VAUBAAN_IDP_CLAIM_SUB`                                                                                                                                                                                                                                                                | `auth/claims.ts`: the claim carrying the stable subject, unique within its issuer: a user is the pair (issuer, subject)                                                                                                                                                                                                                                                       |
| `idp.claims.email`                                | string     | `email`                                    | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `VAUBAAN_IDP_CLAIM_EMAIL`                                                                                                                                                                                                                                                              | `auth/claims.ts`: the claim carrying the email address                                                                                                                                                                                                                                                                                                                        |
| `idp.claims.groups`                               | string     | `groups`                                   | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `VAUBAAN_IDP_CLAIM_GROUPS`                                                                                                                                                                                                                                                             | `auth/claims.ts`: the claim carrying the groups                                                                                                                                                                                                                                                                                                                               |
| `idp.allowed_email_domains`                       | list       | —                                          | —; lower-cased; empty: everyone the directory signs in — refused for an open issuer (personal Google or Microsoft) without `idp.invitation_only`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `VAUBAAN_IDP_ALLOWED_EMAIL_DOMAINS`                                                                                                                                                                                                                                                    | `auth/admission.ts`: the sign-in callback; invited addresses and the admin emails are admitted besides the domains                                                                                                                                                                                                                                                            |
| `idp.invitation_only`                             | boolean    | `false`                                    | —; not together with `idp.allowed_email_domains`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `VAUBAAN_IDP_INVITATION_ONLY`                                                                                                                                                                                                                                                          | `auth/admission.ts`: admit the invited addresses and the admin emails only                                                                                                                                                                                                                                                                                                    |
| `sign_in.<id>.<field>`                            | string     | —                                          | `kind`, `name`, `issuer`, `client_id`, `client_secret`, `claims.sub`, `claims.email`, `claims.groups`, `claims.email_verified`, `allowed_email_domains`, `invitation_only`, `require_verified_email`; the id is a lower-case letter then letters, digits or hyphens (32 at most), not `idp` when the `idp` block is set; `kind` is `oidc` or `github`; `issuer` https, required for `oidc` and never a github.com address there (GitHub is not an OpenID Connect provider: `kind: github`), default `https://github.com` for `github`; no `claims` and no `require_verified_email` for `github`; `claims.email_verified` defaults to `email_verified` (Entra ID: `xms_edov`), `require_verified_email` to false (true: an unverified email is refused, as on an open provider); one issuer per provider; an open provider needs domains or `invitation_only` | `VAUBAAN_SIGN_IN_<ID>_<FIELD>` (`KIND`, `NAME`, `ISSUER`, `CLIENT_ID`, `CLIENT_SECRET` and its `_FILE`, `CLAIM_SUB`, `CLAIM_EMAIL`, `CLAIM_GROUPS`, `CLAIM_EMAIL_VERIFIED`, `ALLOWED_EMAIL_DOMAINS`, `INVITATION_ONLY`, `REQUIRE_VERIFIED_EMAIL`; `-` in the id ↔ `_` in the variable) | `auth/sign-in-providers.ts` (`SignInProvidersService`): one more sign-in provider, callback `<public_url>/auth/callback/<id>`                                                                                                                                                                                                                                                 |
| `oauth_brokers.<name>.<field>`                    | string     | —                                          | `url`, `key`, `providers`, `attestation`; the name is a lower-case letter then letters, digits or hyphens (32 at most); `url` and `key` required, `url` https (http for a loopback host only, with `attestation: none`), no credentials, query or fragment, a path kept as the prefix of the calls; `key` a secret (`${file:…}` or `_FILE`); `providers` the broker providers it serves (`google`), lower-cased — none: the default broker, at most one; a provider served by one broker at most; `attestation` `required` (default) or `none`                                                                                                                                                                                                                                                                                                               | `VAUBAAN_OAUTH_BROKER_<NAME>_<FIELD>` (`URL`, `KEY` and its `_FILE`, `PROVIDERS`, `ATTESTATION`; `-` in the name ↔ `_` in the variable)                                                                                                                                                | `connections/oauth-broker.ts` (`OAuthBrokers`): the OAuth brokers the instance is enrolled with (section "OAuth brokers")                                                                                                                                                                                                                                                     |
| `admin.group`                                     | string     | —                                          | —; optional, a **seed** of the administrators (ADR administrators-live-in-the-instance): applied once, while the store names no administrator, as a group designation; `<provider>:<group>` (a GitHub group is `org/team`); a bare name only while one sign-in provider is configured; changed later, it is shown in Administration → Users and applied only by an administrator                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `VAUBAAN_ADMIN_GROUP`                                                                                                                                                                                                                                                                  | `auth/administrators.ts` (`seedFromConfiguration`, `resolveGroupDesignation`), `groups/` (a local group cannot take a designated group's name)                                                                                                                                                                                                                                |
| `admin.emails`                                    | list       | —                                          | —; optional; lower-cased; each entry contains `@`; a **seed**: applied once, while the store names no administrator — each address an administrator at its first sign-in through any provider (at once for a user already known by it)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `VAUBAAN_ADMIN_EMAILS`                                                                                                                                                                                                                                                                 | `auth/administrators.ts` (`seedFromConfiguration`)                                                                                                                                                                                                                                                                                                                            |
| `bootstrap_token`                                 | secret     | required while no sign-in provider is set  | at least 32 characters; refused once `bootstrap.revoked_at` is set in the store                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `VAUBAAN_BOOTSTRAP_TOKEN`, `VAUBAAN_BOOTSTRAP_TOKEN_FILE`                                                                                                                                                                                                                              | `auth/` (`BootstrapService`)                                                                                                                                                                                                                                                                                                                                                  |
| `mail.smtp_host`                                  | string     | —                                          | —; with `mail.from`, the whole `mail.*` block or none of it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `VAUBAAN_MAIL_SMTP_HOST`                                                                                                                                                                                                                                                               | `mail/` (`createLinkMailer`): the SMTP relay the instance sends the links of the local accounts through (ADR [local-accounts-sign-in-provider](../decisions/local-accounts-sign-in-provider.md)); absent, the links are handed over by an administrator                                                                                                                       |
| `mail.smtp_port`                                  | integer    | `587`                                      | 1 to 65535                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `VAUBAAN_MAIL_SMTP_PORT`                                                                                                                                                                                                                                                               | `mail/`                                                                                                                                                                                                                                                                                                                                                                       |
| `mail.smtp_user`                                  | string     | —                                          | —; with `mail.smtp_password`, both or neither                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `VAUBAAN_MAIL_SMTP_USER`                                                                                                                                                                                                                                                               | `mail/`                                                                                                                                                                                                                                                                                                                                                                       |
| `mail.smtp_password`                              | secret     | —                                          | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `VAUBAAN_MAIL_SMTP_PASSWORD`, `VAUBAAN_MAIL_SMTP_PASSWORD_FILE`                                                                                                                                                                                                                        | `mail/`; redacted from the log                                                                                                                                                                                                                                                                                                                                                |
| `mail.from`                                       | string     | —                                          | —; an address, or `Name <address>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `VAUBAAN_MAIL_FROM`                                                                                                                                                                                                                                                                    | `mail/`: the sender of every mail                                                                                                                                                                                                                                                                                                                                             |
| `mail.tls`                                        | enum       | `starttls`                                 | `starttls`, `implicit`, `none`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `VAUBAAN_MAIL_TLS`                                                                                                                                                                                                                                                                     | `mail/`: STARTTLS on a submission port (587), TLS from the first byte (465), or clear text for a relay on the same host                                                                                                                                                                                                                                                       |
| `backup.s3.endpoint`                              | URL        | —                                          | —; https, or http for `localhost` / `127.0.0.1` / `::1` only; an origin (no path, query or credentials); required with the other `backup.s3.*` keys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `VAUBAAN_BACKUP_S3_ENDPOINT`                                                                                                                                                                                                                                                           | `backup/s3/client.ts`: the S3-compatible service ([store, "Scheduled backup"](store.md#scheduled-backup))                                                                                                                                                                                                                                                                     |
| `backup.s3.region`                                | string     | —                                          | —; required with the other `backup.s3.*` keys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `VAUBAAN_BACKUP_S3_REGION`                                                                                                                                                                                                                                                             | `backup/s3/sigv4.ts`: the region of the SigV4 scope (`auto` for Tigris and R2)                                                                                                                                                                                                                                                                                                |
| `backup.s3.bucket`                                | string     | —                                          | —; 3 to 63 lower-case letters, digits, `.`, `-`; setting it (with the other required keys) turns the scheduled backup on                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `VAUBAAN_BACKUP_S3_BUCKET`                                                                                                                                                                                                                                                             | `backup/s3/client.ts`                                                                                                                                                                                                                                                                                                                                                         |
| `backup.s3.prefix`                                | string     | —                                          | —; literal, not starting with `/`, at most 512 characters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `VAUBAAN_BACKUP_S3_PREFIX`                                                                                                                                                                                                                                                             | `backup/scheduled.ts`: object keys `<prefix>vaubaan-backup-<UTC stamp>.vbk`; the retention lists under it                                                                                                                                                                                                                                                                     |
| `backup.s3.path_style`                            | boolean    | `false`                                    | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `VAUBAAN_BACKUP_S3_PATH_STYLE`                                                                                                                                                                                                                                                         | `backup/s3/client.ts`: `true` addresses `<endpoint>/<bucket>/<key>`, `false` `<bucket>.<endpoint host>/<key>`                                                                                                                                                                                                                                                                 |
| `backup.s3.access_key_id`                         | string     | —                                          | —; required with the other `backup.s3.*` keys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `VAUBAAN_BACKUP_S3_ACCESS_KEY_ID`                                                                                                                                                                                                                                                      | `backup/s3/sigv4.ts`                                                                                                                                                                                                                                                                                                                                                          |
| `backup.s3.secret_access_key`                     | secret     | —                                          | —; required with the other `backup.s3.*` keys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `VAUBAAN_BACKUP_S3_SECRET_ACCESS_KEY`, `VAUBAAN_BACKUP_S3_SECRET_ACCESS_KEY_FILE`                                                                                                                                                                                                      | `backup/s3/sigv4.ts`; redacted from the log, never shown                                                                                                                                                                                                                                                                                                                      |
| `backup.every`                                    | duration   | `24h`                                      | at most 86400 s; at least `1h`, and it divides a day                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `VAUBAAN_BACKUP_EVERY`                                                                                                                                                                                                                                                                 | `backup/scheduled.ts` (`nextRunAfter`): the period between two runs                                                                                                                                                                                                                                                                                                           |
| `backup.at`                                       | string     | `03:00`                                    | —; `HH:MM`, UTC                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `VAUBAAN_BACKUP_AT`                                                                                                                                                                                                                                                                    | `backup/scheduled.ts`: the day's first slot; the others follow every `backup.every`                                                                                                                                                                                                                                                                                           |
| `backup.keep`                                     | integer    | `0`                                        | 0 to 10000; `0` keeps every backup                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `VAUBAAN_BACKUP_KEEP`                                                                                                                                                                                                                                                                  | `backup/scheduled.ts` (`prune`): after an upload, the backups of this format beyond the newest N are deleted                                                                                                                                                                                                                                                                  |
| `telemetry.enabled`                               | boolean    | `false`                                    | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `VAUBAAN_TELEMETRY_ENABLED`                                                                                                                                                                                                                                                            | `telemetry/settings.ts`. Not set: off, and Settings → Telemetry decides; set (true or false): that value, and the page is read-only (`TelemetryConfig.enabledSetByConfig`)                                                                                                                                                                                                    |
| `telemetry.level`                                 | enum       | `usage-stats`                              | `plugin-health`, `usage-stats`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `VAUBAAN_TELEMETRY_LEVEL`                                                                                                                                                                                                                                                              | `telemetry/`. What enabled telemetry sends (spec §9): plugin-health reports only, or also the decision reports and the daily instance profile                                                                                                                                                                                                                                 |
| `telemetry.collector_url`                         | URL        | `https://telemetry.vaubaan.com/v1/reports` | https; a query is allowed (the collector's public key as `?apikey=`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `VAUBAAN_TELEMETRY_COLLECTOR_URL`                                                                                                                                                                                                                                                      | `telemetry/`. The default is `DEFAULT_TELEMETRY_COLLECTOR_URL`, the project's published collector; nothing is sent to it while `telemetry.enabled` is off                                                                                                                                                                                                                     |
| `retention_days`                                  | integer    | `90`                                       | >= 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `VAUBAAN_RETENTION_DAYS`                                                                                                                                                                                                                                                               | `audit/retention.ts` (the purge of audit entries, and of the session events and past-period counters of the same age: handbook [audit](audit.md)); shown on the Audit page                                                                                                                                                                                                    |
| `requests.expiry`                                 | duration   | `24h`                                      | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `VAUBAAN_REQUEST_EXPIRY`                                                                                                                                                                                                                                                               | `budget/session-service.ts`: how long a request to the creator stays answerable, a claim and an approval request alike                                                                                                                                                                                                                                                        |
| `approvals.expiry`                                | duration   | `10m`                                      | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `VAUBAAN_APPROVAL_EXPIRY`                                                                                                                                                                                                                                                              | `requests/request-service.ts` (applied when the creator grants) and `budget/session-service.ts` (told to the executor as `approval_valid_seconds`): how long a granted approval stays usable                                                                                                                                                                                  |
| `mcp.rate_limit_per_minute`                       | integer    | `600`                                      | >= 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `VAUBAAN_MCP_RATE_LIMIT_PER_MINUTE`                                                                                                                                                                                                                                                    | `execution/admission.ts`: requests per minute on the execution surface — the MCP door and the git remote together — per mission (spec §6; key `mcp:mission:<id>`)                                                                                                                                                                                                             |
| `git.max_pack_mb`                                 | integer    | `200`                                      | 1 to 4096; in mebibytes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `VAUBAAN_GIT_MAX_PACK_MB`                                                                                                                                                                                                                                                              | `git/push.ts`: the largest push body the git remote relays; a larger one is cut, refused and audited (spec §4.1 ter)                                                                                                                                                                                                                                                          |
| `git.request_timeout`                             | duration   | `10m`                                      | at most 3600 s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `VAUBAAN_GIT_REQUEST_TIMEOUT`                                                                                                                                                                                                                                                          | `git/door.ts`: how long one git request (a fetch relay, a push) may last before it is cut; under the 15 minutes Railway lets a request run; plus 5 min, the deadline of a push's temporary refs (`git/push.ts`)                                                                                                                                                               |
| `oauth.access_token_ttl`                          | duration   | `15m`                                      | at most 3600 s; that is `1h`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `VAUBAAN_OAUTH_ACCESS_TOKEN_TTL`                                                                                                                                                                                                                                                       | `oauth-as/token-service.ts`: lifetime of a delegated access token ([management-door](management-door.md))                                                                                                                                                                                                                                                                     |
| `oauth.refresh_token_ttl`                         | duration   | `30d`                                      | —; longer than `oauth.access_token_ttl`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `VAUBAAN_OAUTH_REFRESH_TOKEN_TTL`                                                                                                                                                                                                                                                      | `oauth-as/token-service.ts`: lifetime of a refresh token; restarts at every renewal                                                                                                                                                                                                                                                                                           |
| `oauth.delegation_max_lifetime`                   | duration   | `90d`                                      | —; longer than `oauth.access_token_ttl`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `VAUBAAN_OAUTH_DELEGATION_MAX_LIFETIME`                                                                                                                                                                                                                                                | `oauth-as/delegation-lifetime.ts`: absolute lifetime of a delegation, from the user's consent; past it the client must obtain the consent again                                                                                                                                                                                                                               |
| `oauth.refresh_reuse_window_seconds`              | integer    | `30`                                       | 0 to 60; `0` disables the window                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `VAUBAAN_OAUTH_REFRESH_REUSE_WINDOW_SECONDS`                                                                                                                                                                                                                                           | `oauth-as/token-service.ts`: how long the refresh token rotated last may be presented once more (two sessions renewing together)                                                                                                                                                                                                                                              |
| `oauth.client_registration.policy`                | enum       | `operator-approved`                        | `open`, `operator-approved`, `closed`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `VAUBAAN_OAUTH_CLIENT_REGISTRATION_POLICY`                                                                                                                                                                                                                                             | `oauth-as/clients.ts`, `oauth-as/handlers.ts`: who may become an OAuth client                                                                                                                                                                                                                                                                                                 |
| `oauth.client_registration.auto_approve_loopback` | boolean    | `true`                                     | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `VAUBAAN_OAUTH_CLIENT_REGISTRATION_AUTO_APPROVE_LOOPBACK`                                                                                                                                                                                                                              | `oauth-as/clients.ts`: under `operator-approved`, loopback-only clients need no approval                                                                                                                                                                                                                                                                                      |
| `oauth.client_registration.metadata_documents`    | boolean    | `false`                                    | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `VAUBAAN_OAUTH_CLIENT_REGISTRATION_METADATA_DOCUMENTS`                                                                                                                                                                                                                                 | `oauth-as/`: accept Client ID Metadata Documents (outbound https fetches) and advertise it in the server metadata                                                                                                                                                                                                                                                             |
| `log.level`                                       | enum       | `info`                                     | `debug`, `info`, `warn`, `error`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `VAUBAAN_LOG_LEVEL`                                                                                                                                                                                                                                                                    | `compose/root.ts`: the threshold of the logger                                                                                                                                                                                                                                                                                                                                |

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
  unless one is written — but a number of seconds past 2^53 (`300000000000d`)
  is not a duration; a `list` is a YAML sequence, or comma-separated in
  the variable; a `secret` also accepts the `_FILE` variable shown, which
  names a file holding the value; a `secret map` is a YAML mapping.
- **Consumed by**: the module that reads the value from `InstanceConfig`,
  under `apps/gateway/src/server/`.

Not in the tree: `VAUBAAN_CONFIG_FILE` (path of the YAML; unset means
environment only; set but unreadable, not valid YAML or not a mapping is an
error, and so is a key named `__proto__` or a YAML alias used inside its own
anchor, `a: &x [*x]` — each named as an issue of its key, never a crash at
boot; `apps/gateway/src/server/config/load.property.test.ts` feeds the
loader generated files and environments to hold that), and the listener variables `PORT` / `HOSTNAME` read by Next's
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
unsupported reference never becomes a literal secret.

Secret references in YAML: `${NAME}` is replaced by the environment
variable (unset → error naming the key), `${file:/run/secrets/x}` by the
trimmed file content. Both may appear inside a longer string.

Error format (one message, every problem):

```
Invalid instance configuration (2 problems):
  - encryption.master_key: missing required key (env: VAUBAAN_MASTER_KEY or VAUBAAN_MASTER_KEY_FILE)
  - public_url: must use https (got http) (env: VAUBAAN_PUBLIC_URL)
```

### Mail delivery

`mail.*` is optional as a block: `readMail` (`load.ts`) returns `null` when none
of its keys is set, and refuses by name a host without a sender (or the
reverse) and a user without a password (or the reverse). `mail.smtp_password`
is a secret (redacted from the log, `_FILE` sibling). The composition root
builds `createLinkMailer` (`server/mail/`) from the block and hands it to the
authentication and users modules (`RootDeps.mailer` injects a fake in tests);
`root.auth.sendsMail` tells the pages whether a link is mailed or handed over
(handbook [authentication](authentication.md), "Local accounts").

### Self resources

`InstanceConfig.selfResources` is the set of provider resources that host or
run this instance (SEC 2026-10-15 H1: a Railway connection lists the project
the gateway runs in, and `railway.read-variables` on it reads
`VAUBAAN_MASTER_KEY`). It is host-level: no plugin, connection, preset or
policy can add or remove one. Two sources, merged without duplicates:

- the platform — Railway sets `RAILWAY_PROJECT_ID` in every container it
  runs, so an instance on Railway always counts `railway:<its project id>`;
  Fly sets `FLY_APP_NAME` in every machine, so an instance on Fly always
  counts `fly:<its app name>`; the configuration cannot take either out;
- the `self_resources` key (`VAUBAAN_SELF_RESOURCES`, comma-separated), a
  list of `<provider>:<ref>` for any other host (the Vercel project, the SSH
  host, a Supabase project holding the backups). A malformed entry stops the
  boot like any other configuration problem, and so does an entry whose
  provider is no registered plugin (`checkSelfResources`, `compose/registry.ts`:
  it would match nothing and protect nothing).

Where it is enforced (each reads `config.selfResources` through
`isSelfResource(provider, ref)`):

| Where                                                  | What it does                                                                                                                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issuance (`missions/preview.ts`)                       | `IssuanceResource.self` is set; "all resources" leaves it out; an explicit selection is refused with `resource-self`                                                         |
| Management door (`management/views.ts`)                | not listed among the selectable resources                                                                                                                                    |
| Execution (`execution/mission-context.ts`)             | left out of the mission context whatever the stored policy says: the plugin binds no call to it, the resource stage refuses a call that cites it (`resource-not-in-mission`) |
| Mission detail and kit (`missions/mission-service.ts`) | not listed; a duplicated mission drops it                                                                                                                                    |
| Account page (`accounts/[id]/account-view.tsx`)        | tagged "this instance's own project: never reachable by a mission", not counted as reachable                                                                                 |
| Unbound tools (`execution/resource-stage.ts`)          | a connection that reaches one is `hosts_instance`: the plugin's `unboundTools` (Railway's agent) are refused on it and left out of `tools/list`; the account page says so    |

### Instance name

What the interface calls this instance (spec §4.2, §4.3), so that someone
with several instances open can tell them apart. `InstanceNameService`
(`server/instance/settings.ts`, `root.instance.name`) follows the rule of
every setting the file and the Administration page share (telemetry's
toggle, the sign-in providers):

| `instance_name` in the file / environment | Stored (`instance_config` key `instance.name`) | Shown (`label`)        | `source`  | Field     |
| ----------------------------------------- | ---------------------------------------------- | ---------------------- | --------- | --------- |
| set                                       | ignored                                        | that name              | `config`  | read-only |
| not set                                   | a name                                         | that name              | `admin`   | editable  |
| not set                                   | none                                           | the host of public_url | `default` | editable  |

`identity()` answers `{ label, name, host, source }` and reads the store on
every call (no copy in memory: a name saved by another replica is seen at
the next page). One rule checks a name wherever it comes from:
`checkInstanceName` (`config/instance-name.ts`) trims it and accepts 1 to 64
code points without a control character (`\p{Cc}`), a line or paragraph
separator, or a bidirectional embedding, override or isolate; the loader
refuses a bad `instance_name` at boot like any other key, and a stored value
that fails the check (a row written by hand) is ignored. The name is only
ever rendered as text: a React child, a `title` attribute, the document
`<title>`.

`POST /api/admin/instance-name` (`instance/handlers.ts`), form field `name`:
operator only, origin-checked (`guardMutation`). A non-blank name is saved
trimmed; a blank one deletes the key (the host is shown again). A change
writes one `config-changed` entry on `instance-config:instance-name` with
`before` / `after` `{ name, source }`; a save that changes neither writes
none. Every answer redirects to `/admin#instance-name`; a refusal adds
`?name-problem=locked|invalid|empty|too-long|control-character`.

Where it shows ([web-app](web-app.md), "The shell"): under the brand of the
shell and of the sign-in frame (the host in the tooltip), in "Sign in to
<name>", and in the title of the pages of `(app)`, Administration, `/login`
and `/admin/bootstrap` (`generateMetadata = instanceMetadata`,
`lib/instance.ts`: "<name> · Vaubaan"). The consent screen of the
authorization server (`server/http/document.ts`) keeps its own title.

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

### OAuth brokers

`oauth_brokers.<name>.*` enrolls the instance with an OAuth broker (ADR
[google-calendar-through-an-oauth-broker](../decisions/google-calendar-through-an-oauth-broker.md)
D1): a service outside the gateway that owns an OAuth client at a provider
and runs the authorization flow for the instance, so that a plugin whose
provider offers no key and no dynamic client registration (Google Calendar)
can connect. The broker keeps no token, and it is attested: it runs in an
enclave the gateway verifies before it sends anything (ADR
[oauth-broker-stateless-in-an-attested-enclave](../decisions/oauth-broker-stateless-in-an-attested-enclave.md)).
The contract between the two is
[oauth-broker-contract](oauth-broker-contract.md).

```yaml
oauth_brokers:
  main:
    url: https://api.broker.example.com:8443
    key: ${file:/run/secrets/oauth_broker_key}
    # providers: [google]     # none: this broker serves every provider
    # attestation: none       # your own broker, outside an enclave: not verified
```

`OAuthBrokerConfig { name, url, key, providers, attestation }`
(`config/types.ts`), read by `readOAuthBrokers` (`load.ts`) with the pure
rules of `config/oauth-brokers.ts`.

- **Which broker serves a plugin.** A plugin names a broker provider
  (`credential.broker.provider`, `google`). The broker whose `providers` lists
  it serves it; otherwise the **default broker**, the one without
  `providers`; otherwise none, and the plugin is listed as not configured on
  the connect page, with the reason (`brokerFor`). At most one default broker,
  and a provider listed by two brokers is a configuration error: the choice is
  never ambiguous. The simplest enrollment is one broker without `providers`.
- **The key** is a secret like every other: `${file:/path}` or `${NAME}` in the
  file, `VAUBAAN_OAUTH_BROKER_<NAME>_KEY` or `…_KEY_FILE` in the environment;
  it is redacted from the logs (`secretValues`) and taken out of
  `process.env` (`secretEnvVariables`). The gateway sends it as a Bearer to
  the broker and nowhere else.
- **The URL** is https, a root URL with a port
  (`https://api.broker.example.com:8443`): the reference broker serves at the
  root. A path, when one is given, is kept as the prefix of `/attest`,
  `/flows`, `/grants/redeem`, `/token`, `/revoke`. http is accepted only for
  `localhost`, `127.0.0.1` or `::1` **and** `attestation: none` (the tests'
  fake broker): an attested broker is reached over its own TLS key.
- **`attestation`** is `required` (the default) or `none`, case-insensitive;
  anything else is a configuration error. `required`: every call goes over a
  TLS connection whose key an attestation of the broker carries, and the
  attestation must name a broker version on the allowlist **shipped with this
  release** (`connections/broker-measurements.json`); otherwise the gateway
  sends nothing and the connection shows the broker's failure. The allowlist
  is empty until a broker is released: an attested broker then fails with "no
  attested broker version admitted by this release". `none`: an
  administrator's own broker outside an enclave, reached as any HTTPS service
  (certificate checked by the system's authorities); the connect page and the
  account page say it is **not attested**. Nothing in the configuration adds
  a broker version or a platform to the allowlist: `none` skips the check
  for one broker, it never widens what is admitted.
- A connection is refreshed and revoked through the broker it was made with,
  by name: renaming a broker block leaves the connections made through it
  unable to refresh ("OAuth broker 'old' … is no longer configured") until
  they are reconnected.

The gateway does not say who operates a broker; it knows a URL and a key.

### Retired keys

Nothing is configured per provider. The `providers.<id>.<field>` keys
(`client_id`, `client_secret`) and the `VAUBAAN_PROVIDER_<ID>_<FIELD>[_FILE]`
variables declared the OAuth client of a service that signed people in
through a client of the company (Gmail, until it moved to an app password:
ADR [gmail-over-imap-with-an-app-password](../decisions/gmail-over-imap-with-an-app-password.md)).
They are no longer read. `retiredConfigKeys` (`sources.ts`) lists the ones a
configuration still sets — every leaf under the file's `providers` block and
every `VAUBAAN_PROVIDER_*` variable — into `InstanceConfig.retiredKeys`, and
the root logs one warning per entry (`logRetiredKeys`), naming it, never its
value; the instance starts. Every `VAUBAAN_PROVIDER_*` variable is still taken
out of `process.env` with the secrets (one of them held a client secret), and
anything under the `providers` block counts as a secret path
(`isSecretKeyPath`). The OAuth client the gateway registers itself at a
service that accepts dynamic registration (Miro) is not configuration: it is
kept in `instance_config` (handbook [connections](connections.md)).

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

| What                                                                                    | Value          | Constant                                                 | Module                                  |
| --------------------------------------------------------------------------------------- | -------------- | -------------------------------------------------------- | --------------------------------------- |
| Window of `mcp.rate_limit_per_minute`                                                   | 1 min          | `SURFACE_RATE_WINDOW_MS`                                 | `execution/door.ts`                     |
| argon2id verifications of a legacy token per prefix and client address (`mcp-verify:…`) | 30 per minute  | `VERIFY_ATTEMPTS_PER_WINDOW`, `VERIFY_WINDOW_MS`         | `execution/token-verifier.ts`           |
| Longest time a derived upstream credential is cached                                    | 55 min         | `MAX_UPSTREAM_CREDENTIAL_TTL_SECONDS`                    | `execution/credential-cache.ts`         |
| Longest agent label                                                                     | 64 characters  | `AGENT_LABEL_MAX_LENGTH`                                 | `missions/bootstrap-kit.ts`             |
| Longest `User-Agent` kept in the audit                                                  | 256 characters | `USER_AGENT_MAX_LENGTH`                                  | `execution/request-meta.ts`             |
| Longest upstream error summary kept in the audit                                        | 200 characters | `UPSTREAM_ERROR_SUMMARY_MAX_LENGTH`                      | `packages/gateway-core/src/pipeline.ts` |
| Longest structural rejection reason kept in the audit                                   | 500 characters | `AUDIT_REASON_MAX_LENGTH`                                | `packages/gateway-core/src/pipeline.ts` |
| Stack frames logged when a decision stage fails                                         | 12             | `STACK_FRAMES_LOGGED`                                    | `execution/index.ts`                    |
| A token's "last used" is written at most once per                                       | 60 s           | `TOKEN_LAST_USED_GRANULARITY_SECONDS`                    | `execution/door.ts`                     |
| Request page `/r/<id>` per client address (`request-page:ip:…`)                         | 30 per minute  | `REQUEST_PAGE_RATE_LIMIT`, `REQUEST_PAGE_RATE_WINDOW_MS` | `requests/handlers.ts`                  |
| Expiry sweep of claims and approval requests                                            | every minute   | `REQUEST_SWEEP_INTERVAL_MS`                              | `requests/sweeper.ts`                   |
| Session events shown on the request page                                                | 20             | `SESSION_EVENTS_SHOWN`                                   | `requests/request-service.ts`           |

The execution door has no request-body size limit and no upstream call
timeout of its own: no such constant exists.

Telemetry (`telemetry.enabled`, `telemetry.level` and `telemetry.collector_url`
are the three keys):

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

| What                                                    | Value                | Constant                                        | Module                                            |
| ------------------------------------------------------- | -------------------- | ----------------------------------------------- | ------------------------------------------------- |
| Web session, absolute lifetime                          | 8 h                  | `SESSION_TTL_MS`                                | `auth/session-service.ts`                         |
| Time to come back from the IdP                          | 10 min               | `LOGIN_TTL_MS`                                  | `auth/session-service.ts`                         |
| Clock skew tolerated on an ID token                     | 60 s                 | `DEFAULT_CLOCK_TOLERANCE_SECONDS`               | `auth/relying-party.ts`                           |
| Connect attempts per user (`connect:<user>`)            | 10 per minute        | `CONNECT_RATE_LIMIT`, `CONNECT_RATE_WINDOW_MS`  | `connections/service.ts`                          |
| Resource discovery timeout                              | 30 s                 | `DISCOVERY_TIMEOUT_MS`                          | `connections/service.ts`                          |
| Provider token endpoint timeout                         | 15 s                 | `TOKEN_REQUEST_TIMEOUT_MS`                      | `connections/oauth2.ts`                           |
| An access token expiring within this delay is refreshed | 60 s                 | `REFRESH_SKEW_MS`                               | `connections/credentials.ts`                      |
| Pending connect flow, and its notice                    | 10 min, 5 min        | `CONNECT_TTL_MS`, `NOTICE_TTL_MS`               | `connections/pending.ts`                          |
| Longest connection name                                 | 80 characters        | `MAX_NAME_CHARS`                                | `connections/input.ts`                            |
| Longest mission name                                    | 120 characters       | `MISSION_NAME_MAX_LENGTH`                       | `missions/preview.ts`                             |
| Longest name of a named mission token                   | 60 characters        | `TOKEN_NAME_MAX_LENGTH`                         | `missions/token-name.ts`                          |
| Shortest and longest recurring period of a mission      | 60 s, 366 days       | `MIN_PERIOD_SECONDS`, `MAX_PERIOD_SECONDS`      | `missions/preview.ts`                             |
| Longest local group name                                | 80 characters        | `GROUP_NAME_MAX_LENGTH`                         | `groups/errors.ts`                                |
| Retention sweep of the audit (after the one at boot)    | every hour           | `RETENTION_SWEEP_INTERVAL_MS`                   | `audit/retention.ts`                              |
| Activity page size; session timeline page size          | 50; 100              | `AUDIT_PAGE_SIZE`, `SESSION_EVENTS_PAGE_SIZE`   | `audit/query-service.ts`, `audit/session-view.ts` |
| SQLite busy timeout                                     | 5 s                  | `DEFAULT_BUSY_TIMEOUT_MS`                       | `store/db.ts`                                     |
| A scheduled backup made up after a missed slot          | 1 min after the boot | `CATCH_UP_DELAY_MS`                             | `backup/scheduled.ts`                             |
| Largest backup uploaded in one PUT; multipart part size | 64 MiB; 16 MiB       | `SINGLE_PUT_MAX_BYTES`, `MULTIPART_PART_BYTES`  | `backup/scheduled.ts`                             |
| One upload request; any other request to the storage    | 10 min; 60 s         | `S3_UPLOAD_TIMEOUT_MS`, `S3_REQUEST_TIMEOUT_MS` | `backup/s3/client.ts`                             |
| Chunk of an encrypted backup                            | 1 MiB                | `BACKUP_CHUNK_BYTES`                            | `crypto/backup-file.ts`                           |
| Brotli quality of an encrypted backup (format v2)       | 4                    | `BACKUP_BROTLI_QUALITY`                         | `crypto/backup-file.ts`                           |
| Download of a restore, start to end                     | 30 min               | `DOWNLOAD_TIMEOUT_MS`                           | `restore/restore.ts`                              |
| Redirects a restore download follows (each to https)    | 5                    | `MAX_REDIRECTS`                                 | `restore/restore.ts`                              |
| Entries of the in-memory cache                          | 10 000               | `DEFAULT_MAX_ENTRIES`                           | `packages/gateway-core/src/cache.ts`              |
| Keys after which the sliding-window limiter prunes      | 10 000               | `DEFAULT_PRUNE_THRESHOLD`                       | `rate-limit/sliding-window.ts`                    |

Limits that belong to one plugin are in that plugin's page under
[providers](providers/README.md) (the GitHub job log bounds in
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
naming `encryption.previous_keys`. The `reseal` command then seals every old
blob again under the new key, after which the old key is removed (below).

### Master key generated at the first start

ADR [master-key-generated-and-handed-over-by-the-instance](../decisions/master-key-generated-and-handed-over-by-the-instance.md).
A self-hoster need not generate the key by hand: with
`encryption.generate_master_key: true` (`VAUBAAN_MASTER_KEY_GENERATE=1`) and
the key named as a file (`VAUBAAN_MASTER_KEY_FILE=/data/master.key`, or
`master_key: ${file:/data/master.key}` in the YAML file — the whole value, one
reference), the first start writes the file and the setup hands the key to
the administrator. `deploy/config/.env.example` ships that way.

**At boot** (`loadBootConfig`, `compose/boot-config.ts`):

1. `loadInstanceConfigOrSetup()` loads the configuration. The readers note the
   secret files they read a whole value from and the ones that do not exist
   (`SourceTrace`, `secret-refs.ts`). One absence is tolerated: the master
   key's file, from the source that wins for that key, when the raw
   configuration enables generation or names `restore.from` — the outcome is
   then `SetupOutcome` (`kind: 'setup'`, the path, the reason, everything else
   validated as `SetupConfig`, the configuration without its `encryption`
   block). Every other absent secret file, and every other problem, is a
   `ConfigError` as before. `loadInstanceConfig()` turns the outcome into the
   error of old with a hint (`the gateway writes it at its first start`, or
   `a restore needs the key the copy was sealed with`): the operator commands
   never generate anything.
2. The reason must be `generate`: an absent key with `restore.from` is setup
   mode when the store is empty ([below](#setup-mode-the-setup-receives-the-key-for-a-restore)),
   and exit 78 with that hint once the store holds data.
3. `storeHasContent(store.path)` (`restore/restore.ts`, the rule of the
   first-boot restore: an empty file is no store) must be false, else exit 78
   naming the key file and the store: _a key missing on an existing store is a
   configuration error, never a reason to generate a new one (put the key file
   back)_.
4. `writeGeneratedMasterKeyFile` (`crypto/master-key-file.ts`): the missing
   parent directories of the path are created first (`mkdir -p`, mode 0700
   for the ones created, an existing directory left as it is — an empty
   volume has no `/data/keys/` yet), then `writeMasterKeyFile` writes 32
   random bytes in base64 and a newline — the format `master_key` reads and
   `gen-master-key` prints —, mode 0600, flag `wx` (never over an existing
   file). A failure is a `ConfigError` naming the path, exit 78 (a parent
   that is not a directory, a directory that cannot be created, a read-only
   volume).
5. The configuration is loaded again, now `ready`; the secret variables are
   deleted from the environment (the `_FILE` path included);
   `LoadedConfig.masterKeyGenerated` is `true` for this start only.

The loader refuses the opt-in in two configurations, both at load time:
with a key given by value (`encryption.generate_master_key: applies to a key
read from a file`), and with `restore.from` (`cannot be set with restore.from:
a restored copy opens with the key it was sealed with`). With the file present
the flag is the steady state: read, kept, nothing written. `EncryptionConfig`
carries `masterKeyFile` (the path, or `null` for a key by value; not a secret)
and `generateMasterKey`; `createEncryptor` takes `EncryptionKeys`, the three
key fields alone.

**Handed over by the setup** (`server/master-key/`, `root.masterKey`;
page: handbook [authentication](authentication.md), "Pages", `/admin` and
`/admin/encryption`):

- `MasterKeyService.state()`: the key version, the file, `generatedAt`
  (`instance_config` key `master_key.generated_at`, written by the boot that
  generated the file through `recordGenerated()`, once), `handedOverAt`
  (`master_key.handed_over_at`, written by `confirmHandover()`, once) and
  `handoverPending` (generated here, not confirmed yet). `fileText()` is the
  key as its file holds it: what the download hands over. Neither key of
  `instance_config` is a secret: two timestamps.
- `POST /api/admin/master-key/download` (`confirmed=on`, `from=setup|settings`;
  `createMasterKeyHandlers`): operator only, origin-checked; **a fresh sign-in**
  — the session behind the request was opened less than `FRESH_SIGN_IN_MS`
  (10 min) ago (`signedInFreshly`, read from `SessionService.read()`), else
  `?key-problem=sign-in-again`; from Settings the box must be ticked, else
  `?key-problem=not-confirmed` (on Setup the step is the confirmation). Then
  one `master-key-downloaded` audit entry (`instance-config` / `master-key`,
  `after: { key_version, from }`) is written **before** the file leaves — a
  write that fails refuses the download — and one `info` line (actor, page,
  version), then the file: `text/plain`, `Content-Disposition: attachment;
filename="vaubaan-master-key.txt"`, `Cache-Control: no-store`.
- `POST /api/admin/master-key/handed-over` (`confirmed=on`): operator only,
  origin-checked; sets `master_key.handed_over_at` and writes one
  `config-changed` entry (`before: { handed_over_at: null }`, `after:
{ handed_over_at }`); a second confirmation keeps the first timestamp and
  writes nothing; back to `/admin`.
- Nothing of the key reaches a log line, an audit entry, a refusal or a page:
  the redactor holds the key in every encoding (`secretValues`), and the pages
  show the path, the version and the dates.

### Setup mode: the setup receives the key for a restore

ADR [master-key-generated-and-handed-over-by-the-instance](../decisions/master-key-generated-and-handed-over-by-the-instance.md),
amendment. Moving an instance to a new host without a shell: the new machine
has `restore.from` and `restore.sha256`, an empty volume and no key file.

- **The boot** (`startInstance`, `compose/boot.ts`): `loadBootConfigOrSetup`
  returns `kind: 'setup'` (the `SetupOutcome` of the loader, reason
  `restore`, and a **snapshot** of the environment); the process's own
  environment is scrubbed at once. No root is built. One `warn` line
  (`starting in setup mode`: the key file, the store path, the public origin,
  whether a bootstrap token is set, the remedy) and the state is published
  (`publishSetup`, `server/setup/state.ts`, on `globalThis`): the validated
  `SetupConfig`, the key file path, a logger whose redactor holds every
  secret of that configuration, the build, a rate limiter, and `complete()`.
  `/healthz` answers 200 `{ status: 'setup', reason }` (`setupResponse`); the
  proxy (`proxy.ts`) sends every path but `/admin/bootstrap`,
  `/api/setup/**`, `/healthz` and the assets (`servedInSetupMode`) to
  `/admin/bootstrap`, at `public_url`; `getRoot()` rejects with
  `SetupModeError` unless called with a `loadConfig` (the completion). A
  store that holds data with an absent key stays exit 78
  (`the store already holds data: put the key file back`).
- **The page**: `/admin/bootstrap` renders "Restore this gateway"
  (`SetupKeyPage`, handbook [authentication](authentication.md), "Pages"):
  the bootstrap token and the key file; without a `bootstrap_token` in the
  configuration it says the gateway cannot receive the key here
  (`setup-no-token`).
- **`POST /api/setup/master-key`** (`createSetupHandlers(state).receiveKey`,
  multipart `token` + `key`; 404 outside setup mode): origin-checked against
  `public_url`; `AUTH_LIMITS.bootstrapPerInstance` (10 per 10 min,
  `too-many-attempts`); the token compared in constant time, every wrong one
  counted (`bootstrap-refused`, then `setup-locked` at `BOOTSTRAP_MAX_MISSES`
  for the rest of this start); the file at most `MAX_KEY_FILE_BYTES` (4096)
  and `parseMasterKeyText` (`crypto/master-key-file.ts`: 32 bytes, base64 or
  base64url, one line — the loader's rule; else `key-invalid`, `key-missing`
  for no file). Then `writeGeneratedMasterKeyFile` (the missing parent
  directories created, 0700 — a new host's empty volume; the file 0600, `wx`:
  a second upload while one is being installed is `key-busy`) and `complete()`: `getRoot` with
  `loadBootConfig({ env: snapshot })` → the normal boot, `restoreAtFirstBoot`
  included (hash, integrity, migrations, **every sealed blob opens with the
  received key**), the store opens, the root serves. A boot that throws
  removes the key file (`unlink`), keeps the message as `lastRefusal` (shown
  on the page: the restore's message names the check, never the source) and
  answers `restore-refused`; setup mode goes on. Success clears the state
  (`clearSetup`) and sends the browser to `/admin/bootstrap`, now the token
  sign-in of the restored instance. Every refusal is
  `303 /admin/bootstrap?error=<code>`; no log line, page or URL carries the
  key or the token.

### Rotating the master key

ADR [master-key-rotation-reseals-every-blob](../decisions/master-key-rotation-reseals-every-blob.md).
Three columns hold sealed blobs (`store.sealedBlobs`,
`store/repositories/sealed-blobs.ts`, is the one list of them):
`connections.credential_blob` (associated data: the connection id),
`instance_config.secret_blob` (`instance_config:<key>`) and
`requests.args_blob` (`request:<id>`).

0. Back up the store first (`node apps/gateway/backup.mjs`, handbook
   [store](store.md#backup)) and keep the copy with the **current** key: it
   opens with that key only. With the scheduled backup on, the backups already
   in the bucket open with the old key too: keep it (in a safe place, or in
   `VAUBAAN_MASTER_KEY_PREVIOUS`) as long as one of them is kept — with
   `backup.keep` N and one run a day, N days after the rotation (ADR
   [scheduled-encrypted-backup-to-object-storage](../decisions/scheduled-encrypted-backup-to-object-storage.md), D10).
1. Generate a key (`npm run gen-master-key`, on a trusted machine). Set it as
   `VAUBAAN_MASTER_KEY`, raise `VAUBAAN_MASTER_KEY_VERSION` by one (the
   default is `1`), and put the old key in
   `VAUBAAN_MASTER_KEY_PREVIOUS=<old version>=<old key>`.
2. Deploy (restart) **once**, with the three variables changed together: a
   start with the new key and the old version opens nothing. The instance opens
   old blobs with the previous key and seals new ones with the new key. At boot
   it opens one blob per table and key version (`store.sealedBlobs.probe()`,
   `checkSealedKeys` in `compose/root.ts`); a version with no configured key, or
   whose key does not open it, is logged at `error` ("stored secrets do not open
   with the configured master keys"), naming the version. The instance still
   starts (ADR amendment).
3. Inside the container, as the image user, run the dry run, then apply, then
   the dry run again:

   ```bash
   node apps/gateway/reseal.mjs           # opens every blob, writes nothing
   node apps/gateway/reseal.mjs --apply   # seals the stale blobs again
   node apps/gateway/reseal.mjs           # "nothing to reseal: every blob is sealed under version N"
   ```

   On a platform that starts the container as root (Railway with
   `RAILWAY_RUN_UID=0`), prefix each command with `vaubaan-entrypoint`, which
   drops to the image user; run as root the command exits 77. With Compose:
   `docker compose exec gateway node apps/gateway/reseal.mjs`.

4. Once the report says every blob is under the new version, remove
   `VAUBAAN_MASTER_KEY_PREVIOUS` and deploy again.
5. Backups taken before step 3 are still sealed under the old key: keep the
   old key with them, or destroy them.

The report counts per table: `current` (already under the current version),
`current unreadable` (of those, the ones the current key does not open: every blob
is opened, the current ones too, so a new key set without raising its version is
caught before `--apply`; exit 1),
`resealed` / `to reseal`, `unreadable` (no key for its version, or the wrong
key under that version: left as it is, exit 1) and `changed` (rewritten by
the running gateway between the read and the write: left as the gateway wrote
it, exit 1, run again). The last line is the verdict, in a dry run as after
`--apply`: "nothing to reseal: every blob is sealed under version N and opens with
the current key. VAUBAAN_MASTER_KEY_PREVIOUS can now be removed" only when no blob
is stale, unreadable, current-unreadable or changed. Run it from the container that
serves the store: it opens the store like the server does, migrations included. Each table is written in one `BEGIN IMMEDIATE`
transaction, each row by compare-and-swap on the blob read, so the command is
safe beside the running server and idempotent. It never prints a blob, an id
or a key; an unexpected failure prints one fixed line. Exit codes: 0, 1, 64
usage, 77 root, 78 not configured or no store file.

Nothing reads a secret from `process.env` outside `server/config`: the v4
shim `lib/crypto/index.ts` and the v4 `lib/` code that read their own
`*_SECRET` / `*_KEY` variables were deleted with the v4 application.

**Secrets leave `process.env` once loaded** (ADR
[secrets-leave-the-process-environment-after-load](../decisions/secrets-leave-the-process-environment-after-load.md)).
`loadInstanceConfig()` returns `secretEnvNames`: the variables that carried a
secret or its path — the `secret` / `secret-map` keys of the table and their
`_FILE` siblings, `VAUBAAN_SIGN_IN_<ID>_CLIENT_SECRET[_FILE]`,
every retired `VAUBAAN_PROVIDER_*` variable, and the variables
the YAML file references with `${NAME}` at a secret key (`isSecretKeyPath`).
`loadProcessConfig()`, the default loader of `buildRoot` and of the
`import-v4` and `reseal` commands, deletes them from `process.env`
(`scrubSecretEnv`); the values live on in `InstanceConfig` only, and a child
process inherits none. The kernel still shows the initial environment in
`/proc/<pid>/environ` to the same user and to root: anyone with a shell in the
container reads the secrets there (threat model A1).

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

An unexpected error is logged as `errorFields(err)` — `error_class` and
`stack_frames`, never its message (`logging/error-fields.ts`). Next.js prints
the errors of route handlers itself, with `console.error`: after a successful
boot `instrumentation.ts` calls `guardFrameworkLogging()`, which installs
`guardConsole` (`logging/console-guard.ts`): `console.error` and
`console.warn` print through the redactor, an `Error` argument as its class,
its digest and its frames with `[message withheld]`. A provider's error text
never reaches a log line, the store or a page: ADR
[provider-error-text-stays-with-the-agent](../decisions/provider-error-text-stays-with-the-agent.md).

## Ports and their single-process implementations

| Port             | Today                                                                                                                                                                                          | Hosted replacement                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `StoreLiveness`  | the embedded SQLite store of [store](store.md) (`openEmbeddedStore`)                                                                                                                           | Postgres behind the same repositories              |
| `PluginRegistry` | `@vaubaan/plugin-sdk`'s registry over `SHIPPED_PLUGINS` (`compose/shipped-plugins.ts`)                                                                                                         | same (static)                                      |
| `RateLimiter`    | `SlidingWindowRateLimiter` (`server/rate-limit/`, handbook [budget-and-sessions](budget-and-sessions.md)): the same instance holds the budget's windows; `MemoryRateLimiter` remains for tests | one Redis sorted set per key                       |
| `CacheClient`    | `@vaubaan/gateway-core`'s `MemoryCacheClient` (TTL in seconds, bounded): the plugins' derived upstream credentials ([execution-door](execution-door.md))                                       | upstream credentials stay per replica or encrypted |
| `SessionStore`   | `store.webSessions` (`server/store/repositories/web-sessions.ts`, table `web_sessions`, migration 0003, rows keyed by SHA-256 of the id); `MemorySessionStore` remains for unit tests          | Redis, or Postgres rows behind the same port       |

`GatewayRoot.store` is the full store with its repositories
(`StoreLiveness` of `ports.ts` is only the slice `/healthz` and `close()`
need); the `globalThis` handle of `getRoot()` is per process by design
(`// single-process only`: every replica builds its own root);
`GatewayRoot.registry` is the SDK registry itself, so every provider list
derives from one object; `GatewayRoot.auth` is the authentication module; `GatewayRoot.connections` is the
connections module, which shares the
root's `SessionStore` (keys `connect:<state>` and `notice:<id>` next to
`session:` and `login:`) and its `RateLimiter` (key `connect:<userId>`);
`GatewayRoot.budget` and `GatewayRoot.execution` are the budget's session
service and the execution door (rate-limit keys `mission:<id>:risk:<id>`,
`mcp:mission:<id>`, `mcp-verify:<prefix>:<client address>`; cache keys
`mission-token:<hash>`, `upstream-credential:<connection>:…`);
`GatewayRoot.authority`, `GatewayRoot.shares` and `GatewayRoot.groups` are
the authority, share and local-group modules; `GatewayRoot.users` is
Settings → People (`/admin/users`: the operator's deactivation and reactivation of a
user);
`GatewayRoot.telemetry` is community telemetry (cache key
`telemetry:plugin-stats`); `GatewayRoot.oauth` is the authorization server
(`SessionStore` key `oauth-consent:<id>`, rate-limit keys
`oauth:register:ip:<address>`, `oauth:register`, `oauth:token:ip:<address>`,
`oauth:token:client:<id>`, `oauth:token:delegation:<id>`, `oauth:client-document:<requester>`) and
`GatewayRoot.management` is the management door (rate-limit keys
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
failures, https rule, precedence, admin rule, the instance name (bounds,
trim, file over environment) and `instance/settings.test.ts` (who names the
instance), secret references, provider
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
the integration test `apps/gateway/tests/integration/instance/instance-name.test.ts`
(the Administration POST: stored and audited, cleared, invalid names,
non-administrators and foreign origins refused, read-only when the
configuration names the instance), the master key generated and handed over
(`config/master-key-absent.test.ts`: the tolerated absence and its refusals;
`compose/boot-config.test.ts`: generation, the store-holds-data refusal, the
environment scrubbed, over fakes; `crypto/master-key-file.test.ts`: the file's
format, 0600, never over an existing file, the parent directories created at
generation;
`tests/integration/compose/master-key-generation.test.ts`: the real boot on a
temporary directory, the file written, the log line, the second start, the
refusals at exit 78; `tests/integration/instance/master-key-handover.test.ts`:
the download audited by name before it leaves, the fresh-sign-in rule, the
confirmation and every refusal; `tests/integration/compose/setup-mode-restore.test.ts`:
setup mode on a real copy — no root, the environment scrubbed, the health
answer, the redirected paths, every refusal, a wrong key refused by the
restore and removed again, the right key restoring the copy and the gateway
serving), the structural test `apps/gateway/tests/unit/structural/no-hardcoded-config.test.ts`
(no literal URL, secret or project ref in the v5 perimeter except
`telemetry-default.ts` and `deploy/config/*.example*`),
`apps/gateway/tests/unit/structural/example-config-providers.test.ts` (neither
example sets a retired key: no `providers:` block in the YAML, no
`VAUBAAN_PROVIDER_*` line in `.env.example`, commented or not) and
`apps/gateway/tests/integration/standalone-native-addons.test.ts` (skipped
without a build: the `/healthz` route trace lists the `argon2` and
`better-sqlite3` binaries, and both load from the standalone
`node_modules`). The container smoke test is `deploy/docker/smoke.sh`; it
loads `argon2` and `better-sqlite3` inside the image, and its last step
fails when a test, spec, fixture or demo file of the repository was shipped
in it ([e2e-tests](../tests/e2e-tests.md), "Container smoke").
