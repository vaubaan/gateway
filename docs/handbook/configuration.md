---
title: Instance configuration, crypto and composition root
status: current
date: 2026-10-13
tracks:
  - apps/gateway/src/server/config/
  - apps/gateway/src/server/crypto/
  - apps/gateway/src/server/logging/
  - apps/gateway/src/server/compose/
  - apps/gateway/src/server/http/
  - apps/gateway/src/instrumentation.ts
  - apps/gateway/src/app/healthz/route.ts
  - apps/gateway/src/lib/crypto/index.ts
  - apps/gateway/next.config.ts
  - deploy/config/gateway.example.yaml
  - deploy/config/.env.example
  - scripts/gen-master-key.mjs
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
      ports.ts                  Store, PluginRegistry, RateLimiter, CacheClient, SessionStore
      memory.ts                 in-memory implementations  // single-process only
      root.ts                   buildRoot(), getRoot() (globalThis), resetRoot()
      boot.ts                   bootOrExit(): exit 78 on ConfigError, 1 otherwise
    http/
      healthz.ts                healthResponse(root), healthHandler(getRoot)
  lib/crypto/index.ts           LEGACY v4 shim over the new encryptor (deleted in Phase 1)
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
   - store and registry from `RootDeps.openStore` / `buildRegistry`, or the
     placeholders `NullStore` / `EmptyPluginRegistry`;
   - a warning per `providers.<id>` whose id the registry does not know;
   - in-memory rate limiter, cache and session store unless injected.
5. On `ConfigError`, `bootOrExit()` prints the error to stderr with a
   pointer to `deploy/config/` and exits with code **78** (`EX_CONFIG`);
   any other failure exits with 1. Next waits for `register()` before
   serving, so an incomplete configuration never answers a request.

`/healthz` (`http/healthz.ts`) pings the store and answers 200
`{status:"ok", version, commit, uptime_seconds, store:{kind,status}}`, 503
`degraded` when the ping fails, 503 `unavailable` when the root cannot be
built. `version` and `commit` are frozen into the bundle by `next.config.ts`
(`NEXT_PUBLIC_GATEWAY_VERSION`, `NEXT_PUBLIC_COMMIT_SHA`; `dev` outside a
build).

## Configuration keys

Both sources map to the same tree; the **file wins over the environment**
key by key. The table below is `KEYS` in `sources.ts`; `(secret)` keys also
accept `<VAR>_FILE`.

| YAML path                       | Environment variable                   | Rule                                                                                                           |
| ------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `public_url`                    | `VAUBAAN_PUBLIC_URL`                   | **required**, https, no query; trailing slash stripped                                                         |
| `trusted_proxies`               | `VAUBAAN_TRUSTED_PROXIES`              | list of IPs / CIDR blocks; default none                                                                        |
| `store.path`                    | `VAUBAAN_STORE_PATH`                   | **required**                                                                                                   |
| `encryption.master_key`         | `VAUBAAN_MASTER_KEY` (secret)          | **required**, 32 bytes base64                                                                                  |
| `encryption.key_version`        | `VAUBAAN_MASTER_KEY_VERSION`           | integer >= 1, default 1                                                                                        |
| `encryption.previous_keys`      | `VAUBAAN_MASTER_KEY_PREVIOUS`          | `{version: key}` / `1=<b64>,2=<b64>`; not the current one                                                      |
| `idp.issuer`                    | `VAUBAAN_IDP_ISSUER`                   | https; block optional, all-or-nothing                                                                          |
| `idp.client_id`                 | `VAUBAAN_IDP_CLIENT_ID`                |                                                                                                                |
| `idp.client_secret`             | `VAUBAAN_IDP_CLIENT_SECRET` (secret)   |                                                                                                                |
| `idp.claims.{sub,email,groups}` | `VAUBAAN_IDP_CLAIM_{SUB,EMAIL,GROUPS}` | defaults `sub`, `email`, `groups`                                                                              |
| `idp.allowed_email_domains`     | `VAUBAAN_IDP_ALLOWED_EMAIL_DOMAINS`    | list, lower-cased; default any                                                                                 |
| `admin.group`                   | `VAUBAAN_ADMIN_GROUP`                  | **admin rule**: group and/or emails required                                                                   |
| `admin.emails`                  | `VAUBAAN_ADMIN_EMAILS`                 | list, lower-cased, must contain `@`                                                                            |
| `providers.<id>.<field>`        | `VAUBAAN_PROVIDER_<ID>_<FIELD>`        | fields `client_id`, `client_secret`_, `app_id`, `app_slug`, `private_key`_ (\* secret); `-` in id ↔ `_` in env |
| `bootstrap_token`               | `VAUBAAN_BOOTSTRAP_TOKEN` (secret)     | **required while `idp` is absent**, >= 32 chars                                                                |
| `telemetry.enabled`             | `VAUBAAN_TELEMETRY_ENABLED`            | default false                                                                                                  |
| `telemetry.collector_url`       | `VAUBAAN_TELEMETRY_COLLECTOR_URL`      | https; default `DEFAULT_TELEMETRY_COLLECTOR_URL`                                                               |
| `retention_days`                | `VAUBAAN_RETENTION_DAYS`               | integer >= 1, default 90                                                                                       |
| `requests.expiry`               | `VAUBAAN_REQUEST_EXPIRY`               | duration, default `24h`                                                                                        |
| `approvals.expiry`              | `VAUBAAN_APPROVAL_EXPIRY`              | duration, default `10m`                                                                                        |
| `log.level`                     | `VAUBAAN_LOG_LEVEL`                    | `debug` `info` `warn` `error`, default `info`                                                                  |

Not in the tree: `VAUBAAN_CONFIG_FILE` (path of the YAML; unset means
environment only; set but unreadable is an error), and the listener
variables `PORT` / `HOSTNAME` read by Next's standalone `server.js`.

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
(warning today, boot failure once the registry is wired in P1.2).

## Crypto at rest

`createEncryptor(config.encryption)` returns the `Encryptor` port:

- `encrypt(connectionId, plaintext)` → `{ keyVersion, blob }`, with
  `blob = 0x01 || nonce(24) || XChaCha20-Poly1305(plaintext)`;
- `decrypt(connectionId, { keyVersion, blob })` → plaintext.

The per-connection key is `BLAKE2b-256(key = master key of that version,
message = "vaubaan/connection-key/v1:" + connectionId)`; the connection id
is also the associated data, so a blob copied to another connection fails
to open (`CryptoError`, generic message, no oracle). `key_version` is the
store's business (a column next to the blob): on rotation the operator sets
a new `master_key` with `key_version: n+1` and keeps the old key under
`previous_keys`; blobs written under an older version still open, new blobs
carry the new version. A blob whose version has no key fails with a message
naming `encryption.previous_keys`.

`lib/crypto/index.ts` keeps the v4 `encryptProviderSecret` /
`decryptProviderSecret` signature for the UI and `/mcp` route that still
exist, reading `ENCRYPTION_MASTER_KEY` lazily. It is the only
`process.env` secret read outside `server/config` and disappears with the
v4 code in Phase 1.

## Logging

`createLogger({ level, redact })` writes one JSON object per line
(`time`, `level`, `msg`, bindings, fields) to stdout, errors to stderr. The
whole line goes through the redactor: `vbn_live_<prefix8>_<secret32>`
becomes `vbn_live_<prefix8>_[redacted]`, every configured secret (also in
its JSON-escaped form, for PEM keys) becomes `[redacted]`. `child()` adds
bindings. `silentLogger` is for tests.

## Ports and their single-process implementations

| Port             | Today (`compose/memory.ts`)                  | Hosted replacement                    |
| ---------------- | -------------------------------------------- | ------------------------------------- |
| `Store`          | `NullStore` placeholder → SQLite (P0.3)      | Postgres behind the same repositories |
| `PluginRegistry` | `EmptyPluginRegistry` → plugin-sdk (P0.2)    | same (static)                         |
| `RateLimiter`    | `MemoryRateLimiter` fixed window per key     | Redis `INCR` + `PEXPIRE`              |
| `CacheClient`    | `MemoryCache`, TTL, bounded (oldest evicted) | Redis                                 |
| `SessionStore`   | `MemorySessionStore`                         | store-backed rows or Redis            |

Features plug their factories through `RootDeps` (`openStore`,
`buildRegistry`, `rateLimiter`, `cache`, `sessions`); tests inject fakes
and call `resetRoot()` between cases.

## Tests

Co-located `*.test.ts` under `src/server/**` (config loader: named
failures, https rule, precedence, admin rule, secret references, provider
env parsing, key rotation; crypto: round trip, AD mismatch, tampering,
`key_version`; logging: redaction; compose: `getRoot()` memoisation,
`bootOrExit()` exit codes, in-memory ports; http: `/healthz` states) plus
the structural test `apps/gateway/tests/unit/structural/no-hardcoded-config.test.ts`
(no literal URL, secret or project ref in the v5 perimeter except
`telemetry-default.ts` and `deploy/config/*.example*`). The container
smoke test is `deploy/docker/smoke.sh`.
