# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The public product name is **v2**; the repository's internal plan calls the
same work **v5** (see the pivot ADR). Tags are `v2.x.y`.

## [Unreleased]

The first release of the on-prem gateway. It replaces the earlier hosted product
(last release: tag `v4-final`) and shares no data with it: there is nothing to
migrate, an instance starts empty. The notes below describe what the gateway does;
"Changed" and "Removed" are written for a reader who knew the hosted product.

**Upgrade notes** — only for an instance that already runs a build made from the
`v5` branch:

- **Page addresses follow new words; old links keep working.** Connections are now
  under `/accounts`, the request inbox under `/waiting`, the audit under `/activity`,
  the provider reference under `/reference`, and `/` is the home. Every earlier
  address answers with a permanent redirect, a form post included. **The callback
  registered at a provider does not move**: `/connections/callback/<provider>` is still
  the URL of your GitHub App and of your OAuth apps; change nothing there. `/mcp`,
  `/mcp/manage`, `/r/<id>`, `/api/**` and `/oauth/**` are unchanged, and so are tool
  names, refusal codes, risk ids and configuration keys.
- **Sign in once before you change the identity provider.** Starting the new image
  applies schema migration `0011` (forward-only: an older image refuses to start
  on the migrated database). A user is now identified by the issuer of their
  sign-in and their subject, and the accounts that exist are bound, all at once, to
  the issuer of the first sign-in that follows the upgrade. Let one person sign in
  with the identity provider you use today; change `idp.*` afterwards if you must.
  Changing it in the same step binds every existing account to the new provider.
  There is no tool to move an account to another issuer.
- **Stray arguments are now refused.** The Cloudflare DNS, Vercel, Railway and
  Supabase plugins refuse a call that carries an argument its tool does not
  declare, naming the argument; they used to forward it or drop it. An agent that
  pads its calls with fields of the provider's own API (`target` on
  `vercel__deploy_to_vercel`, `project_id` beside `projectId`) must stop. The
  versions the plugins carry today are listed under "Added", below.
- **Railway: `deploymentId` and `threadId` are refused.** Neither can be tied to the
  mission's project, and the Railway credential reaches every project of the
  workspace, so the gateway no longer forwards them: `railway__get-logs` takes
  `serviceId` and `environmentId` and reads the latest deployment, and every
  `railway__railway-agent` call starts a new conversation. The tools no longer list
  the two arguments. The Railway plugin is `4.0.0`.
- **Railway: refresh the resources of each connection once.** A `serviceId` is
  checked against the services recorded for the mission's project at discovery; a
  project discovered by an earlier build has none recorded, and a call that names
  a service is refused until its owner refreshes the connection.
- **Revoking a connection now withdraws the access at the provider, where the
  provider allows it.** Schema migration `0012` (forward-only, one nullable column).
  For Supabase (and the experimental Gmail plugin) the gateway asks the provider to
  revoke the OAuth authorization and tells you whether it confirmed. For every other
  provider it cannot, and says so before and after: the dialog and the revoked
  connection's page tell you where to remove the access by hand — uninstall the
  GitHub App, revoke the app in your Railway account, delete the API key for Vercel,
  Stripe, Cloudflare, Upstash and Resend, remove the public key for SSH. Connections
  revoked before this build asked nothing of the provider: their page says to remove
  the access by hand.
- **Mission tokens are stored as a SHA-256 digest; tokens you already issued keep
  working.** Nothing to do, and no schema migration. A token issued by an earlier
  build is stored as an argon2id hash: it still authenticates with the same Bearer,
  and its first successful call replaces the stored hash by the digest (one `info`
  log line, `mission token moved to its sha256 digest`). Until that first call, and
  only for such a token, wrong secrets replayed on its prefix are still throttled
  (429). **Do not go back to an older image after this one has served calls**: it
  reads argon2id only and would refuse every token that has been moved or issued
  since.
- **A delegation now ends 90 days after the consent.** An application you authorized
  on the Delegations page used to stay authorized for as long as it renewed its token.
  It is now refused 90 days after you consented, whatever it renewed, and sends you to
  the consent screen again; the missions it issued are untouched. **Delegations
  granted more than 90 days ago stop at the first renewal after the upgrade.** The
  page shows the date for each. Operators set another duration with
  `oauth.delegation_max_lifetime` (`VAUBAAN_OAUTH_DELEGATION_MAX_LIFETIME`).
- **One approval request per call.** A call that touches several risks gated
  `approval` used to ask the creator once per risk, with a refused replay in between.
  It now drops one request that lists every gated risk; granting it approves the call,
  and "open the gate" opens the gate of each listed risk. The `approval-required`
  refusal carries `risk_ids` next to `risk_id`. Schema migration `0013` (forward-only).
  Requests that are open when you upgrade keep the one risk they named: granting one
  approves that risk, and a call that needs more gets a new request covering it.
- **`retention_days` also purges the session history.** The events of a mission's
  timeline older than the retention are deleted with the audit entries of the same age,
  and so are the counters of periods that ended longer ago. The counters of the current
  period, the gates opened in it and the credits granted in it are never purged. **The
  first start of this image deletes that history on an existing instance**: raise
  `retention_days` before you upgrade if you want to keep more than 90 days of it.
- **The plugin test kit proves "what is executed is what was classified" by running
  the plugin.** `assertIdentifiersRefused` feeds hostile identifiers to every string
  argument of a plugin's samples, through `classify` and through `execute`; every
  shipped plugin and the template run it, and a plugin whose tests do not is refused.
  A plugin author adds one test to `plugin.test.ts` (see `plugins/README.md`).
- **A preset never hands a write token without approval.** A plugin now declares which
  of its token-handing risks are read-only (`TokenHandout.readOnlyRiskIds`); every
  other one is treated as write, and a plugin whose preset leaves a write one on `auto`
  is refused at load. GitHub is unchanged: the Developer preset still hands the clone
  token (read-only) automatically and the push token after approval. The provider
  reference says "hands a read-only token" or "hands a write token".
- **Two connections of one provider in a mission: the refusal says why.** The rule is unchanged (one connection per provider); the message now names both connections, says that risks and budget are counted per provider, and says to issue a second mission.
- **An owner of a connection can close the missions orphaned on it.** The connection
  page lists them (name, who issued it, why) with "Close", which revokes the mission for
  good. A mission that serves is still its creator's alone.
- **The Share dialog lists the orphaned missions a share would bring back.** Sharing
  again to someone whose missions were orphaned restores those missions at once, with
  the token their agent still holds. The dialog now names them, with who issued each,
  and makes the share only once you have confirmed that list.
- **"Reset the period" on a claim resets the claimed risk only.** It used to put every
  counter of the mission back to zero, so answering a claim on one risk silently
  reopened any other exhausted risk. Each exhausted risk has its own claim. The quota
  extension is unchanged: at most what the period consumed on that risk.
- **The Audit page shows more to two people.** A **member** of a mission now reads
  that mission's entries (calls, acts, requests) for as long as they are a member.
  An **operator** now reads every entry of the instance, calls included, where they
  used to read administrative acts only. Neither is shown arguments — the audit never
  holds them — nor the fingerprint that stands for them, which stays with the
  mission's creator and the connection's owners.
- **Upstash Redis: a time to live and a move are deletions.** `EXPIRE` with any
  TTL, `SETEX`, `SET … EX`/`PX` (and `upstash_redis__set` with `ex` or `px`),
  `RENAME`, `LMOVE`, `SMOVE` and `RPOPLPUSH` now need `delete-data` next to
  `write-data`: a one-second TTL removes a key as surely as `DEL`. **A mission that
  holds `write-data` alone can no longer write a cache entry with a TTL**; add
  `delete-data`, which the Developer and Operator presets already carry. With the
  Operator preset, a TTL write on a prod database now waits for approval. The plugin
  is `3.0.0`, its catalog `5`.
- **Supabase: reading `auth`, `vault` or `storage` through SQL is a risk of its
  own.** `supabase__execute_sql` now needs `supabase[<env>].read-managed-schemas`
  on top of `supabase.read-data` when the query names a schema Supabase manages, and
  also when the gateway cannot read the query with confidence: a call to a function
  it does not know to be inert (any function of your application), `$$`, a
  parameter, a statement that is not a plain query. A mission that holds `read-data`
  alone keeps running plain queries on application tables; anything else is refused
  `risk-not-accepted` until its creator adds the risk. The **Read-only analyst**
  preset does not carry it; **Staging developer** does, on staging. Missions issued
  before this build do not hold it. The Supabase plugin is `4.0.0`, its catalog `4`.
- **Supabase missions.** A migration that changes a column type now needs
  `bulk-row-write` on top of the schema write. `supabase.row-write-one` is
  deprecated: it matches no call and grants nothing; missions and shares that name
  it keep working.
- **A sign-in can now be refused with `groups-unavailable`.** When the ID token
  carries no groups claim and the userinfo request fails, the sign-in is refused
  instead of signing the user in with no group. Sessions already open are not
  affected; trying again once the identity provider answers is the remedy.

### Added

- **A redesigned frame for the interface, and one vocabulary.** A short side navigation
  replaces the top bar: Now, Waiting for you (with the count of what waits), Missions,
  Accounts, Activity, Reference, then Settings, with your name and the theme at its
  foot; it collapses to its icons in a narrow window. Administration is part of
  Settings and keeps the same navigation. The interface now says _account_ for a
  connection, _permission_ for a risk, _key_ and _machine key_ for a mission token and
  a named token, _limits_ for quotas and rate limits, _runs freely_ / _ask me first_
  for the gate, _connected app_ for a delegation, _teammate_, _administrator_ and
  _team_; _mission_ and _preset_ stay. This release delivers the frame, the words of
  the navigation and the page titles; the content of each page keeps its earlier
  wording until that page is redesigned.
- **Light and dark themes.** Light by default; a toggle at the foot of the navigation,
  and Settings, choose among System, Light and Dark. The choice is kept in a cookie
  (`vaubaan_theme`, a display preference and nothing else) so that a page never
  flashes in the other theme while loading.
- **An interface reference at `/design`** (linked from Settings): every component of
  the interface in every state, in both themes, with invented data.

- **The execution door.** `POST /mcp` takes a mission token: `tools/list` shows the tools
  of the providers the mission holds a connection and an accepted risk for; `tools/call`
  checks the mission's state, its resources, that the risks the call touches are among the
  accepted ones, the budget, the rate limit and the gate, calls the provider with a
  credential decrypted for that call only, and writes one audit entry, allowed or refused.
  Stateless Streamable HTTP (`@modelcontextprotocol/server` 2.3), plain JSON unless the
  call asked for progress, rate limited per mission (`mcp.rate_limit_per_minute`, 600).
  `GET /mcp/catalog` returns what the mission can call, its resources with their
  environment labels, what is left of each quota, whose token is presented and who
  created the mission.
- **Eight structured refusals.** `risk-not-accepted`, `budget-exhausted`,
  `approval-required`, `resource-not-in-mission`, `rate-limited`,
  `connection-unavailable`, `mission-inactive` and `wrong-credential-kind` reach the
  client whole: a JSON-RPC error whose `data` carries the code, its fields (claim URL,
  approval URL, allowed resources…) and a hint an agent can act on. The gateway never
  holds a call waiting.
- **Missions.** A connection owner issues a mission on one page: name, connections and
  resources, a preset or a custom policy per connection, per-risk quota, rate limit and
  gate, a period and an optional expiry, with a can / cannot / quantities summary. A
  preset says on the page what it allows without asking, what waits for approval and what
  it leaves out; **Custom** opens every risk the owner holds, grouped into reads, writes
  and irreversible writes, with a search box and the reason for what cannot be accepted.
  What a mission stores is always the explicit list of risks with their budgets, never a
  preset and never "all". A mission can start from a duplicate or from a JSON proposal an
  agent wrote. Issuance refuses anything beyond the owner's authority, and the preview
  warns when a selected resource has no usable environment label.
- **Mission tokens, members and the bootstrap kit.** A mission has one or more tokens
  (`vbn_live_…`, stored as a SHA-256 digest), each with one holder. The creator adds
  colleagues as **members**; each generates their own token, shown once with the
  bootstrap kit — the creator never sees it — and the creator creates **named tokens**
  for a CI runner or a shared machine. Every token shares the mission's resources, policy
  and **one budget**. A member uses the mission as it is and manages only their own
  token; the creator can revoke any token and remove a member. The kit holds the
  environment variable, an `.mcp.json` that references it, instructions for each refusal
  and a `curl` check; `/agent-bootstrap.md` documents the same for any agent.
- **A token that stops says why.** A token that was rotated or revoked, or whose holder
  was removed from the mission or deactivated, is answered HTTP 401 with
  `error.data.reason` (`token-rotated`, `token-revoked`, `holder-removed`,
  `holder-deactivated`) at the next call, while the mission keeps serving its other
  holders.
- **Budget, sessions and rate limits.** A call touching several risks decrements all
  their counters in one transaction, or is refused whole. Periods roll over on read; a
  one-off mission has a single open-ended period. The credit of an allowed call is not
  refunded when the provider fails. Rate limiting is in memory, for a single process.
- **Claims and the request inbox.** The URL a `budget-exhausted` refusal carries,
  `<public_url>/r/<id>`, asks for a sign-in and lets only the mission's creator through.
  The creator resets the period, gives back up to what was consumed, extends the expiry,
  or refuses; the token does not change and the agent replays its call. "Requests" lists
  what awaits you; unanswered requests expire after `requests.expiry` (24 h by default),
  on an orphaned mission too.
- **The approval gate.** A call touching a risk gated `approval` is refused
  `approval-required` with the URL of an approval request. The creator — and nobody else,
  operators included — reads the tool, the arguments in clear, the slices touched and
  what is left of every risk the call counts against, then approves that one action,
  opens the gate for the rest of the period, or refuses. An approval is bound to the
  mission, the risk, the tool and the fingerprint of the arguments, is used once and
  expires after `approvals.expiry` (10 minutes by default). The arguments are kept
  encrypted while the request is open and erased when it is decided or expires. The
  creator can switch the gate of an accepted risk between `auto` and `approval` after
  issuance, on an expired mission too; setting it back to `approval` ends an opening
  granted earlier in the period.
- **Agent labels: who did what, when several agents work on one mission.** An agent may
  label its calls with the `X-Vaubaan-Agent` header or, per call, with `_meta.agent`
  (which wins when both are sent). A label is 1 to 64 characters — letters, digits and
  `. _ - : / @ +`, starting with a letter or a digit; anything else is ignored, the call
  is served without a label and the gateway logs why. A label is attribution, never a
  credential and never a budget. The bootstrap kit tells an orchestrator to hand its MCP
  configuration to its sub-agents as it is.
- **The management door: an agent prepares a mission for a user.** The instance is an
  OAuth authorization server for `/mcp/manage`: an MCP client discovers it (RFC 9728 and
  RFC 8414 metadata), registers, and sends the user to sign in and to a consent screen
  that names the application as a claim, the single scope `mgmt`, what it covers and
  never covers, and where the access goes. Authorization code with PKCE `S256` only;
  opaque access tokens (15 minutes by default) and single-use rotating refresh tokens
  (30 days), stored as digests; a token grant is one transaction. A refresh token or a
  code presented twice revokes the whole delegation — except the refresh token rotated
  last, presented again by the same client within `oauth.refresh_reuse_window_seconds`
  (30 by default). Behind the consent the door offers seven tools
  (`list_my_connections`, `get_catalog`, `list_my_missions`, `preview_policy`,
  `issue_mission`, `rotate_mission_token`, `revoke_mission`), each with an output schema,
  each acting as the delegating user within their current authority. The door cannot
  answer a request, open a gate, extend a budget, touch a connection, a share or a group,
  or call a provider tool, and it rotates the token only of the missions it issued.
  Missions issued this way are marked with the application that issued them.
- **Delegations and OAuth clients.** A user sees the applications they authorized, where
  each sends its access and the missions it issued, and revokes one in a click.
  `oauth.client_registration.policy` is `open`, `operator-approved` (default) or
  `closed`; under the default a client that can only return to the user's own machine
  needs no approval, any other waits for an operator under Administration → OAuth
  clients, where a client can also be disabled, which revokes its delegations. Client ID
  Metadata Documents are supported and off by default.
- **Three credentials that never cross.** A mission token opens `/mcp` only, a delegated
  token `/mcp/manage` only, a browser session the interface only; each is refused with
  `wrong-credential-kind` at the other two, naming the door that accepts it.
- **Sign-in through your identity provider.** Any OpenID Connect provider signs people
  in (discovery, PKCE, state and nonce, configurable `sub` / `email` / `groups` claims,
  optional allowed email domains). A user is the pair (issuer, subject). Groups claimed
  by the identity provider are replaced at every sign-in; local groups are untouched.
  Sessions are server-side, 8 hours at most, behind a `__Host-` cookie, with an origin
  check on every mutation.
- **Bootstrap and administration.** `/admin/bootstrap` accepts the configured bootstrap
  token while no identity provider is set; the first operator sign-in revokes it.
  Afterwards the operator is whoever matches the admin rule, recomputed on every request.
  Administration holds the identity provider, the provider apps, local groups, users,
  OAuth clients, ownerless connections and telemetry.
- **Connections and resources.** A signed-in user connects a provider through one
  generic driver for the four credential kinds (`oauth2`, `app-install`, `api-key`,
  `ssh-key`). A connection is `active`, `expired`, `revoked` or `unowned`; the gateway
  refreshes OAuth tokens itself, so a plugin never sees the client secret. Plugins
  discover resources at connect time and on "Refresh discovery"; the owner renames them,
  labels their environment and hides them, and those edits survive a new discovery.
- **Provider apps.** Operators register each provider's app under Administration →
  Provider apps (secrets encrypted in the store) or under `providers.<id>` in the mounted
  configuration, which wins and makes the page read-only for that provider.
- **Shares, groups and ownership.** The owner of a connection shares it with a user or a
  group: a target, then a checklist of the provider's risks. "Select all" ticks today's
  risks one by one; what is stored is that list, and a risk added to the catalog later
  is not shared. Several shares of one connection add up. An owner transfers a
  connection to a group they belong to. When the owner group has no member left the
  connection is `unowned`: it keeps serving the missions that still have grounds, and
  the operator names a new owner — their only act on connections.
- **Orphaned missions, for as long as the authority is missing.** A mission whose creator
  no longer covers its accepted risks — a share revoked or narrowed, a connection
  revoked, a group left, the creator deactivated — refuses every call with
  `mission-inactive` (`orphaned`). The state is computed from the creator's current
  authority each time it is read: when the authority comes back, the same mission serves
  again with the same tokens and counters. A revoked connection never comes back. The
  mission page says why, and the Audit shows the acts that orphaned and restored it.
- **Operators can deactivate a user** (Administration → Users): no sign-in, sessions
  ended, delegated applications cut off, the user's missions refused, their tokens on
  other people's missions revoked, their connections handed back for reassignment —
  without waiting for the identity provider. Reactivating first closes anything a failed
  deactivation left open.
- **Audit search and retention.** `/audit` has ten filters in three groups — what, who
  and when — among them the mission, the connection, the tool, the decision, the agent
  label, the token holder and the period; entries are listed newest first. A user sees the
  entries about their missions and the connections they or their groups own; an operator
  also sees every administrative entry; nobody sees arguments, only their hash (SHA-256
  of the canonical JSON, the same value as the approval fingerprint). Every mutation
  leaves an administrative entry. Entries older than `retention_days` (90 by default)
  are purged at start and then hourly.
- **The Mission session page.** Counters per risk and per period with what is left, the
  gate of each risk, the open requests, the calls of the current period per agent label
  and per token holder (counts for information: the budget stays per risk and shared),
  and the event timeline, which can be narrowed to one label or one holder and says what
  each gate and approval event did.
- **A provider reference inside the interface.** "Providers" lists the plugins of the
  instance; each has a page generated from the plugin itself: what it connects to in
  plain words, then four tabs. **Presets** side by side as a table (one column per
  preset, one row per risk, each cell the quota, rate limit and gate); **Risks** as
  compact rows grouped into reads, writes and irreversible writes, each unfolding for
  its reason, its six-axis profile, whether it is accepted once or per environment and
  what it matches; **Data model** as an outline; **Tools** as a dense table. A provider
  whose model has several planes (Supabase: db, storage, auth, functions) gets a plane
  control that narrows every tab at once. Every risk id shown on a mission, a request, a
  share or a connection links to its entry.
- **One way to read a risk, a name and a help text.** On every page a risk is three
  lines: its label, its id with one line of reason that unfolds, and a six-cell strip for
  its profile. Risks, presets, tools, data-model planes, resources, connections,
  missions, people and tokens each have one colour and one glyph, the same everywhere;
  severity, gates and statuses keep their own marks. Explanatory text is one line with a
  "More" button, closed by default and remembered per browser.
- **Streamed tool results.** A plugin whose provider answers progressively can hand the
  parts of its result to the gateway as they arrive (`ExecuteContext.emitPart`,
  `streamToolResult`, `textParts`); an MCP client that sent a progress token receives
  each part as a progress notification, then the complete result. The decision and the
  budget decrement always come before the first byte. No shipped plugin streams yet.
- **Community telemetry (opt-in).** Off at installation. An operator enables it on
  Administration → Telemetry, which shows the exact payload first: plugin, plugin
  version, gateway version, tool, outcome (`success`, `upstream-error`,
  `classification-error`, `execution-error`) and a fixed-vocabulary error class — never
  arguments or their hash, resource refs, mission or user identifiers, an instance
  identifier, an address or a provider's message. The built-in collector URL is a
  placeholder: nothing is sent until `telemetry.collector_url` names a real collector.
  `deploy/collector/` ships the collector's SQL; no collector is deployed.
- **Embedded store and encryption at rest.** SQLite (`better-sqlite3`, `STRICT` tables,
  WAL) with forward-only migrations applied at start (schema version 11) and an
  append-only audit enforced by triggers. The gateway refuses a database newer than the
  image. Credentials are encrypted with XChaCha20-Poly1305 under a key derived per
  connection from the master key; `npm run gen-master-key` generates one.
- **Configuration.** The gateway starts from `VAUBAAN_*` variables and/or a mounted YAML
  file (`VAUBAAN_CONFIG_FILE`, the file wins key by key; `${NAME}` / `${file:/path}`
  secret references, `*_FILE` variables). A missing or invalid key stops the process
  with exit code 78 and a message naming every key and its variable.
- **Docker image and deploy kit.** `deploy/docker/Dockerfile` (Debian slim, non-root,
  `/data` volume, healthcheck, no `.env*` file and no test file in the image),
  `deploy/compose.yaml` with a Caddy TLS proxy that sends the security headers and
  receives none of the gateway's secrets, base images pinned by version and digest, and
  documented examples of the configuration. `GET /healthz` answers; the version and the
  commit are in the footer of every page, the consent screen included; logs are JSON
  lines with token-prefix and secret redaction.
- **Releases.** Pushing a tag `v2.x.y` is meant to publish the image for `linux/amd64`
  and `linux/arm64` to `ghcr.io/sbw-vaubaan/vaubaan-gateway` with an SBOM and a signed
  build-provenance attestation, and to create the GitHub release from this file. What a
  version number promises — configuration keys, refusal codes, the plugin contract,
  catalog ids — is written in `docs/workflow/coding-workflow.md`; pulling and verifying
  an image in `deploy/README.md`.
- **`npm run demo`: the whole interface in your browser, nothing to register.** One
  command starts the real application on `http://localhost:3210` with a demo identity
  provider (an account picker, no password), simulated GitHub, Stripe, Cloudflare DNS,
  Resend, Upstash Redis and Vercel, and seeded connections, shares, missions in every
  state, open requests and audit entries; it prints a tour with ready-made `curl`
  commands. It builds the application on the first start and again only when the
  sources changed. Development only: it refuses a production environment, is not part
  of the image, binds the loopback interface and deletes its data on exit.
- **Plugin SDK and test kit.** `@vaubaan/plugin-sdk`: the `ProviderPlugin` contract and
  `definePlugin()`, the four credential specs, the registry every provider list derives
  from, the optional `envOf` hook, `summary` and `tokenHandouts` for the provider
  reference, `UpstreamHttpError` for a provider failure, and — for what an executor
  declines by itself — `ExecutorRefusal`, `declining()` and `refusalResult()`.
  `undeclaredArgumentDenial()` closes the argument surface of a tool; `identSegment()`
  writes an identifier into a slice, or "any" when the slice grammar cannot carry it;
  `NO_SINGLE_ENV` is what an `envOf` returns when a call names several environments.
  Each plugin ships a `risk-catalog.yaml` with presets and exactly one fallback entry.
  The test kit provides `mockFetch`, `assertPluginWellFormed`, `assertCatalogCoverage`
  (which also checks that every sampled slice reads back as itself), `assertNoWildcard`,
  `assertPresetsValid`, `declaredOnly` and `refusalText`. `plugins/_template` is the
  scaffold and `plugins/README.md` the step-by-step guide.
- **Ten provider plugins.**
  - **GitHub** `3.0.0` — a company GitHub App; a per-call installation token scoped to
    the repository; one resource per repository. Presets `read-only`, `developer`,
    `release-manager`.
  - **Vercel** `3.0.0` — access token and team id; one resource per project; the
    environment is read from the call. Presets `read-only`, `developer`, `operator`.
  - **Supabase** `4.0.0` — OAuth against the Management API; resources from the
    account's projects; env-scoped write risks; `execute_sql` on the read-only endpoint.
    Presets `read-only-analyst`, `staging-developer`, `migration-operator`.
  - **Railway** `4.0.0` — OAuth with PKCE; one resource per project with its
    environments and services. Presets `read-only`, `developer`, `operator`.
  - **Cloudflare DNS** `3.0.0` — a zone-scoped API token; one resource per zone; record
    writes split into ordinary, critical (apex, wildcard, MX, NS) and deletion. Presets
    `read-only`, `dns-operator`, `zone-admin`.
  - **SSH** `2.0.0` — an ed25519 pair generated by the instance and a pinned host key;
    `ssh__exec` classified by a shell lexer; a line it cannot see through is never a
    read. Presets `read-only`, `developer`, `operator`.
  - **Upstash Redis** `3.0.0` — account email and Management API key; one resource per
    database; every Redis command in exactly one class. Presets `read-only`,
    `developer`, `operator`.
  - **Stripe** `0.4.0` — optional test and live keys, one resource per mode, every risk
    scoped on the mode. Presets `read-only`, `test-mode-developer`, `finance-operator`.
  - **Resend** `0.3.0` — one resource per sending domain and per segment; sends are
    rooted at the `from` domain and classified by recipient zone. Presets `read-only`,
    `developer`, `marketing-operator`, `domain-admin`.
  - **Gmail** `0.3.0`, experimental — classifier only: no tool is exposed.
- **Project files.** `LICENSE`, `CONTRIBUTING.md` (from a fresh clone to a pull
  request), `CODE_OF_CONDUCT.md`, `SECURITY.md` (private reporting, scope, trust model),
  four issue forms and a pull request template; `docs/handbook/threat-model.md` lists
  the actors, the controls and the test behind each; `docs/handbook/known-limitations.md`
  lists what has not been done.

### Changed

- **Licence.** Changed from proprietary to **Apache-2.0**. The last release of the
  earlier hosted product is tag `v4-final`.
- **One instance per company, on your network (breaking).** The gateway is a single
  process with an embedded store, behind your identity provider and your own provider
  apps. There is no hosted service, no organization or project tenant, and no data is
  carried over from the hosted product.
- **`/mcp` accepts mission tokens only (breaking).** The door re-reads the token, the
  mission and the creator's authority on every call. It answers no CORS and refuses a
  browser `Origin` other than the instance's own.
- **A budget and a gate per accepted risk.** A token of the hosted product carried a
  list of accepted risks; a mission stores each accepted risk with a quota, a rate limit
  and a gate. The fallback risk `<provider>.uncategorized-write` is touched only when no
  other catalog entry matches a write; in an audit log it means a catalog entry is
  missing.
- **Scope caps are not enforced in 2.0.** The execution door has no cap stage, so a
  shipped catalog declares only the limit the gateway enforces, the rate ceiling
  (`infra_limits.calls_per_minute_max`). A mission bounds a risk with its quota, rate
  limit and gate (ADR `scope-caps-not-enforced-in-v5-0`).
- **Only a 401 from a provider counts as a rejected credential.** The gateway then
  refreshes and retries once; a rejected refresh turns the connection `expired` and the
  agent reads `connection-unavailable`. A 403 is a failed call and leaves the connection
  alone. A revoked connection orphans its missions (`mission-inactive`).
- **Plugins throw provider failures and return their own refusals.** A provider failure
  is thrown with its HTTP status, so the audit summary and the telemetry class read
  `upstream-error` / `http_<status>`; what an executor declines by itself is an error
  result carrying a sentence the agent can act on.
- **Catalog versions.** `catalog_version` is 4 for GitHub, Stripe and Upstash Redis, 3
  for Supabase, Railway, Resend, SSH and Gmail, 2 for Vercel and Cloudflare DNS. Resend's
  `read-audiences` / `audience-write` are deprecated in favour of `read-segments` /
  `segment-write`; Supabase's `row-write-one` is deprecated with no successor. A
  deprecated id stays resolvable in the missions and shares that name it.
- **For contributors and plugin authors.** The application is `apps/gateway`, the
  libraries are under `packages/`, each provider is `plugins/<provider>`
  (`@vaubaan/plugin-<provider>`). Next.js 16 with React 19 and zod 4. The documentation
  is in English and describes what the code does: specification, decisions, one handbook
  per subsystem and per provider, test plans, workflow; documents of the hosted product
  are kept under `legacy/` folders. `npm run test:e2e` builds the application and drives
  the standalone server the image runs, with a simulated identity provider and a mocked
  provider; CI installs with `npm ci` and pins every action by commit.

### Removed

- **The hosted application (breaking).** The organization / project / token pages, the
  marketing site, `/api/v1/**`, `/api/integrations/**`, the Supabase-backed gateway and
  the dependencies only they used.
- **Hosted infrastructure.** Supabase migrations and configuration, `vercel.json`, and
  the scripts that only served them.
- **Earlier plugin surface.** The GitHub personal-access-token path, the `venv` tools of
  Supabase and Vercel, the Cloudflare Global API Key (refused), and the annotated-script
  module of the SSH plugin: `ssh__exec` and its classifier are its only surface.
- **The Redis cache client.** The gateway has one bounded, in-process cache; nothing
  depends on an external cache.

### Security

- **What is executed is what was classified.** Every plugin validates each identifier
  with one grammar used by its classifier and its executor, and refuses what does not
  fit instead of escaping it (a path with `..`, a tag written `refs/tags/…`, a recipient
  list inside one address string). The plugins that forward arguments to the provider —
  Cloudflare DNS, Vercel, Railway, Supabase — refuse an argument the tool does not
  declare, in the classifier and again in the executor. An identifier the slice grammar
  cannot carry is classified as "every instance", never dropped.
- **Plugin classifiers fail closed.** What a classifier cannot place is refused or costs
  the stronger risk. SSH: a line with substitutions, here-documents, inline interpreters
  or unknown wrappers needs every class. Supabase: on prod a migration is limited to
  plain DDL and RLS; unreadable SQL needs every write class; what follows a `--` comment
  ended by a carriage return is read; a column type change is a bulk row write. Railway:
  an `environmentId` and a `serviceId` must belong to the mission's project. Vercel:
  thread tools are refused, a deploy is always prod and takes no `target`, deployment
  tools run only on the mission's project, a foreign `teamId` is refused. GitHub: a
  merge is refused when the pull request's real base is not the declared one. Cloudflare
  DNS: a deletion that does not prove the record ordinary needs `critical-record-write`.
  Resend: envelope headers are refused. Stripe: `cancel_at*` and `auto_advance` need the
  stronger risk, and `read-only` does not cover invoices, charges or payment intents.
  Upstash Redis: every deleting command needs `delete-data`, unknown commands are
  arbitrary execution, and the database token is posted to `https://<name>.upstash.io`
  only. Gmail: unbounded queries and unparseable recipients fail closed, and a
  `no-reply@` sender is "automated" only on a domain the owner listed.
- **The environment of a call is never resolved in the caller's favour.** A call
  touching an env-scoped risk on a resource whose environment the risk is not acceptable
  in — an unlabelled resource, a free-text label, prod for a staging-only risk — is
  refused with `risk-not-accepted`. A call that names several environments, or resources
  of different environments, resolves to none, and an identifier containing `*` is
  refused instead of being read as a pattern. Owners label resources on the connection
  page for env-scoped operations to run.
- **Every refused call is audited, including the one a failing stage refuses.** When the
  resource, risk or budget stage throws (a classifier bug, a store error) the call is
  refused, nothing is counted or sent, and the audit entry names the stage and the error
  class — never the error text, which may quote arguments; the detail is in the instance
  log at `error`. The audit copy of any refusal reason holds no argument value, and a
  provider's error text goes to the calling agent only.
- **A user is the pair (issuer, subject).** A subject reused by another identity
  provider is another person: pointing the instance at a different provider cannot hand
  an existing account, with its connections and missions, to whoever carries the same
  subject there.
- **A sign-in whose groups could not be read is refused** (`groups-unavailable`) instead
  of removing the user from every group. So is a sign-in whose groups the provider moved
  out of the token (Entra ID above its group limit, `groups-overage`) and one whose
  email is marked unverified.
- **A token is issued only to somebody who is on the mission at that instant.** The
  insert re-checks the mission and the holder in its own transaction: a removal, a
  deactivation or a revocation that lands while the token is being generated leaves no
  working token. A member added again starts with no token.
- **A request is decided on the mission as stored at that instant**, and an operator
  reassigns only a connection that is ownerless at the write: both checks are in the
  transaction that writes.
- **An approval is bound to the tool it was read for**: the same arguments sent to
  another tool touching the same risk ask again. A call whose arguments are not JSON
  values (`1e999`) is rejected before any stage, because the approver would have read
  something else.
- **A GitHub App must request user authorization.** Enable "Request user authorization
  (OAuth) during installation", register the gateway callback as the App's callback URL,
  generate a client secret, and add `client_id` / `client_secret` to the provider app.
  The gateway connects an installation only when the person installing can reach it;
  without these settings GitHub is reported `incomplete` and cannot be connected. A
  plugin of the `app-install` kind without such a verification is refused unless an
  operator accepts unverified installations for it (off by default, audited).
- **The admin rule counts groups claimed by the identity provider only.** A local group
  never makes its members operators, and cannot take the name of the admin rule's group.
- **Every page authenticates itself.** Each page and route checks the session instead of
  relying on a layout, every mutating handler passes one origin, session and role guard,
  and a session opened with a revoked bootstrap token is nobody. Return addresses of the
  sign-in and connect flows cannot leave the instance.
- **Sessions and tokens at rest.** The session cookie is `__Host-vbn_session`, which a
  sibling subdomain cannot plant; session rows are keyed by the SHA-256 of the session
  id and mission tokens by a SHA-256 digest, so a copy of the database holds no usable
  credential.
- **The management door checks the client on every request.** A delegated token stops
  working as soon as its client is disabled or no longer approved under the registration
  policy. Token-endpoint limits are spent only by a caller that proved something:
  knowing a `client_id` is not enough to exhaust a client's budget. Client ID Metadata
  Documents are never fetched from private, loopback, link-local or site-local
  addresses.
- **Wrong secrets on a token's prefix never hold its agent.** A mission token is stored
  as a SHA-256 digest: a wrong secret on `/mcp` is answered 401 at once, nothing is
  throttled and nothing about a verification is remembered, so a rotation or a
  revocation is seen by the next call. The one exception is a token issued by an earlier
  build and not used since (see the upgrade notes): its check is throttled per prefix
  and client address. Behind a proxy, set `trusted_proxies`, or every caller shares one
  address for the address-keyed limits; the instance warns at start when it is empty.
- **No telemetry reaches the placeholder collector, whatever is appended to its URL**,
  and a call its caller abandoned is not reported at all.
- **The image and the pipeline.** The image holds what the server needs and nothing
  else: no test file, fixture or simulated identity provider, and a test and the
  container smoke fail if one returns. Base images are pinned by digest and the build
  pulls no unpinned frontend. CI and releases are gated by a dependency audit with a
  reviewed allowlist: every advisory above `low` fails unless allowlisted for that
  package with a review date, and an audit that printed nothing is a broken gate, not a
  pass.

[Unreleased]: https://github.com/sbw-vaubaan/vaubaan-gateway/compare/v4-final...HEAD
