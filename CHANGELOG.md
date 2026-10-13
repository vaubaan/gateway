# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The public product name is **v2**; the repository's internal plan calls the
same work **v5** (see the pivot ADR). Tags are `v2.x.y`.

## [Unreleased]

### Added

- **Stripe plugin on the v5 SDK (P1.2e).** `@vaubaan/plugin-stripe` implements
  `definePlugin()`: one `api-key` credential with optional test and live keys,
  one resource per mode (`acct_…/test`, `acct_…/live`) so `stripe[live].*`
  risks resolve, every catalog risk env-scoped on `[test, live]`, new
  `create_payout` and `delete_customer` tools behind their own irreversible
  risks, presets `read-only` / `test-mode-developer` / `finance-operator`
  (approval on live money-out and irreversible entries); the TypeScript
  catalog twin and its sync test are gone. v4 exports stay `@deprecated` until P1.6.
- **Supabase plugin on the v5 SDK (P1.2c).** `@vaubaan/plugin-supabase` is a `definePlugin()` descriptor : `oauth2` credential against the Management API with refresh (the v4 connect/callback routes' logic moved into the spec), `discoverResources` over the account's organizations and projects, env-scoped write risks, three presets (`read-only-analyst`, `staging-developer`, `migration-operator`), `execute_sql` enforced read-only through the Management API read-only query endpoint, the `*_to_venv` tools removed, the TypeScript catalog twin and its sync test deleted ; v4 exports kept as `@deprecated` shims until P1.6.
- **Instance configuration, crypto, composition root and Docker image
  (P0.4).** The gateway starts from `VAUBAAN_*` environment variables
  and/or a mounted YAML file (`VAUBAAN_CONFIG_FILE`, file wins key by
  key; `${NAME}` / `${file:/path}` secret references, `*_FILE` variables)
  validated into one typed `InstanceConfig`; any missing or invalid key
  stops the process with exit code 78 and a message naming every key and
  its variable. Credentials at rest use XChaCha20-Poly1305 with a key
  derived per connection and a `key_version` for rotation
  (`npm run gen-master-key`). The composition root is built once per
  process (`getRoot()`), `GET /healthz` answers, logs are JSON lines with
  token-prefix and secret redaction. `deploy/docker/Dockerfile`
  (debian-slim, non-root, `/data` volume, HEALTHCHECK), `deploy/compose.yaml`
  with a Caddy TLS proxy, documented `deploy/config/gateway.example.yaml`
  and `.env.example`, and a CI job that builds the image and runs the
  container smoke test. ADR `docker-image-and-config-format`.
- **Vercel plugin on the v5 SDK (P1.2b).** `@vaubaan/plugin-vercel` 1.0.0 is a
  `definePlugin()` descriptor: `api-key` credential (access token + team id),
  resource discovery (team projects, paged), classifier re-keyed to mission
  resources, three presets (`read-only`, `developer`, `operator` with
  approval on production-affecting entries), catalog v2 loaded from YAML (TS
  twin and sync test removed), venv tool removed. Legacy v4 exports kept
  `@deprecated` until P1.6. Handbook `providers/vercel` rewritten in English.
- **Plugin SDK (P0.2).** `@vaubaan/plugin-sdk`: the `ProviderPlugin`
  contract and `definePlugin()`, the `CredentialSpec` union (api-key,
  oauth2, app-install, ssh-key), the YAML catalog loader with presets
  (at least one per plugin, every entry an explicit risk of the same
  catalog), the `PluginRegistry` every provider list derives from, and the
  test kit (`mockFetch`, `assertCatalogCoverage`, `assertNoWildcard`,
  `assertPresetsValid`). `plugins/_template` is the scaffold. ADR
  `plugin-contract-and-credential-spec`.
- `@vaubaan/shared`: v5 domain types (connections, resources, shares,
  missions, sessions, requests, approvals, delegations), the eight
  `RefusalCode` values, `parseRiskId` / `formatRiskId`.
- **Embedded store and schema v1 (P0.3).** SQLite via `better-sqlite3`
  under `apps/gateway/src/server/store/`, forward-only migrations in
  `apps/gateway/migrations/` applied at boot, `STRICT` tables, WAL,
  repository interfaces with SQLite implementations (users, groups,
  connections and resources, shares, missions with policy and tokens,
  sessions with the atomic `decideAndDecrement` primitive, requests,
  approvals, delegations, audit, instance config), an append-only audit
  enforced by triggers with a retention purge path and a `SqliteAuditWriter`
  implementing `@vaubaan/gateway-core`'s `AuditWriter`, encrypted blobs
  behind the crypto module's `Encryptor` port, a `:memory:` mode for tests,
  and a `Store` that satisfies the composition root's store port. ADR
  `embedded-store-sqlite-and-migrations`, handbook `store`.

### Changed

- **Next.js 16 (P0.6).** `apps/gateway` runs on Next.js 16.4.0 with React
  19.3.0 (from 15.5.18 / 19.1.1); `next build` and `next dev` use Turbopack.
  The process shape is unchanged (standalone `server.js`, route handlers,
  `instrumentation.ts`, `globalThis` root). `next.config.ts` now traces the
  runtime files of `better-sqlite3` (not only its `.node` binary) so the
  driver loads inside the image before the store is wired into the root;
  `agentRules: false` keeps `next dev` from writing an `AGENTS.md` next to
  the app. The container smoke test also loads `better-sqlite3`, and a new
  integration test checks the standalone output after a build. No feature
  work; the same 1655 tests pass.
- **`@vaubaan/gateway-core` speaks v5 (P0.5).** Eight typed structured
  refusals (`risk-not-accepted`, `budget-exhausted`, `approval-required`,
  `resource-not-in-mission`, `rate-limited`, `connection-unavailable`,
  `mission-inactive`, `wrong-credential-kind`), each with its spec fields and
  an agent-readable `hint`, mapped to JSON-RPC `-32603` with the refusal in
  `data`; v5 `AuditEntry` (call and administrative entries) behind the stable
  `AuditWriter.write(entry)` contract; `MissionContext`; door check and
  `DoorAuthenticator`; `CallPipeline` skeleton with stage interfaces for the
  budget (P1.3), resources, plugins and door (P1.6). `MemoryCacheClient` is
  bounded and marked single-process only. The decision core
  (`risks_touched ⊆ accepted_risks`) and `hashArguments` (sha256/16) are
  unchanged. Handbook: `docs/handbook/gateway-core.md`.
- **Repository reshaped for v5 (P0.1).** `packages/web` is now
  `apps/gateway` (`@vaubaan/gateway-app`), `packages/mcp-gateway` is
  `packages/gateway-core` (`@vaubaan/gateway-core`) and every provider moved
  from `packages/providers/<p>` to `plugins/<p>` (`@vaubaan/plugin-<p>`).
  npm workspaces are `apps/*`, `packages/*`, `plugins/*`. No behaviour
  change; the same 1301 tests pass.
- Licence changed from proprietary to **Apache-2.0**; package version set to
  `2.0.0-alpha.0`.
- Root OSS files added: `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `SECURITY.md`, issue templates, pull request template.
- `README.md` replaced by a short English stub while v5 is under
  construction; the last v4 SaaS release is tag `v4-final`.
- v4 documents written for the SaaS are marked `status: legacy` (ADRs and
  handbooks in place, wholesale-replaced specs and handbooks moved to
  `docs/**/legacy/`).

- `@vaubaan/policy-engine` resolves environments through an `EnvResolver`
  over v5 resources; v4 scope injection is quarantined behind a flag that
  defaults to off.
- **P0 reconciliation (P0.R).** `@vaubaan/shared` is the single source of
  truth for the domain types: `@vaubaan/gateway-core` re-exports
  `RefusalCode`, the connection and mission statuses, `Gate`, `Budget`,
  `RateLimit`, `Period`, `Principal`, `MissionPolicyEntry` and
  `acceptedRisksOf` instead of defining twins, and builds `MissionContext`
  from projections of the shared `Mission`, `Connection`,
  `ConnectionResource` and `Session`. The three kinds of bearer of spec §6
  are `BearerKind` (the plugin SDK's `CredentialKind` keeps its meaning:
  how a connection authenticates). `AuditDecision` says `allowed` |
  `refused` as the spec does. `RiskDecision` (denied) carries
  `code: RefusalCode`; the decision core takes `Resource[]` and an
  `EnvResolver` (default `resourceEnvResolver`) and a `Classifier` that is
  the `classify` half of `ProviderPlugin`; the v4 `ProviderBinding` inputs
  and `V4*` aliases are gone from gateway-core.
- **The composition root boots on the real store and registry.** The root
  opens the embedded SQLite store at `store.path` with the encryptor it
  built and a `RegistryCatalogIndex` over the plugin registry (empty until
  P1.2), runs the migrations at boot, and fails fast naming `store.path`
  when the database cannot be opened. A `providers.<id>` block that names
  no registered plugin is a warning while the registry is empty and a
  configuration error (exit 78) once plugins are registered. `NullStore`
  and `EmptyPluginRegistry` are gone; tests use the `:memory:` store.

### Removed

- From `@vaubaan/gateway-core`: `RedisCacheClient` (Upstash),
  `buildCacheClient`, `SupabaseAuditWriter`, the `venv` secret store and the
  unused `@supabase/supabase-js`, `@upstash/redis`, `@vaubaan/plugin-github`
  dependencies. The v4 `McpGateway` orchestrator moved to
  `apps/gateway/src/lib/gateway/legacy-v4-gateway.ts` (venv tools removed)
  until P1.6 replaces `/mcp`.
- From `@vaubaan/shared`: the escalation channel and token-context payload
  types, the deprecated token aliases, the unused `zod` dependency and the
  broken `./capability` export. v4 row types are kept, deprecated, in
  `legacy-v4.ts` until the plugins migrate.

- Supabase migrations and configuration (`supabase/`), the Supabase
  migrations workflow, `vercel.json`, the v4 operator `.env.example`, and
  the Supabase/Vercel-only scripts under `scripts/`. v5 ships as a single
  on-prem process with an embedded store.

[Unreleased]: https://github.com/sbw-vaubaan/vaubaan-gateway/compare/v4-final...HEAD
