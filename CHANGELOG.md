# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The public product name is **v2**; the repository's internal plan calls the
same work **v5** (see the pivot ADR). Tags are `v2.x.y`.

## [Unreleased]

### Added

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

### Changed

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

### Removed

- From `@vaubaan/gateway-core`: `RedisCacheClient` (Upstash),
  `buildCacheClient`, `SupabaseAuditWriter`, the `venv` secret store and the
  unused `@supabase/supabase-js`, `@upstash/redis`, `@vaubaan/plugin-github`
  dependencies. The v4 `McpGateway` orchestrator moved to
  `apps/gateway/src/lib/gateway/legacy-v4-gateway.ts` (venv tools removed)
  until P1.6 replaces `/mcp`.
- Supabase migrations and configuration (`supabase/`), the Supabase
  migrations workflow, `vercel.json`, the v4 operator `.env.example`, and
  the Supabase/Vercel-only scripts under `scripts/`. v5 ships as a single
  on-prem process with an embedded store.

[Unreleased]: https://github.com/sbw-vaubaan/vaubaan-gateway/compare/v4-final...HEAD
