# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The public product name is **v2**; the repository's internal plan calls the
same work **v5** (see the pivot ADR). Tags are `v2.x.y`.

## [Unreleased]

### Added

- **Mission members and per-holder tokens: every call says who made it.** A mission now has
  one or more tokens, each with one holder. The creator adds colleagues as **members** (any
  active user of the instance, picked by email); each signs in, finds the mission under
  "Shared with me" and **generates their own token**, shown once with the bootstrap kit —
  the creator never sees it. For a CI runner or a shared machine the creator creates a
  **named token**. Every token shares the mission's resources, policy and **one budget**:
  adding a member or a token adds no quota. A member uses the mission as it is — they
  cannot change it, add members or answer its requests, which still go to the creator
  alone — and rotates or revokes their own token; the creator can revoke any token and
  remove a member (their token stops with them). The mission page has a "Members and
  tokens" section with holder, kind, creation and last use of each token; the session page
  a "Calls per token holder" table (not a budget) and a holder filter on the timeline; the
  Audit page a "Token holder" column and filter. `GET /mcp/catalog` tells an agent whose
  token it holds (`token.holder`) and who created the mission.
- **A token that stops says why.** A mission token that was rotated, revoked on its own,
  or whose member was removed from the mission or deactivated on the instance is refused
  with HTTP 401 and `error.data.reason` (`token-rotated`, `token-revoked`,
  `holder-removed`, `holder-deactivated`) at the very next call, while the mission keeps
  serving its other holders. The eight structured refusals are unchanged; the bootstrap
  kit and `/agent-bootstrap.md` say what each reason means.
- **A readable provider reference.** A provider page is now a short header and four tabs
  instead of one long column of identical cards: **Presets** first, side by side as a table
  (one column per preset, one row per risk, each cell the quota, rate limit and gate) so the
  difference between two presets is read along a row; **Risks** as compact rows grouped into
  reads, writes and irreversible writes — fifteen fit in about a screen and a half — that
  unfold for the patterns and the notes; **Data model** as an outline; **Tools** as a dense
  table. A provider whose model has several planes (Supabase: db, storage, auth, functions)
  gets a plane control that narrows every tab at once. `#risk-<id>` and `#preset-<id>` links
  open the right tab and plane.
- **Colour says what kind of thing a name is.** Risks, presets, tools, data-model planes,
  resources, connections, missions, members and tokens each have one colour and one glyph,
  the same on every page — on the provider reference, a mission, the audit, a session, a request — so
  a risk id is told from a tool name before it is read. Severity, gates and statuses keep
  their own marks. "What the colours mean" is in the help of the provider pages.
- **Help on demand.** Explanatory text is one line with a "More" button — on the provider
  pages, mission creation, the Custom editor and the Share dialog — closed by default and
  remembered per browser.

- **A provider reference inside the interface.** "Providers" in the navigation lists the
  plugins of the instance; each has a page generated from the plugin itself: what it
  connects to in plain words, its data model as a tree, every risk a mission can accept —
  its label, why it is a risk, its six-axis profile as readable badges with a legend,
  whether it is accepted once or per environment, what it matches —, every preset with
  all it contains (quota, rate limit, gate) and what it leaves out, and the tools. Every
  risk id shown on a mission, a request, a share or a connection links to its entry.
- **Mission creation: Preset or Custom, per connection.** A preset is now an explicit choice
  that says what it means on the page: what it allows without asking, what waits for your
  approval, what it leaves out, with the quota and the rate limit of each risk. **Custom**
  opens the full editor in place: every risk you hold, grouped into reads, writes and
  irreversible writes, each with its explanation, a checkbox, a quota, a rate limit and a
  gate; "Start from preset…" pre-fills it, a search box filters a long catalog, and what you
  cannot accept is listed with the reason. Switching to Custom keeps the preset's values;
  switching back after an edit asks first. What a mission stores is unchanged: the explicit
  list of risks with their budgets, never a preset.
- **Plugins: `summary` and `tokenHandouts`.** A plugin may declare a short plain-words
  paragraph (what one connection is, what one resource is, where the environment comes
  from), shown on its reference page, and the tools whose purpose is to hand the agent a
  short-lived provider token, with the risks that gate them: the reference marks those tools
  and risks "hands a token to the agent" (on GitHub, the installation token for `git clone`
  and `git push`). Both are optional and additive in the plugin contract; the ten shipped
  plugins and the scaffold have a summary.
- **Releases.** Pushing a tag `v2.x.y` publishes the image for `linux/amd64` and
  `linux/arm64` to `ghcr.io/sbw-vaubaan/vaubaan-gateway` (`<version>`, `<major>.<minor>`
  and `latest`; a pre-release only its own version), with an SBOM and a signed
  build-provenance attestation you can check with `gh attestation verify`, and creates
  the GitHub release from this file. The version you run is shown in the footer of every
  page, next to the commit, as on `/healthz`. What a version number promises —
  configuration keys, refusal codes, the plugin contract, catalog ids — is written down in
  `docs/workflow/coding-workflow.md`; pulling and verifying an image in `deploy/README.md`.
- **Contributing, and a kit to write a provider plugin.** `CONTRIBUTING.md` takes an
  outside contributor from a fresh clone to a pull request (setup, the demo, the tests, the
  documentation-first rule, the checklist); `plugins/README.md` is a step-by-step guide to
  write, test and submit a plugin, checked by writing a plugin from it; `SECURITY.md` says
  how to report a vulnerability privately, what is in scope and the trust model. New issue
  form "Catalog correction" for a wrong or missing risk. The plugin scaffold
  (`plugins/_template`) is brought to the level of the shipped plugins: identifiers that
  reach a request path are limited to one path segment, in the classifier and the executor
  alike.
- **`npm run demo`: the whole interface in your browser, nothing to register.** One
  command starts the real application on `http://localhost:3210` with a demo identity
  provider (an account picker: Alice the operator, Bob, Carol — no password), simulated
  GitHub, Stripe, Cloudflare DNS, Resend and Upstash Redis, and seeded connections,
  shares, missions in every state, open requests and audit entries; it prints a tour with
  ready-made `curl` commands. Development only: it refuses a production environment, is
  not part of the image, binds the loopback interface and deletes its data on exit. See
  `docs/handbook/demo-mode.md`.
- **Who did what, when several agents work on one mission.** The Mission session page
  shows the calls of the current period per agent label — allowed, refused, last call,
  the unlabelled ones apart — and filters the timeline to one label; the Audit page has
  an "Agent label" filter. These are counts of calls for information, said so on the
  page: the budget stays per risk and is shared by every agent of the mission.
- **The bootstrap kit and `/agent-bootstrap.md` explain sub-agents**: an orchestrator
  hands them its MCP configuration as is (same token, same budget), and each names itself
  with the header `X-Vaubaan-Agent` or, per call, with `_meta.agent`.
- **Streamed tool results.** A plugin whose provider answers progressively can hand the
  parts of its result to the gateway as they arrive (`ExecuteContext.emitPart`,
  `streamToolResult`, `textParts` in `@vaubaan/plugin-sdk`); an MCP client that sent a
  progress token receives each part at once as a progress notification, then the complete
  result. The decision, the budget decrement and the session event always come before the
  first byte; the audit entry is written when the stream ends, with the latency of the
  whole stream, and records a stream that broke midway or whose caller went away. Works
  through the standalone image and the reference Caddy configuration as shipped. No
  shipped plugin streams yet.
- **Delegation: an agent acts on a user's behalf.** The instance is an OAuth authorization
  server for its management MCP door, `/mcp/manage`: an MCP client such as Claude Code
  discovers it (RFC 9728 and RFC 8414 metadata), registers itself, and sends the user to
  sign in and to a consent screen that names the application as a claim, the single scope
  `mgmt`, what it covers and never covers, and where the access goes. Authorization code
  with PKCE `S256` only; opaque access tokens (`oauth.access_token_ttl`, 15 minutes, at
  most 1 hour) and single-use rotating refresh tokens (`oauth.refresh_token_ttl`, 30 days),
  stored as digests; `/oauth/token`, `/oauth/revoke`. A refresh token or an authorization
  code presented twice revokes the whole delegation, with an audit entry — except the
  refresh token rotated last, presented again by the same client within
  `oauth.refresh_reuse_window_seconds` (30 by default, at most 60, 0 to disable): two
  sessions of one agent that share a stored token and renew together both succeed.
- **An agent prepares a mission by itself.** Behind that consent, `/mcp/manage` offers seven
  tools: `list_my_connections` (the connections the user owns or was shared, with the exact
  list of acceptable risks, resources and their environment labels, presets),
  `get_catalog`, `list_my_missions` (state, policy, what is left of each quota),
  `preview_policy`, `issue_mission`, `rotate_mission_token` and `revoke_mission`. Every
  tool acts as the delegating user within their current authority: a draft that exceeds it
  is refused whole with the list of what is not covered. The user is the creator of a
  mission issued this way; the answer contains the mission token, once, and the bootstrap
  kit. The door cannot answer a request, open a gate, extend a budget, touch a connection,
  a share or a group, or call a provider tool — it is not given the means to. Rate-limited
  per delegation.
- **Delegated missions are marked.** Missions and the mission page show the application
  that issued a mission on the user's behalf; the audit entries of an issuance, a rotation
  and a revocation made through the management door name that client next to the user.
- **The bootstrap kit and `/agent-bootstrap.md` describe the management door**: what it is
  for, that a mission token does not open it, and that it lifts no refusal.
- **Delegations page.** A user sees the applications they authorized, where each sends its
  access, the missions it issued, and revokes one in a click; a revocation by the gateway
  says why. Grants and revocations are audited under the user's name and visible in their
  audit.
- **OAuth clients and the registration policy.** `oauth.client_registration.policy` is
  `open`, `operator-approved` (default) or `closed`. Under the default a client that can
  only return to the user's own machine (a loopback redirect URI — command-line and desktop
  agents) needs no approval (`auto_approve_loopback`, default true); any other waits for an
  operator under Administration → OAuth clients, where a client can also be disabled, which
  revokes its delegations. Client ID Metadata Documents are supported and off by default
  (`oauth.client_registration.metadata_documents`).
- **The three credentials are refused by kind at both doors.** A delegated token at `/mcp`
  and a mission token or a web session at `/mcp/manage` answer `wrong-credential-kind`,
  naming the door that accepts them; a delegated token opens neither the interface nor a
  request.
- **Approval gate.** A call touching a risk gated `approval` is refused `approval-required`
  with the URL of an approval request, how long a granted approval stays usable and the
  instruction to replay identically. The mission's creator — and nobody else, operators
  included — reads the tool, the arguments in clear, the slices touched and what is left of
  every risk the call counts against, then approves that one action, opens the gate for the
  rest of the period, or refuses. An approval is bound to the mission, the risk, the tool and
  the fingerprint of the arguments, is used once and expires after `approvals.expiry`
  (`VAUBAAN_APPROVAL_EXPIRY`, default 10 minutes); an approved action still counts against the
  quota and the rate limit. The arguments are kept encrypted while the request is open and
  erased when it is decided or expires. Every decision is audited.
- **Gates are editable after issuance.** On the mission page the creator switches the gate of
  an accepted risk between `auto` and `approval`; the edit applies to the next call, is
  audited (`gate-changed`) and ends an opening granted earlier in the period.
- **Execution MCP door.** `POST /mcp` takes a mission token: `tools/list` shows the tools of
  the providers the mission holds a connection and an accepted risk for; `tools/call` checks
  mission state, resources, `risks_touched ⊆ accepted_risks`, budget, rate and gate, calls the
  provider with a credential decrypted for that call only, and writes one audit entry, allowed
  or refused. Stateless Streamable HTTP on `@modelcontextprotocol/server` 2.3 (2025-era and
  2026-07-28 clients), plain JSON — an event stream only for a call that asked for progress
  (see "Streamed tool results") —, rate limited per mission (`mcp.rate_limit_per_minute`, 600).
- **Mission catalog.** `GET /mcp/catalog` returns the tool surface, what the mission can
  call, its resources with their environment labels and what is left of each risk's quota.
- **Agent labels.** An agent may label its calls with the `X-Vaubaan-Agent` header or, per
  call, with `_meta.agent`; the label is attribution in the audit and the session, never a
  credential and never a budget.
- **OIDC sign-in and web sessions.** Any OpenID Connect provider signs humans in
  (`openid-client` 6.8: discovery, PKCE S256, state and nonce, configurable `sub` / `email` /
  `groups` claims, optional allowed email domains); IdP groups are replaced on every sign-in,
  local groups untouched. Sessions are server-side (`HttpOnly; Secure; SameSite=Lax` cookie,
  8-hour absolute TTL, origin check on every mutation). Routes `/login`, `/auth/login`,
  `/auth/callback`, `POST /logout`.
- **Bootstrap token and administration.** `/admin/bootstrap` accepts the configured bootstrap
  token while no IdP is set; `/admin/identity-provider` stores the IdP (client secret
  encrypted, change audited) and offers a "Test login". The first operator sign-in revokes the
  bootstrap token (audited); afterwards the operator is whoever matches the admin rule,
  recomputed from the user's current groups on every request.
- **Connections and the connect drivers.** A signed-in user connects a provider from
  `/connections` through one generic driver for the four credential kinds: `oauth2` (PKCE,
  RFC 8707 resource indicator, single-use server-side `state` bound to the user, return URL
  limited to `public_url`), `app-install`, `api-key` (checked by a first discovery; a rejected
  key stores nothing) and `ssh-key` (ed25519 pair generated by the instance). Attempts are
  rate limited per user; connections, reconnections and revocations are audited.
- **Connection lifecycle and token refresh.** A connection is `active`, `expired`, `revoked`
  (terminal, credential erased) or `unowned`; an unowned connection keeps serving its
  missions and cannot be reconnected until an owner is reassigned. The host refreshes OAuth
  tokens from the plugin's spec, so a plugin never sees the
  client secret; a rejected refresh turns the connection `expired`, an unreachable provider
  does not.
- **Resources.** Plugins discover resources at connect time and on "Refresh discovery". The
  owner renames them, labels their environment, hides them and edits list settings (Resend
  recipient zones); those edits survive re-discovery, a label set by the plugin (Stripe
  `test` / `live`) is read-only, and a resource that vanished upstream is marked stale, not
  deleted.
- **Provider apps.** Operators register each provider's app in Administration → Provider apps
  (fields derived from the plugin, secrets encrypted in the store) or under `providers.<id>`
  in the mounted configuration, which wins and makes the page read-only for that provider.
  Changes are audited. Experimental plugins (Gmail) carry a badge.
- **Missions.** A connection owner issues a mission on one page, `/missions/new`: name,
  connections and resources (hidden ones left out, stale ones refused), one preset per
  connection, a can / cannot / quantities summary, per-risk quota, rate limit and gate, period
  and optional expiry; "select all" yields an enumerated list. A mission can start from a
  duplicate or an agent's pasted JSON proposal. Issuance refuses anything beyond the owner's
  authority and any accepted risk without a budget, and the preview warns when a selected
  resource has no usable environment label (its env-scoped risks would be refused at call
  time).
- **Mission tokens and the bootstrap kit.** The token (`vbn_live_`, argon2id, prefix lookup)
  is revealed once with the kit: environment variable, `.mcp.json` referencing
  `${VAUBAAN_MISSION_TOKEN}`, agent instructions for each refusal, and a `curl … tools/list`
  check. Rotate and revoke from the mission page. `/agent-bootstrap.md` documents mission
  tokens.
- **Budget and sessions.** A call touching N risks decrements N counters in one transaction,
  or is refused whole with `budget-exhausted`, `rate-limited` or `approval-required`. Periods
  roll over on read; a one-off mission has a single open-ended period. The credit of an
  allowed call is not refunded when the upstream call fails. Rate limiting is in memory, for
  a single process. A mission is `active`, exhausted per risk, `expired`, `orphaned` or
  `revoked`.
- **Claims and the request inbox.** The URL a `budget-exhausted` refusal carries,
  `<public_url>/r/<id>`, asks for a sign-in and lets only the mission's creator through; it
  refuses any bearer and is rate limited per client address. The creator can reset the period,
  give back up to what was consumed on the risk, extend the expiry, or refuse; the decision is
  audited, the token does not change and the agent replays its call. "Requests" lists what
  awaits you, with a count; unanswered requests expire after `requests.expiry` (default 24 h).
- **Audit search and retention.** `/audit` searches by mission, user, connection, tool,
  decision, agent label and period, newest first, with keyset paging. A user sees the entries about their
  missions and the connections they or their groups own; an operator also sees every
  administrative entry; nobody sees arguments, only their hash. Entries older than
  `retention_days` (default 90) are purged at boot and then hourly. Every mutation leaves an
  administrative entry, including discovery refreshes and resource edits.
- **Mission session page.** `/missions/<id>/session`, linked from the mission page, shows the
  counters per risk and per period with what is left, the gate of each risk, the open requests
  as links, the agent labels seen and the event timeline.
- **Community telemetry (opt-in).** Off at installation. An operator enables it on
  Administration → Telemetry, which shows the exact payload first: plugin, plugin version,
  gateway version, tool, outcome (`success`, `upstream-error`, `classification-error`,
  `execution-error`) and a fixed-vocabulary error class — never arguments or their hash,
  resource refs, mission or user identifiers, an instance identifier, an address or a
  provider's message. Setting `telemetry.enabled` in the configuration decides instead and
  makes the page read-only. Reports are batched and retried with backoff. The built-in
  collector URL is a placeholder: nothing is sent until `telemetry.collector_url` names a
  real collector. `deploy/collector/` ships the collector's SQL (insert-only table, public
  `plugin_stats` view, published thresholds: 200 reports and 90 % success over 90 days).
- **Community validation badge.** With telemetry on and a collector configured, the
  Connections pages show whether the plugin version in use is validated by the community;
  nothing is shown, and nothing is fetched, otherwise.
- **Embedded SQLite store.** `better-sqlite3` with `STRICT` tables and WAL, forward-only
  migrations applied at boot (schema version 8), an append-only audit enforced by triggers,
  encrypted credential blobs and a `:memory:` mode for tests. The runner refuses a database
  newer than the image, and the instance fails fast naming `store.path` when the database
  cannot be opened.
- **Configuration loader.** The gateway starts from `VAUBAAN_*` variables and/or a mounted
  YAML file (`VAUBAAN_CONFIG_FILE`, file wins key by key; `${NAME}` / `${file:/path}` secret
  references, `*_FILE` variables). A missing or invalid key, unsupported `${...}` syntax or a
  `providers.<id>` block naming no registered plugin stops the process with exit code 78 and a
  message naming every key and its variable; errors never echo a
  `VAUBAAN_MASTER_KEY_PREVIOUS` entry.
- **Credential encryption.** Credentials at rest use XChaCha20-Poly1305 with a key derived
  per connection, the connection id as associated data, and a `key_version` for rotation.
  `npm run gen-master-key` generates a master key.
- **Docker image and deploy kit.** `deploy/docker/Dockerfile` (debian-slim, non-root, `/data`
  volume, HEALTHCHECK, no `.env*` file shipped), `deploy/compose.yaml` with a Caddy TLS proxy
  that sends the security headers, base images pinned by version and digest, and documented
  `deploy/config/gateway.example.yaml` (every key commented out) and `.env.example`. A CI job
  builds the image and runs the container smoke test. `GET /healthz` answers; logs are JSON
  lines with token-prefix and secret redaction.
- **Plugin SDK.** `@vaubaan/plugin-sdk`: the `ProviderPlugin` contract and `definePlugin()`,
  the `CredentialSpec` union (`api-key`, `oauth2`, `app-install`, `ssh-key`), the
  `PluginRegistry` every provider list derives from, the optional `envOf` hook (with
  `envFromSliceSegment()`), `experimental`, an optional `refresh()` override for non-standard
  OAuth flows, and `ExecuteContext.credentialCache`. `plugins/_template` is the scaffold.
- **Risk catalogs and the plugin test kit.** Each plugin ships a `risk-catalog.yaml`, located
  with `catalogPathNextTo(import.meta.url)` and loaded at boot: presets (at least one, every
  entry an explicit risk of the catalog) and exactly one `fallback: true` entry, which no
  preset may include. Preset budgets are validated by one rule for YAML and TypeScript
  catalogs alike (whole positive quota and rate, known gate). The test kit provides
  `mockFetch`, `assertCatalogCoverage` (reports `fallbackHits`), `assertNoWildcard` and
  `assertPresetsValid`.
- **Ten provider plugins on the SDK.** GitHub, Vercel, Supabase, Railway, Stripe, Resend,
  Cloudflare DNS, Upstash Redis, SSH and Gmail are `definePlugin()` descriptors registered at
  boot, with resource discovery, classifiers keyed on the mission's resources and presets in
  their YAML catalog; the TypeScript catalog twins and their sync tests are gone.
- **GitHub plugin.** `app-install` credential (company GitHub App id and private key) with a
  per-call installation token scoped to the repository, reused for up to 50 minutes and
  dropped when GitHub rejects it or the connection is revoked. One resource per repository of
  the installation. Presets `read-only`, `developer`, `release-manager` (approval on
  protected-branch merges, release deletion, workflow-file writes and push-token minting).
- **Vercel plugin.** `api-key` credential (access token and team id), one resource per team
  project, environment read from the call's `env[...]` segment. Presets `read-only`,
  `developer`, `operator` (approval on production-affecting entries).
- **Supabase plugin.** `oauth2` credential against the Management API with refresh, resources
  from the account's organizations and projects, env-scoped write risks, and `execute_sql`
  enforced read-only through the Management API read-only query endpoint. Presets
  `read-only-analyst`, `staging-developer`, `migration-operator`.
- **Railway plugin.** `oauth2` credential with PKCE, RFC 8707 resource indicator and refresh;
  one resource per project with its environments, through which `accept-deploy` resolves;
  `read-variables` is env-scoped. Presets `read-only`, `developer`, `operator`.
- **Stripe plugin.** `api-key` credential with optional test and live keys, one resource per
  mode (`acct_…/test`, `acct_…/live`), every risk env-scoped on `[test, live]`, new
  `create_payout` and `delete_customer` tools behind their own irreversible risks. Presets
  `read-only`, `test-mode-developer`, `finance-operator` (approval on live money-out and
  irreversible entries); `stripe.subscription-create` covers `create_subscription` (catalog v3).
- **Resend plugin.** `api-key` credential, one resource per sending domain (with its
  recipient-zone lists) and per segment; sends are rooted at the `from` domain and refused
  outside the mission. `read-audiences` / `audience-write` are deprecated in favour of
  `read-segments` / `segment-write`; two membership tools added. Presets `read-only`,
  `developer`, `marketing-operator`, `domain-admin` (approval on bulk sends, segment deletion
  and domain mutations).
- **Cloudflare DNS plugin.** `api-key` credential (a zone-scoped API token), one resource per
  zone, `list_zones` filtered to the mission's zones. Record writes split into `record-write`,
  `critical-record-write` (apex, wildcard, MX, NS) and `record-delete`; `zone-delete` now
  matches the zone itself only. Presets `read-only`, `dns-operator`, `zone-admin` (approval on
  deletions, critical records, imports, zone settings and DNSSEC).
- **Upstash Redis plugin.** `api-key` credential (account email and Management API key as
  separate fields), one resource per database (capped at 200), every write risk env-scoped on
  the owner's database label, REST tokens redacted from Management API answers. Presets
  `read-only`, `developer`, `operator` (approval on FLUSH outside development, database
  deletion and rename).
- **SSH plugin.** `ssh-key` credential: ed25519 pair generated by the instance, host, port,
  user, and a host key fingerprint pinned and verified on every connection; the host is the
  connection's resource. `ssh__exec` is classified by a shell lexer that reads a command line
  as `sh` does, with four new risks (`exec-destructive`, `exec-package-install`,
  `exec-service-control`, `exec-sudo`); a line it cannot see through is never a read. Presets
  `read-only`, `developer`, `operator` (approval on destructive classes outside dev and on
  every prod write).
- **Gmail plugin (experimental).** Classifier only: no tool is exposed and `execute` answers
  a structured `not_implemented` error. `oauth2` credential against Google (PKCE, scopes
  `gmail.readonly` and `gmail.compose`, offline consent); the authenticated mailbox is the
  single resource. New `gmail.draft-write` risk, wider `read-mailbox`. Presets `read-only`,
  `developer` (bulk entries under approval).
- **`@vaubaan/shared` domain types.** Connections, resources, shares, missions, sessions,
  requests, approvals, delegations, the eight `RefusalCode` values and `parseRiskId` /
  `formatRiskId`; the package is the single source of truth for the domain types.
- **Open-source project files and browser tests.** `LICENSE`, `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue templates and a pull request template.
  `npm run test:e2e` runs the browser tests against an ephemeral instance with a simulated IdP.
- **Cutover acceptance scenario and its automated smoke.** `docs/tests/e2e-tests.md` states
  the manual scenario that gates the cutover from v4 (connect every provider in use, one
  mission per code project, a day of Claude Code work with no unexpected refusal), and
  `docs/handbook/cutover-from-v4.md` is the checklist to tick. A Playwright smoke walks the
  same path on an ephemeral instance — simulated IdP, mocked GitHub, an MCP client on `/mcp` —
  and runs with the other browser tests in a new CI job, `e2e`.
- **Shares.** The owner of a connection shares it with a user (by email) or a group from
  the connection page: a target, then a checklist of the provider's risks grouped by
  severity, folded behind a one-line summary. "Select all" ticks today's risks one by one;
  what is stored is that list, never "everything", and a risk added to the catalog later is
  not shared. The target sees it under the new **Shares received** page with the exact
  restriction, and issues missions within it; several shares of one connection add up.
  Sharing again to the same target replaces its restriction. Only owners share.
- **Local groups and ownership.** Administration → Groups lets the operator keep groups for
  an identity provider that sends none; a user's groups are the IdP's and the local ones
  together. An owner transfers a connection to a group they belong to: every member, now and
  later, is a full owner.
- **Connections without owner.** When the owner group of a connection has no member left the
  connection is `unowned`: it keeps serving the missions that still have grounds, nobody can
  share or reconnect it, and the operator names a new owner under Administration →
  Connections — their only act on connections.
- **Orphaned missions, for as long as the authority is missing.** A mission whose creator
  does not cover its accepted risks — the share was revoked or narrowed, the connection
  revoked, the creator left the group that owned or received it, or was removed — is
  `orphaned` and refuses every call with `mission-inactive`. The state is computed from the
  creator's current authority each time it is read and stored nowhere: when the authority
  comes back (the owner shares again, the next sign-in carries the group again, the operator
  reassigns the connection or returns a group membership) the same mission serves calls
  again with the same token, session and counters. A group claim missing at one sign-in is
  therefore a refusal until the next sign-in, not a mission to re-issue in every project. A
  revoked connection never comes back: its missions stay orphaned. While orphaned, no gate
  is edited, no token rotated and no request granted; the creator can still revoke. The
  mission page says why the mission is orphaned and whether it can come back; the Audit
  shows the creator the acts that orphaned and restored it (`mission-orphaned`,
  `mission-restored`: who, cause, connection, risks not covered).
- **Output schemas on the management tools.** Each of the seven tools of `/mcp/manage`
  advertises an `outputSchema` in `tools/list`, so an MCP client can validate the structured
  answers. The schemas name what an answer always carries and accept additional keys; a
  refusal stays a tool error with its `{ error }` content.
- **The Mission session page says what gate and approval events did.** It shows until when
  a gate opened for the period stays open, until when an approved call can be replayed, both
  values of an edited gate, and the request a refused call pointed to. The Audit page names
  the object of every administrative entry — shares, groups, OAuth clients, delegations and
  requests included — instead of showing a bare id.
- **`UpstreamHttpError` in `@vaubaan/plugin-sdk`.** A plugin throws it for a provider
  answer that is a failure and not a credential problem (a 4xx other than 401 / 403, a 5xx);
  the host reads its `status` for the audit summary and the telemetry class, and the message
  goes to the agent only. `plugins/_template` and `plugins/README.md` show the rule: provider
  failures are thrown, executor refusals are `isError` results.

### Changed

- **The Audit filters are grouped** into what, who and when, on two rows instead of ten
  fields in one; tool names and risk ids wrap between their words, never inside one; the
  "no environment label" warning of mission creation names a resource by the name its owner
  gave it.
- **The application bar holds on one line**: "Shares received" reads "Shares" and
  "Administration" reads "Admin" in the bar, the current section is marked, and the email,
  the role and "Sign out" are behind one account button.
- **A risk reads the same, and shorter, everywhere**: on mission creation, the Share dialog
  and the mission page a risk is three lines — its label, its id with one line of reason
  that unfolds, and a six-cell strip for its profile in place of six worded badges. The
  Custom editor aligns quota, rate limit and gate in columns and can be narrowed to one
  plane of the provider.

- **A risk reads the same on every page.** The Share dialog shows its checklist open, each
  risk with its label, the reason it is a risk, its profile and a link to its entry in the
  provider reference; the mission page explains each risk of the policy the same way. The
  per-risk detail of mission creation, formerly a folded section at the bottom of the page,
  is now the Custom mode of each connection.
- **The documentation is in English and describes what the code does.** The risk-model
  specification, the per-environment vector note, the style guide and the Resend provider
  specification are rewritten against the implementation (the French and v4 texts are kept
  under `docs/spec/legacy/`); the README is written for a first visitor (what it is, a
  quick look with `npm run demo`, an install path, an architecture diagram, an honest
  status); `docs/handbook/README.md` indexes the handbooks; `docs/AGENTS-guide.md` gives
  coding agents the method and the map of the repository.
- **Agent labels are checked, not repaired.** A label is 1 to 64 characters: letters,
  digits and `. _ - : / @ +`, starting with a letter or a digit. Anything else is ignored
  — the call is served without a label and the gateway logs why — where it used to be
  cleaned up and cut at 120 characters. When a call carries both `_meta.agent` and the
  `X-Vaubaan-Agent` header, `_meta.agent` wins, as before. A label never changes what is
  allowed or counted.
- **A revoked connection orphans its missions.** Calls of a mission that carries a revoked
  connection now answer `mission-inactive` (`status: orphaned`) instead of
  `connection-unavailable`; an expired connection still answers `connection-unavailable`.
- **An unowned connection whose credential is rejected becomes `expired`**, like an owned
  one, instead of staying `unowned` while serving nothing.
- **The owner of a connection reads its share entries in the Audit**; the administrative
  acts gain `connection-reassigned`, `mission-orphaned`, `mission-restored`,
  `group-created`, `group-member-added` and `group-member-removed`.
- **A mission that is not revoked can always be revoked from its page**, an orphaned or
  expired one included; "Rotate token" stays on active missions only.
- **Schema migration `0007`.** It resets the missions an earlier v5 image had stored
  as `orphaned` to `active` — they read orphaned again at once if their authority is still
  missing — and makes the database refuse that value from then on.
- **The timeline of one agent label is read whole (schema migration `0008`).** The label of
  a call event is now a column of the session events, filled for the events an earlier image
  stored. The Mission session page pages the calls of one label, or the unlabelled ones,
  however many events of other labels lie in between; it used to stop looking after a
  bounded number of events, and said so.
- **Requests on an orphaned mission expire on the normal delay.** A claim or an approval
  request opened before its mission was orphaned is not held until the authority returns:
  the request page says until when it can still be granted, and the `mission-inactive` hint,
  the bootstrap kit and `/agent-bootstrap.md` tell the agent that its next refused call
  opens a new one after that.
- **Token grants are all-or-nothing.** A code exchange or a renewal at `/oauth/token` is one
  transaction. When the store fails in the middle, the client reads `server_error` (500) and
  nothing is half-written: the authorization code is not spent and the presented refresh
  token is still the valid one, so the same request can be sent again and is not treated as
  a replay. Disabling an OAuth client and revoking its delegations is one transaction too.
- **`/.well-known/oauth-protected-resource` answers like the other discovery documents**:
  `GET`, `HEAD` and `OPTIONS` with CORS. The path-less document describes the execution
  door (no authorization server, the bearer in the header).
- **A delegated token presented on a request page is named for what it is.** The refusal of
  `/r/*` and `/api/requests/*` says `presented: "delegated-token"`; a bearer of no known
  shape is refused without a `presented` field instead of being called `bearer`.
- **`mission-orphaned` and `mission-restored` are written once.** When two acts under way at
  the same time observe the same change, the Audit holds one entry, naming the act that
  settled first. The missions an
  act orphans or restores are recorded even when the act's own entry could not be written.
  Adding a user who is already a member of a group writes no `group-member-added` entry.
- **Revoking a share through the wrong connection is "not found".** The route names the
  connection; a share of another connection is not revoked through it, and a revocation
  that lost a race with another one answers like a repeated revocation.
- **Shipped plugins throw provider failures.** Vercel and Upstash Redis returned a failed
  provider call as an error result, which telemetry counted as a refusal by the executor;
  they now throw it with its HTTP status, like the other plugins, so the audit summary and
  the telemetry class read `upstream-error` / `http_<status>`. What an executor declines by
  itself (malformed arguments, a record it will not touch) stays an error result. Railway,
  Resend, Stripe and Supabase attach the status to the failures they already threw.
- **Plugin versions.** GitHub, Vercel, Supabase, Railway, SSH, Cloudflare DNS and Upstash
  Redis are `2.0.0`; Stripe is `0.3.0`; Resend and Gmail are `0.2.0` — bumped for the
  stricter classifiers of this release and reported as `plugin_version` by telemetry. The
  catalogs are at `catalog_version` 4 (Stripe), 3 (GitHub, Railway, Resend, SSH, Upstash
  Redis, Gmail) and 2 (Vercel, Supabase, Cloudflare DNS). A plugin's `version` in
  `src/index.ts` and in its `package.json` are bumped together.
- **Pages state the rules their services apply.** Whether a connection can be shared,
  transferred or reassigned, and whether a mission's gates can be edited, is read from the
  service that enforces it; a page no longer offers an act the service would refuse (the
  operator's reassignment list holds only groups that have a member).
- **Browser tests run the server that ships.** `npm run test:e2e` builds the application and
  starts the standalone `server.js` of that build, the file the image runs (13 tests). The
  standalone output carries no test file.
- **`/mcp` accepts mission tokens only (breaking).** A web session or a delegated token is
  refused with `wrong-credential-kind`; a token replaced by rotation is a 401 from the next
  call and a revoked mission answers `mission-inactive`, because the door re-reads the token
  and the mission on every call. `/mcp` no longer answers CORS and refuses a browser `Origin`
  other than the instance's own.
- **Refusals are structured.** Eight typed refusals (`risk-not-accepted`, `budget-exhausted`,
  `approval-required`, `resource-not-in-mission`, `rate-limited`, `connection-unavailable`,
  `mission-inactive`, `wrong-credential-kind`) reach the client whole: JSON-RPC error `-32603`
  whose `data` carries the code, its fields (claim URL, approval URL, allowed resources…) and
  an agent-readable hint.
- **Only a 401 from a provider counts as a rejected credential.** The gateway then refreshes
  and retries once; a rejected refresh turns the connection `expired` and the agent reads
  `connection-unavailable`. A 403 is reported as a failed call and leaves the connection alone.
- **The audit's argument hash is the approval fingerprint.** SHA-256 of the key-sorted
  canonical JSON, 64 hex characters instead of 16. A `risk-not-accepted` entry records
  `risks_touched`, and decisions read `allowed` | `refused`.
- **The fallback risk no longer co-fires with a categorized write.**
  `<provider>.uncategorized-write` is touched only when no other catalog entry matches the
  slice; a slice covered by nothing is still refused. Missions built from presets can perform
  the writes the preset names, and the fallback in an audit log means a catalog entry is
  missing.
- **Policy engine.** `@vaubaan/policy-engine` resolves environments through an `EnvResolver`
  over the mission's resources (plugin `envOf` first, resource label next).
  The slice glob `*` now matches the parser's whole identifier class (`release-*` matches
  `release-1.2`; it used to fail open to the fallback risk), and `isAcceptableInEnv` is the
  single `acceptable_in_envs` rule.
- **`@vaubaan/gateway-core` speaks v5.** `MissionContext`, the `CallPipeline` with its stage
  interfaces, `DoorAuthenticator`, `BearerKind` for the three kinds of bearer, v5 `AuditEntry`
  behind `AuditWriter.write(entry)`, and a bounded, single-process `MemoryCacheClient` as the
  only cache client. Domain types are re-exported from `@vaubaan/shared`.
- **Scope caps are not enforced in v5.0.** The execution door has no cap stage, so a shipped
  catalog declares only the limit the gateway enforces, the rate ceiling
  (`infra_limits.calls_per_minute_max`). The caps and other limits of the Stripe, Resend and
  Gmail catalogs are removed, their values kept in ADR `scope-caps-not-enforced-in-v5-0`; a
  mission bounds those risks with its quota, rate limit and gate.
- **Web entry points.** `/` redirects to `/missions`, or to `/login` when signed out; `/login`
  replaces the v4 Supabase login.
- **Next.js 16 and zod 4.** `apps/gateway` runs on Next.js 16.4.0 with React 19.3.0 (from
  15.5.18 / 19.1.1), built with Turbopack as a standalone server that traces the
  `better-sqlite3` runtime files and the plugins' YAML catalogs. `transpilePackages` is derived
  from the workspace dependencies and the build-time `ALLOWED_ORIGINS` is gone.
- **Repository layout and contribution workflow.** `packages/web` is `apps/gateway`
  (`@vaubaan/gateway-app`), `packages/mcp-gateway` is `packages/gateway-core`, and every
  provider moved from `packages/providers/<p>` to `plugins/<p>` (`@vaubaan/plugin-<p>`). npm
  workspaces are `apps/*`, `packages/*`, `plugins/*`. `deploy/config/*.yaml` is gitignored
  except the example.
- **Licence and version.** Licence changed from proprietary to **Apache-2.0**; package version
  set to `2.0.0-alpha.0`. The last v4 SaaS release is tag `v4-final`.
- **Documentation.** `README.md`, the v5 handbooks (one per provider under
  `docs/handbook/providers/`), the test plans and the workflow are in English. v4 handbooks
  moved to `docs/handbook/legacy/` and other v4 documents are marked `status: legacy`; the
  web-app handbook is rewritten for the v5 shell and the provider-modeler skill
  (`docs/skills/provider-modeler.md`) for the v5 SDK. New ADRs include
  `plugin-contract-and-credential-spec`, `embedded-store-sqlite-and-migrations`,
  `docker-image-and-config-format`, `oidc-relying-party-and-web-session`,
  `atomic-budget-accounting` and `fallback-risk-only-when-uncategorized`.

### Removed

- **The v4 application (breaking).** The organization / project / token pages, the marketing
  site, `/api/v1/**`, `/api/integrations/**`, the Supabase-backed gateway and its `McpGateway`
  orchestrator, the v4 Playwright specs, and the dependencies only they used (`@supabase/ssr`,
  `@supabase/supabase-js`, `@modelcontextprotocol/sdk` v1, `mermaid`).
- **v4 plugin surface.** The v4 adapters and `classifyXxxV4` wrappers of the ten plugins, the
  GitHub personal-access-token path, the `venv` tools of Supabase and Vercel, the Cloudflare
  Global API Key form (refused), and Gmail's `acceptable_in_envs: []` entries.
- **Hosted-SaaS infrastructure.** Supabase migrations and configuration (`supabase/`), the
  Supabase migrations workflow, `vercel.json`, the v4 operator `.env.example` and the
  Supabase/Vercel-only scripts under `scripts/`. v5 ships as a single on-prem process with an
  embedded store.
- **From `@vaubaan/gateway-core`.** `RedisCacheClient` (Upstash), `buildCacheClient`,
  `SupabaseAuditWriter`, the `venv` secret store, the v4 `ProviderBinding` inputs and `V4*`
  aliases, the 16-character `hashArguments`, and the `@supabase/supabase-js`, `@upstash/redis`
  and `@vaubaan/plugin-github` dependencies.
- **From `@vaubaan/shared` and `@vaubaan/policy-engine`.** The v4 row types (`legacy-v4.ts`),
  the escalation channel and token-context payload types, the deprecated token aliases, the
  unused `zod` dependency and the broken `./capability` export; the bindings bridge and the
  scope-injection module of the policy engine.
- **The SSH plugin's v4 annotated-script module.** `plugins/ssh/src/bash` (the parser,
  argument and execution helpers of the v4 annotated scripts) is deleted; `ssh__exec` and its
  classifier are the plugin's only surface.
- **Superseded store and session code.** The `src/server/session/` module, replaced by the
  store's `webSessions` repository, and `ConnectionsRepo.replaceResources`, replaced by the
  resource sync that keeps owner edits.
- **Repository methods only tests called.** `RequestsRepo.decide` and `expireOpen`,
  `ConnectionsRepo.setStatus`, `setCredential` and `assignOwner`, `ApprovalsRepo.consume` and
  `getById`, `SessionsRepo.getById` and `resetCounters`, `DelegationsRepo.consumeCode`,
  `createRefreshToken` and `revokeRefreshToken`, and the unused MCP SDK verifier contract of
  the delegated-token verifier (`verifyAccessToken`, `DELEGATION_AUTH_INFO_KEY`). Every state
  change of the store now goes through a method that carries its condition in the same
  transaction.

### Security

- **Hardening pass before 2.0.** What changes for you:
  - _Plugins: what is executed is what was classified._ In several plugins an identifier
    such as `..` passed the classifier and was then sent to another endpoint (a Supabase
    object path leaving its bucket, a Vercel domain or a GitHub workflow id collapsing to the
    parent resource, an Upstash database id). Every plugin now validates each identifier with
    one grammar used by the classifier and the executor, and refuses what does not fit
    instead of escaping it; some unusual values are refused that used to pass (an object path
    with `..`, a tag written `refs/tags/…`, a recipient list inside one address string).
  - _Operators can deactivate a user_ (Administration → Users): no sign-in, sessions ended,
    delegated applications cut off, the user's missions refused, their connections handed
    back for reassignment — without waiting for the identity provider. A sign-in no longer
    reactivates a removed user.
  - _Everyone signs in again once after the upgrade_: the session cookie is now
    `__Host-vbn_session`, which a sibling subdomain cannot plant.
  - _Entra ID_: a user in more groups than a token carries is refused at sign-in with a
    message for the operator, instead of silently losing every group.
  - _Management door_: a delegated application rotates the token of the missions it issued,
    no longer of any of your missions (new refusal `mission-not-issued-here`, new field
    `issued_via.this_delegation`). After a token replay, the Delegations page lists the
    missions that delegation issued for you to review.
  - A member of a group that owns a connection can no longer share it to themselves and keep
    it after leaving the group. A call whose arguments are not JSON values (`1e999`) is
    rejected. The instance warns at start-up when `trusted_proxies` is empty.
  - CI and releases are gated by a dependency audit with a reviewed allowlist; the image is
    checked for stray test files. The threat model — actors, controls, the test behind each,
    accepted risks — is `docs/handbook/threat-model.md`.
- **The image no longer contains the test suite.** A computed path in the plugin SDK made
  the build copy the whole `apps/gateway` directory into the standalone output, tests and
  their fixtures included (an identity provider without passwords among them, inert there).
  The output now holds what the server needs; a test fails if a test file returns.
- **The execution door re-checks the creator's authority on every request.** A mission used
  to keep working after the share behind it was revoked or its creator left the owner group:
  the `orphaned` status existed and nothing set it. The door now re-reads the creator's
  status, memberships and shares for each request (about 17–45 µs) and refuses the call
  when they do not ground the mission; the pages read the same answer, and the services
  audit which act orphaned or restored a mission.
- **The admin rule counts IdP-claimed groups only.** A local group — which an operator can
  now create and fill in Administration — never makes its members operators, and cannot take
  the name of the admin rule's group.
- **The management door checks the client on every request.** A delegated token stops
  working as soon as its client is disabled by an operator, or is no longer approved under
  the registration policy (a tightened policy, redirect URIs that left the loopback
  interface) — although the delegation is still listed and its token has not expired.
- **Token-endpoint limits are spent only by a caller that proved something.** The per-client
  limit applies to confidential clients, once their secret matched; the renewals of a public
  client are limited per delegation (120 per minute), once the refresh token is recognised
  as that client's. Knowing a `client_id` is no longer enough to exhaust a client's budget,
  and a replayed refresh token revokes its family even when the budget is spent.
- **A request is decided on the mission as stored at that instant.** The decision of a claim
  or an approval request reads the mission's status and expiry inside its own transaction: a
  mission revoked while the page was open takes no reset, no extension and no approval, and
  an expiry cannot be moved backwards by a decision made on a stale page.
- **The operator reassigns only a connection that is ownerless at the write.** The check and
  the new owner are one transaction: a connection whose owner group regained a member in the
  meantime is not taken from it, and a new owner group that lost its last member is refused.
- **Client ID Metadata Documents are not fetched from `fec0::/10`.** The deprecated
  site-local IPv6 range joins the private, loopback and link-local ranges the fetcher
  refuses.
- **No telemetry reaches the placeholder collector, whatever is appended to its URL.** The
  built-in collector URL is recognised by origin and path: with a collector key, another
  query, a fragment or a trailing slash added it is still the placeholder and nothing is
  sent. A call its caller abandoned is not reported at all: a disconnect is not an outcome
  of the provider.
- **Pages no longer answer 500 for a connection that is not yours.** A page could fail to
  recognise the "not found" a service threw and render an error instead of a 404.
- **An approval is bound to the tool it was read for.** Approvals were keyed by mission, risk
  and argument fingerprint: the same arguments sent to another tool touching the same risk
  would have consumed an approval granted for the first. The key now includes the tool
  (store migration `0005`); no approval could be granted before this release.
- **App installations are bound to the person who performs them.** Connecting GitHub accepted
  the callback's `installation_id` once the `state` was valid, so a signed-in user who knew
  another installation's id could connect it and issue missions on repositories they had no
  access to. The host now exchanges the callback's `code` for a user token, connects the
  installation only when that user can reach it, and discards the token; a refused attempt
  stores nothing and is audited (`connection-refused`).
- **Operators must update their GitHub App.** Enable "Request user authorization (OAuth)
  during installation", register the gateway callback as the App's callback URL, generate a
  client secret, and add `client_id` / `client_secret` to the provider app (Administration →
  Provider apps, or `providers.github.*`). Until then GitHub is reported `incomplete` and
  cannot be connected or used.
- **Unverified app installations are refused by default.** An `app-install` plugin declares a
  `userVerification` block that the host runs generically. A plugin without one cannot be
  connected unless an operator turns on "accept unverified installations" for that provider
  app (off by default, shown with a warning, audited). The client secret is never handed to
  a plugin.
- **An env-scoped risk outside its environments refuses the call.** A call touching an
  env-scoped risk on a resource whose environment the risk is not acceptable in — an
  unlabelled resource, a free-text label, prod for a staging-only risk — is refused with
  `risk-not-accepted`, naming the risk and its environments. The risk used to be dropped, so a
  broader co-touched risk carried the call alone (Railway variables under a read-only mission,
  Supabase user listings). Owners must label resources on the connection page for env-scoped
  operations to run.
- **Return addresses cannot leave the instance.** The sign-in and connect flows share one
  check of the return address: control characters and backslashes a browser strips or
  rewrites, and paths that normalise to `//host`, are refused, and the value is checked again
  where it becomes a redirect.
- **A revoked bootstrap session is nobody; every page authenticates itself.** Once the
  bootstrap token is revoked, a session opened with it is refused on every surface (the Audit
  page kept showing it the administrative log until it expired). Each Administration page and
  each application page and route checks the session itself instead of relying on the layout,
  and every mutating handler passes one origin, session and role guard.
- **Unverified emails are refused at sign-in.** A sign-in whose ID token says
  `email_verified: false` is refused and creates no user. An IdP that does not send the claim
  is unaffected; users whose IdP marks their email unverified must verify it there first.
- **Web sessions are stored under a digest.** Session rows are keyed by the SHA-256 of the
  session id, so a copy of the database holds no usable cookie. Sessions opened before the
  upgrade end with it: everyone signs in again once.
- **Provider error text stays out of the audit.** `upstream_error` holds a bounded summary
  built by the gateway (error class, HTTP status). The provider's own message, which can echo
  arguments, goes to the calling agent only.
- **Plugin classifiers fail closed.** What a classifier cannot place is refused or costs the
  stronger risk, and execution is bound to what was classified. SSH: a line with
  substitutions, here-documents, inline interpreters or unknown wrappers needs every class.
  Supabase: prod migrations are limited to plain DDL and RLS, unreadable SQL needs every write
  class. Railway: an `environmentId` must belong to the mission's project. Vercel: thread tools
  are refused, `deploy_to_vercel` is always prod, deployment tools run only on the mission's
  project, a foreign `teamId` is refused. GitHub: a merge is refused when the pull request's
  real base is not the declared one. Cloudflare DNS: a deletion that does not prove the record
  ordinary needs `critical-record-write`. Resend: envelope headers are refused. Stripe:
  `cancel_at*` and `auto_advance` need the stronger risk, undeclared arguments are refused,
  and `read-only` no longer covers invoices, charges or payment intents (they need
  `read-customer-pii`). Upstash Redis: every deleting command needs `delete-data`, unknown
  commands are arbitrary execution. Gmail: unbounded queries and unparseable recipients fail
  closed.
- **Deploy kit: the proxy no longer receives the gateway's secrets.** The Caddy container gets
  `GATEWAY_DOMAIN` only (it had the whole `.env`: master key, bootstrap token, IdP secret), so
  every Compose command now requires `--env-file deploy/config/.env`. Images are pinned by
  digest and the build argument `NODE_IMAGE` replaces `NODE_VERSION`. The proxy sends HSTS,
  `nosniff`, `frame-ancestors 'none'` and `Referrer-Policy: same-origin`, and
  `gateway.example.yaml` is fully commented out, so a copy no longer overrides the environment
  with placeholders.
- **Token verification throttle keyed on prefix and client address.** Failed verifications on
  `/mcp` are throttled per token prefix and client address, and a verified token's proof is
  renewed on each call: a flood of wrong secrets locks out its sender, no longer the agent
  that holds the token. Behind a proxy, set `trusted_proxies`, or every caller shares one
  address.

[Unreleased]: https://github.com/sbw-vaubaan/vaubaan-gateway/compare/v4-final...HEAD
