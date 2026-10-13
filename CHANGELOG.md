# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The public product name is **v2**; the repository's internal plan calls the
same work **v5** (see the pivot ADR). Tags are `v2.x.y`.

## [Unreleased]

### Changed

- **A web session or a delegated token presented at `/mcp` is refused with
  `wrong-credential-kind`**; a token replaced by rotation is a 401 from the next call, and a
  revoked mission answers `mission-inactive` — the door re-reads the token and the mission
  on every call and only skips the argon2 computation.
- **Only a 401 from a provider counts as a rejected credential.** The gateway then
  refreshes and retries once; a rejected refresh turns the connection `expired` and the
  agent reads `connection-unavailable`. A 403 is reported as a failed call and leaves the
  connection alone.
- **The audit's argument hash is the approval fingerprint**: SHA-256 of the canonical JSON
  (64 hex characters) instead of v4's 16.
- **`/mcp` no longer answers CORS**, and refuses a browser `Origin` other than the
  instance's own.
- `/` redirects to `/missions` (or `/login`); the application is on zod 4. The image build now
  copies the dependencies npm nests under a workspace (`apps/gateway/node_modules`), which
  the build stage used to leave behind.

### Removed

- **The v4 application.** The organization / project / token pages, the marketing site,
  `/api/v1/**`, `/api/integrations/**`, the Supabase-backed gateway and its libraries, the
  v4 Playwright specs, the v4 adapters and `classifyXxxV4` wrappers of the ten plugins,
  `legacy-v4.ts` in `@vaubaan/shared`, the bindings bridge and the scope-injection module of
  `@vaubaan/policy-engine`, and the dependencies only they used (`@supabase/ssr`,
  `@supabase/supabase-js`, `@modelcontextprotocol/sdk` v1, `mermaid`). The classifier test
  suites were ported to the plugins' v5 entry points.

### Security

- **App installations are bound to the person who performs them (P1.4b).** Connecting a
  provider through an installed app (GitHub) accepted the `installation_id` of the callback
  once the `state` was valid: a signed-in user who knew the id of another installation of the
  company's app could connect it and issue missions on repositories they had no access to.
  The host now requires the provider's user authorization during installation: it exchanges
  the callback's `code` for a user token with the app's OAuth client, lists the installations
  that user can reach and connects the installation only when it is among them; the user
  token is discarded immediately and never stored or logged. A refused attempt stores nothing
  and is audited (`connection-refused`, with the reason and the claimed installation id).
  **Operators must update their GitHub App**: enable "Request user authorization (OAuth)
  during installation", register the gateway callback as the App's callback URL, generate a
  client secret, and add `client_id` / `client_secret` to the provider app (Administration →
  Provider apps, or `providers.github.*`); until then GitHub is reported `incomplete` and
  cannot be connected or used.

### Added

- **Cutover acceptance scenario and its automated smoke (P1.9).** `docs/tests/e2e-tests.md`
  states the manual scenario that gates the cutover from v4 — connect every provider in use,
  one mission per code project, a day of Claude Code work with no unexpected refusal — with
  its refusal log and an outcome still to be filled in by the instance owner;
  `docs/handbook/cutover-from-v4.md` is the checklist to tick, with what to prepare, the four
  live checks and the decisions to confirm. A Playwright smoke walks the same path on an
  ephemeral instance (simulated IdP, mocked GitHub, an MCP client on `/mcp`: connect, issue,
  call, exhaust, claim, replay, audit) and runs with the other browser tests in a new CI job,
  `e2e`.
- **The execution MCP door (P1.6).** `POST /mcp` now serves v5: an agent presents its
  mission token, `tools/list` shows the tools of the providers its mission holds a
  connection and an accepted risk for, and `tools/call` goes through the whole decision —
  mission state, resource selection, `risks_touched ⊆ accepted_risks`, budget / rate / gate,
  then the provider with a credential decrypted for that call only — and leaves one audit
  entry, allowed or refused. A refusal reaches the client whole: JSON-RPC error `-32603`
  whose `data` carries the code, its fields (claim URL, approval URL, allowed resources…)
  and the hint. `GET /mcp/catalog` returns the tool surface, what the mission can call, its
  resources with their environment labels and what is left of each risk's quota. Agents may
  label their calls (`X-Vaubaan-Agent` header, or `_meta.agent` per call) for the audit.
  The door speaks MCP through `@modelcontextprotocol/server` 2.3 (stateless Streamable
  HTTP; 2025-era and 2026-07-28 clients), answers plain JSON, and is rate limited per
  mission (`mcp.rate_limit_per_minute`, default 600).
- **Fewer round trips to GitHub.** The installation token the gateway mints for a call is
  reused for up to 50 minutes per connection and repository, and dropped as soon as GitHub
  rejects it or the connection is revoked. Plugins get the cache through
  `ExecuteContext.credentialCache`.
- **Claims and the request inbox (P1.7).** The URL a `budget-exhausted` refusal carries,
  `<public_url>/r/<id>`, now answers: it asks for a sign-in, lets only the mission's creator
  through (anyone else — including an owner of the same connection — gets a 403 that says
  only "This request is addressed to its creator"), refuses a mission token or any other
  bearer, and is rate limited per client address. The creator sees the mission, the risk
  with its quota and consumption, the other risks, the last session events, and four
  actions with their consequence: reset the period, give back up to what was consumed on the
  risk for the current period, extend the expiry, or refuse. The decision is recorded as a
  session event and an admin audit entry; the token does not change and the agent replays
  its call. "Requests" in the application bar lists what awaits you, with a count.
  Unanswered requests expire after `requests.expiry` (default 24 h). Approval requests are
  listed but cannot be decided yet.

- **Audit search, mission session page, retention (P1.8).** `/audit` searches the audit by
  mission, user, connection, tool, decision and period, newest first, with keyset paging. A
  user sees the entries about the missions they created and the connections they or their
  groups own; an operator also sees every administrative entry; nobody sees arguments, only
  their hash. `/missions/<id>/session` (linked from the mission page) shows the counters per
  risk and per period with what is left, the gate of each risk, the open requests as links,
  the agent labels seen and the event timeline. Audit entries older than `retention_days`
  (default 90) are purged at boot and then hourly. Refreshing a connection's discovery and
  editing a resource now leave an administrative entry (`resources-discovered`,
  `resource-edited` with the fields before and after), as does the revocation of the
  bootstrap token by the first operator sign-in; a structural test enumerates the service
  methods and fails when a mutation writes none.
- **Declarative installation verification in the plugin SDK (P1.4b).** The `app-install`
  `CredentialSpec` accepts an optional `userVerification` block (authorization-code
  parameter, token endpoint, installations endpoint, response shape, pagination) that the
  host runs generically; `definePlugin` validates it and requires `client_id` /
  `client_secret` among the app settings. The client secret is no longer handed to any plugin,
  whatever its credential kind. A plugin whose `app-install` spec has no `userVerification`
  cannot be connected unless an operator turns on "accept unverified installations" for that
  provider app (off by default, shown with a warning, audited).
- **Missions: authority, issuance, tokens, bootstrap kit (P1.5).** A connection owner issues a
  mission from `/missions/new` on one page: name, connections and their resources (all selected
  by default, hidden ones left out, stale ones refused), one preset per connection from the
  plugin's catalog, a three-line summary (can / cannot / quantities), the per-risk detail folded
  (quota, rate limit, gate; "select all" yields an enumerated list), period and nullable expiry.
  A mission can also start from a duplicate or from an agent's pasted JSON proposal.
  `AuthorityService` gives the owner the provider's full catalog as explicit ids;
  `MissionService.preview()` says what passes, what exceeds the authority (with the uncovered
  list), which env-qualified entries no selected resource can resolve, and `issue()` refuses any
  accepted risk without a budget. The token (`vbn_live_`, argon2id, prefix lookup) is revealed
  once with the bootstrap kit: env var, `.mcp.json` by reference to `${VAUBAAN_MISSION_TOKEN}`,
  agent instructions with what to do on each refusal, and a `curl … tools/list` check. Rotate and
  revoke from the mission page. `/agent-bootstrap.md` is rewritten for mission tokens. Browser
  test `npm run test:e2e:v5` against an ephemeral instance with a simulated IdP.
- **Connections, resources and provider apps (P1.4).** A signed-in user connects a provider
  from `/connections` through the app their company registered: one generic driver runs the
  four `CredentialSpec` kinds — `oauth2` (authorization code with PKCE, RFC 8707 resource
  indicator, a single-use `state` kept server-side and bound to the user, return URL limited
  to `public_url`), `app-install` (installation redirect and callback), `api-key` (the
  declared fields, checked by a first discovery so a rejected key stores nothing and shows the
  provider's own error) and `ssh-key` (an ed25519 pair generated by the instance, private key
  sealed, public key shown). Credentials are encrypted at rest with the connection id as
  associated data; a connection is `active`, `expired` or `revoked` (terminal, credential
  erased). OAuth tokens are refreshed by the host from the plugin's spec — client
  authentication method, refresh-token rotation, persistence — so a plugin never sees the
  client secret; a rejected refresh turns the connection `expired`, an unreachable provider
  does not. Resources are discovered by the plugin at connect time and on "Refresh
  discovery": the owner renames them, labels their environment, hides them and edits list
  settings (Resend recipient zones); those edits survive every re-discovery, a label the
  plugin sets itself (Stripe `test` / `live`) is read-only, and a resource that vanished
  upstream is marked stale instead of being deleted. Experimental plugins (Gmail) carry a
  badge. Operators register each provider's app in Administration → Provider apps (fields
  derived from the plugin, secrets encrypted in the store) or in the mounted configuration,
  which wins and makes the page read-only for that provider. Connect attempts are rate-limited
  per user; connections, reconnections, revocations and app changes are audited. The instance
  now boots with the ten shipped plugins registered. Schema version 4
  (`0004_connection_resource_curation.sql`).
- **Cloudflare DNS plugin on the v5 SDK (P1.2g).** `@vaubaan/plugin-cloudflare-dns` implements
  `definePlugin()`: one `api-key` credential (a zone-scoped Cloudflare API token; the Global API
  Key form is refused), `discoverResources` listing every zone the token reaches as one resource
  per zone, record writes layered into `record-write` / `critical-record-write` (apex, wildcard,
  MX, NS) / `record-delete` with a pre-flight read on `update_record`, `list_zones` filtered to
  the mission's zones, presets `read-only` / `dns-operator` / `zone-admin` (approval on deletions,
  critical records, imports, zone settings and DNSSEC), and the `zone-delete` pattern narrowed to
  the zone itself (it used to match every write under a zone); the TypeScript catalog twin and its
  sync test are gone. v4 exports stay `@deprecated` until P1.6.
- **Plugin SDK fixes from the first migrations (P1.2-SDK).**
  `catalogPathNextTo(import.meta.url)` locates a plugin's `risk-catalog.yaml`
  as a filesystem path that works in vitest, `next dev`, `next build`
  (Turbopack rewrites `new URL(…, import.meta.url)` into a static asset) and
  the standalone server; `apps/gateway/next.config.ts` traces
  `plugins/*/src/**/*.yaml` into `.next/standalone` and derives
  `transpilePackages` from the plugins folder; an integration test checks the
  catalogs are present after a build. `ProviderPlugin.envOf?(slice,
resources)` lets a plugin derive the environment carried by the call
  (Vercel's `env[prod]` segment, GitHub's branch), with
  `envFromSliceSegment()` for the segment case and the policy engine's
  composed `envResolverFor(resources, envOf)` (plugin first, resource label
  next, unqualified last). `RiskEntry.fallback: true` marks the catalog's
  catch-all; the loader requires exactly one fallback per catalog and warns
  when a preset includes it; `assertCatalogCoverage` reports `fallbackHits`.
  ADRs `plugin-catalog-path-and-standalone-tracing`,
  `fallback-risk-only-when-uncategorized`.

- **Upstash Redis plugin on the v5 SDK (P1.2h).** `@vaubaan/plugin-upstash-redis` 1.0.0 is a `definePlugin()` descriptor: `api-key` credential (account email + Management API key, replacing the v4 `email:api_key` concatenation), `discoverResources` over the account's databases (one resource per database, capped at 200), classifier re-keyed to mission resources with keys containing `:` no longer embedded in slices (v4 produced unparseable slices), every write risk env-scoped on the owner's database label, three presets (`read-only`, `developer`, `operator` with approval on FLUSH outside development, database deletion and rename), Management API answers redacted of REST tokens, catalog v2 loaded from YAML (TS twin and sync test removed). Legacy v4 exports kept `@deprecated` until P1.6. Handbook `providers/upstash-redis` rewritten in English.
- **Budget, session and decision core (P1.3).** `apps/gateway/src/server/budget/`:
  the pure `decide(policy, counters, rate windows, period, fingerprint, approvals?)`
  → allow (N risks → N decrements) or `budget-exhausted` / `rate-limited` /
  `approval-required` (whole-call refusal, dimension-major order); period
  arithmetic with rollover computed on read (`currentPeriod`, `periodIndex`,
  one-off = single open-ended period); the canonical argument fingerprint
  (`sha256` of key-sorted JSON) shared by approvals and requests; mission state
  derivation (`active | exhausted per risk | expired | orphaned | revoked`);
  `SessionService.recordCall` running the decision inside the store's
  `BEGIN IMMEDIATE` primitive with session get-or-create, approval lookup and
  consumption, request drop (reused on replay) and the call event; the
  pipeline's `BudgetStage` adapter; the reusable structural check
  `countersAgreeWithAudit` (`SUM(session_counters) == COUNT(audit allowed)`).
  `apps/gateway/src/server/rate-limit/`: in-memory `SlidingWindowRateLimiter`
  (`peek`/`push` for the budget, `take` for the composition root's port;
  single-process only, Redis replacement documented). The store's
  `DecideContext` gains `findApproval` and `findOpenRequest`. The credit of an
  allowed call is not refunded when the upstream call fails. ADR
  `atomic-budget-accounting`, handbook `budget-and-sessions`, 69 tests
  including N=50 concurrent calls on the last credit.

- **OIDC sign-in, web session, bootstrap token, admin rule (P1.1).** Any
  OpenID Connect provider signs humans in: generic relying party over
  `openid-client` 6.8 (discovery, PKCE S256, state and nonce, userinfo merged
  under the ID token), claim mapping `{sub, email, groups}` from the
  configuration with groups as array, delimited string or absent, `users`
  upsert and IdP-sourced memberships replaced on every sign-in (local groups
  untouched), optional allowed email domains. Server-side sessions in the
  embedded store (`web_sessions`, schema v3) behind the `SessionStore` port
  with `HttpOnly; Secure; SameSite=Lax` cookies, 8-hour absolute TTL and an
  origin check on every mutation. `/login` is the new default entry (the v4
  Supabase login is gone), with `/auth/login`, `/auth/callback`,
  `POST /logout`. Administration: `/admin/bootstrap` accepts only the
  configured bootstrap token while no IdP is set, `/admin/identity-provider`
  stores the IdP (client secret encrypted in `instance_config`, audited) and
  offers a "Test login"; the bootstrap token is revoked by the first operator
  sign-in, after which the operator is whoever matches the admin rule,
  recomputed from the user's current groups on every request. ADR
  `oidc-relying-party-and-web-session`, handbook `authentication`.
- **SSH plugin on the v5 SDK (P1.2i).** `@vaubaan/plugin-ssh` 1.0.0 is a
  `definePlugin()` descriptor: `ssh-key` credential (ed25519 pair generated by
  the instance, host, port, user and the **host key fingerprint pinned and
  verified on every connection**), `discoverResources` returning the host as
  the connection's resource, `ssh__exec` classified by a quote-aware command
  splitter with four new class risks (`exec-destructive`, `exec-package-install`,
  `exec-service-control`, `exec-sudo`) next to the v4 ids, presets `read-only` /
  `developer` / `operator` (approval on destructive classes outside dev and on
  every prod write), catalog converted to the v5 YAML shape and loaded at boot
  (TS twin and its lint deleted). The v4 bash parser and runner moved from
  `apps/gateway/src/lib/bash` into `plugins/ssh/src/bash` (shims left for the
  v4 routes). Handbook `providers/ssh` written in English; `bash-provider` and
  the SSH half of `railway-ssh` marked legacy.
- **Resend plugin on the v5 SDK (P1.2f).** `@vaubaan/plugin-resend` implements
  `definePlugin()`: one `api-key` credential (`api_key`), one resource per
  sending domain (ref = name, recipient-zone lists in its metadata) and per
  segment (Resend's renamed audiences), sends rooted at the `from` domain and
  refused outside the mission, broadcasts verified upstream against the named
  segment, `[*]`-precise catalog v2 with `read-audiences` / `audience-write`
  deprecated in favour of `read-segments` / `segment-write`, two membership
  tools added, presets `read-only` / `developer` / `marketing-operator` /
  `domain-admin` (approval on bulk sends, segment deletion and domain
  mutations); the TypeScript catalog twin and its sync test are gone. v4
  exports stay `@deprecated` until P1.6.
- **Stripe plugin on the v5 SDK (P1.2e).** `@vaubaan/plugin-stripe` implements
  `definePlugin()`: one `api-key` credential with optional test and live keys,
  one resource per mode (`acct_…/test`, `acct_…/live`) so `stripe[live].*`
  risks resolve, every catalog risk env-scoped on `[test, live]`, new
  `create_payout` and `delete_customer` tools behind their own irreversible
  risks, presets `read-only` / `test-mode-developer` / `finance-operator`
  (approval on live money-out and irreversible entries); the TypeScript
  catalog twin and its sync test are gone. v4 exports stay `@deprecated` until P1.6.
- **Gmail plugin on the v5 SDK (P1.2j, experimental).** `@vaubaan/plugin-gmail` 0.1.0 is a `definePlugin()` descriptor flagged `experimental: true` : classifier-only (no tool exposed, `execute` answers a structured `not_implemented` error), `oauth2` credential against Google (PKCE, `client_secret_post`, scopes `gmail.readonly` + `gmail.compose`, offline consent), `discoverResources` returning the authenticated mailbox as the single resource, classifier re-keyed to the mission's mailbox resource (two mailboxes denied as ambiguous), catalog v2 in English with a new `gmail.draft-write` risk and a wider `read-mailbox` (the SDK kit found slices only the fallback matched), presets `read-only` and `developer` (bulk entries under approval), `acceptable_in_envs: []` dropped (not expressible in v5) ; TypeScript catalog twin and sync test deleted, v4 exports kept `@deprecated` until P1.6.
- **Supabase plugin on the v5 SDK (P1.2c).** `@vaubaan/plugin-supabase` is a `definePlugin()` descriptor : `oauth2` credential against the Management API with refresh (the v4 connect/callback routes' logic moved into the spec), `discoverResources` over the account's organizations and projects, env-scoped write risks, three presets (`read-only-analyst`, `staging-developer`, `migration-operator`), `execute_sql` enforced read-only through the Management API read-only query endpoint, the `*_to_venv` tools removed, the TypeScript catalog twin and its sync test deleted ; v4 exports kept as `@deprecated` shims until P1.6.
- **GitHub plugin on the v5 SDK (P1.2a).** `@vaubaan/plugin-github` 1.0.0: `definePlugin()` descriptor, `app-install` credential (company GitHub App id + private key, per-call installation token scoped to the repository), `discoverResources` over the installation's repositories (paged), three presets in the catalog (`read-only`, `developer`, `release-manager`; approval gates on protected-branch merges, release deletion, workflow-file writes and push-token minting), TypeScript catalog twin and sync test deleted, PAT path dropped; legacy v4 exports kept `@deprecated` until P1.6.
- **Railway plugin on the v5 SDK (P1.2d).** `@vaubaan/plugin-railway`
  exports `railwayPlugin` (`definePlugin`): `oauth2` credential with PKCE,
  RFC 8707 resource indicator and hot-path refresh (`railwayNeedsRefresh`,
  `refreshRailwayCredential`); `discoverResources` lists projects with
  their environments; the classifier runs on `Resource[]` and resolves
  `accept-deploy` through the discovered environments; the YAML catalog is
  loaded by the SDK (`catalog_version: 2`, English labels, `read-variables`
  env-scoped) with presets `read-only`, `developer`, `operator`; the
  `risk-catalog.ts` twin is gone. Legacy v4 exports stay `@deprecated`
  until P1.6. Handbook `docs/handbook/providers/railway.md`.
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

- **P1.2-align: the ten plugins, the SDK and `v5` on one consistent surface.**
  The `ssh` (P1.2i) and `resend` (P1.2f) branches are merged; the five tests
  written under the old fallback co-fire rule are rewritten, and the kit's
  `assertCatalogCoverage` leaves the fallback out of `risksUntouched` (it is
  reachable by design only through uncategorized writes; `fallbackHits`
  still reports when it fires). SDK: `definePlugin` no longer requires
  `refresh()` for `refreshable: true` — the host performs the standard
  `refresh_token` grant from `tokenUrl`, `clientAuthMethod` and
  `resourceIndicator`, `refresh?` stays as an override for non-standard
  flows; gmail's rejecting placeholder and the pure standard refreshes of
  supabase and railway are deleted. `ProviderPlugin.experimental?: boolean`
  (gmail sets it; `labels()` carries it). All ten plugins load their catalog
  with `catalogPathNextTo(import.meta.url)`. `gateway-core` widens its
  `Classifier` to `Pick<ProviderPlugin, 'classify' | 'envOf'>` and defaults
  the resolver to `envResolverFor(resources, adapter.envOf)`; vercel declares
  `envOf`. Every `risk-catalog.yaml` flags its catch-all `fallback: true`;
  the loader warns when an entry is recognised by convention only and the
  kit fails on it; a preset entry on the fallback is now a loader error.
  Stripe's presets drop `stripe[<mode>].uncategorized-write`, which exposed
  the `payment-intent.W` slice of `create_subscription` reaching only the
  fallback: `stripe.subscription-create` matches it since catalog v3
  (`@vaubaan/plugin-stripe` 0.2.0). Docs: `integration-tests.md` plugin
  section rewritten from the test files (1931 tests after the rebase on P1.1 and P1.3), English index of the
  ten plugins under `docs/handbook/providers/README.md`, handbook
  `plugin-sdk`, ADRs `plugin-contract-and-credential-spec` and
  `fallback-risk-only-when-uncategorized` amended with dated notes.
- **The fallback risk no longer co-fires with a categorized write.**
  `risksTouchedBy` includes `<provider>.uncategorized-write` only when no
  other catalog entry matches the slice; a write covered by a dedicated
  entry touches that entry alone, a write covered by none still touches the
  fallback, and a slice covered by nothing is still refused. Missions built
  from presets without the fallback can now perform the writes the preset
  names; the fallback's appearance in an audit log again means a catalog
  entry is missing. Tests asserting the co-fire were inverted (policy engine,
  gateway-core, template, ssh, railway, supabase, cloudflare-dns catalog
  tests). ADR `fallback-risk-only-when-uncategorized`.

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

- **P0 cycle-end pass (drift, clean code, consistency).** Doc drift fixed
  across the v5 handbooks, test plans, workflow and deploy README (all in
  English, `last_synced: 2026-10-13`). Code: the slice glob `*` expands over
  the parser's identifier class (`release-*` matches `release-1.2`; it
  failed open to the fallback risk) and glob × glob intersection is exact
  for single-star globs; an `unowned` connection keeps serving its missions
  (only `expired`/`revoked` are `connection-unavailable`); a
  `risk-not-accepted` audit entry records `risks_touched`;
  `isAcceptableInEnv` is the single `acceptable_in_envs` rule across the
  engine, the SDK and the store; one `CacheClient` (gateway-core's) instead
  of two with different TTL units; migration `0002` makes the `audit_risks`
  delete guard compare with the purge cutoff and the runner refuses a
  database newer than the image; the store imports the shared closed sets
  instead of twins and its check-then-act writes are atomic; config errors
  never echo a `VAUBAAN_MASTER_KEY_PREVIOUS` entry and refuse unsupported
  `${...}` syntax; `next.config.ts` derives `transpilePackages` from the
  workspace dependencies and drops the build-time `ALLOWED_ORIGINS`;
  `.dockerignore` excludes nested `.env*` files, the smoke test asserts exit
  78, reads the logs once (no `pipefail` false pass) and checks no env file
  shipped; the compose quick start works as documented (example YAML reads
  `${VAUBAAN_MASTER_KEY}`); `deploy/config/gateway.yaml` is gitignored; the
  legacy Playwright specs read their credentials from the environment.

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
