---
title: Cutover from the v4 SaaS — what to prepare, the checklist, the live checks
status: current
date: 2026-10-13
last_synced: 2026-10-13
tracks:
  - deploy/compose.yaml
  - deploy/config/
  - apps/gateway/src/server/missions/bootstrap-kit.ts
  - apps/gateway/tests/e2e/v5/cutover-smoke.spec.ts
  - plugins/github/src/credential.ts
---

# Cutover from the v4 SaaS — what to prepare, the checklist, the live checks

The procedure to move the one real user of the v4 SaaS onto a v5 instance and
switch v4 off. There is no coexistence, no export / import and no migration
code (ADR
[pivot-v4-to-v5-on-prem-mission-tokens](../decisions/pivot-v4-to-v5-on-prem-mission-tokens.md)
D7): connections are re-created by hand, one mission is issued per code
project, each project's `.mcp.json` is repointed, and v4 is extinguished once
every project has moved.

The scenario and its pass criterion are in
[e2e-tests](../tests/e2e-tests.md#cutover-acceptance-scenario-manual). This
page is the working document: tick the boxes as you go.

**State on 2026-10-13: nothing below has been run.** The automated smoke that
precedes it is green; every step that needs a real identity provider, a real
provider or Claude Code is still to be done, by the instance owner.

## 1. What to prepare

Everything in this section is registered under **your own accounts**: the v5
instance uses apps the company owns, never the ones the v4 operator held.
`<public_url>` is the https origin of your instance.

### 1.1 The instance

- [ ] A host with Docker and Compose v2, a DNS name pointing at it, ports 80
      and 443 reachable. **TLS in front is not optional**: `public_url` must be
      https or the container exits with code 78 (`public_url: must use https`).
      `deploy/compose.yaml` ships Caddy, which obtains the certificate; with
      another reverse proxy, append the client address to `X-Forwarded-For`,
      do not buffer responses, and list the proxy in `trusted_proxies`
      ([deploy/README](../../deploy/README.md)).
- [ ] An image built from a tagged commit on which the CI job `e2e` (the
      cutover smoke) is green.
- [ ] A master key (`npm run gen-master-key`) and a bootstrap token
      (`openssl rand -hex 24`), kept outside the repository.
- [ ] `telemetry.enabled: false` (the default).

### 1.2 The identity provider

- [ ] An **OIDC client** at your identity provider (Google or Entra ID), type
      web application, with the redirect URI **`<public_url>/auth/callback`**.
      Note the issuer URL, the client id and the client secret.
- [ ] The **admin rule** in the configuration: `admin.emails` and/or
      `admin.group`. It is required at boot.
  - **Entra ID: use `admin.emails`.** Entra emits groups as object ids unless
    the app registration is configured to emit names, so
    `admin.group: gateway-admins` matches nobody. Either list your email, or
    put the group's object id in `admin.group`.
  - **Google: use `admin.emails`.** Google emits no groups claim.
- [ ] Decide where the IdP settings live: entered on Administration → Identity
      provider after signing in with the bootstrap token (stored encrypted), or
      in the mounted configuration (`idp.*`; the Admin page is then read-only
      and no bootstrap token is needed).

### 1.3 One app per provider that needs one

The URL to register at each provider is shown on Administration → Provider
apps: `<public_url>/connections/callback/<provider>`.

- [ ] **GitHub — a GitHub App of your own** (Settings → Developer settings →
      GitHub Apps → New GitHub App).
  - Permissions: Contents (read & write), Pull requests (read & write), Issues
    (read & write), Metadata (read), Actions (read), Administration (read &
    write, for branch protection), Workflows (read & write, for pushes
    touching `.github/workflows/`).
  - Under "Identifying and authorizing users": tick **Request user
    authorization (OAuth) during installation**, and set the **Callback URL**
    to `<public_url>/connections/callback/github`. With that box ticked GitHub
    offers no setup URL. Keep "Expire user authorization tokens" on.
  - Generate a **private key** and a **client secret**.
  - Five values go into the instance: `app_id`, `app_slug`, `private_key`
    (PEM), **`client_id`** (the App's client ID, not its App ID) and
    **`client_secret`**. Until the last two are set GitHub is shown
    `incomplete` and cannot be connected: the gateway refuses to connect an
    installation it cannot bind to the person who installed it.
- [ ] **Supabase — an OAuth app** in your organization (dashboard →
      organization → OAuth Apps), redirect URL
      `<public_url>/connections/callback/supabase`, with the scopes the tools
      need (`database:read`, `database:write`, `secrets:read`, and `auth`,
      `storage`, `edge_functions`, `environment`, `organizations`, `projects`).
      Client id and secret.
- [ ] **Railway — an auth app** (Workspace → Developer → Auth apps → New app),
      Device Flow off, redirect URI
      `<public_url>/connections/callback/railway`. Client id and secret.
- [ ] **Google — an OAuth client**, only if you connect Gmail (Google Cloud
      Console → Credentials → OAuth client ID, web application, Gmail API
      enabled), redirect URI `<public_url>/connections/callback/gmail`. The
      Gmail plugin is experimental and exposes **no tool** today: connecting it
      is not part of the acceptance set.

Provider apps can be entered on Administration → Provider apps (stored
encrypted) or mounted as `providers.<id>.*` / `VAUBAAN_PROVIDER_<ID>_<FIELD>`;
a mounted block wins for the whole provider and makes its card read-only.

### 1.4 Keys for the providers that need no app

- [ ] **Vercel** — an access token scoped to the team, and the team id
      (`team_…`).
- [ ] **Resend** — a **full-access** API key. A sending-only key is refused at
      connect time: discovery lists the domains, which such a key cannot read.
- [ ] **Stripe** — a secret or restricted key for test mode and/or for live
      mode; one connection holds both.
- [ ] **Cloudflare DNS** — an API token (the Global API Key is not accepted).
- [ ] **Upstash Redis** — the account email and a management API key.
- [ ] **SSH** — host, login user and the host key fingerprint; the instance
      generates the key pair and shows the public key to install.

### 1.5 The inventory

Fill this in before starting; it is the acceptance set ("every provider you
have a v4 connection for today") and the list of missions to issue.

| v4 connection (provider, account) | Needed by which code projects | v5 app or key ready | Connected on v5 |
| --------------------------------- | ----------------------------- | ------------------- | --------------- |
|                                   |                               |                     |                 |
|                                   |                               |                     |                 |

| Code project (path) | Providers and resources it needs | v5 mission | `.mcp.json` repointed | Verified |
| ------------------- | -------------------------------- | ---------- | --------------------- | -------- |
|                     |                                  |            |                       |          |
|                     |                                  |            |                       |          |

## 2. Known limits at M1

What the instance ships differs from v4 and from the full spec in ways that will
show during the day. None of these is an unexpected refusal; all of them are
listed again, as questions, in the [appendix](#appendix--decisions-to-confirm).

- **Some entries of the `developer` presets ask you each time.** They are
  gated `approval`: `github.workflow-write-via-file`,
  `github.mint-install-token-push`, `railway[prod].deploy` and
  `railway[prod].upsert-variable`. A call touching one is refused
  `approval-required` with a URL; you open it (or find it in **Requests**),
  read the tool and the arguments, and approve — the agent then replays the
  same call within ten minutes (`approvals.expiry`). If one of them comes up
  all day — pushing with a minted token is the likely one — choose "Open the
  gate for the rest of the period" on the request, or set the gate to `auto`
  on the mission page; either is a decision to write down in the log
  ([requests](requests.md), "Approvals").
- **Supabase has no `developer` preset.** Its presets are
  `read-only-analyst`, `staging-developer` and `migration-operator`.
  `staging-developer` writes on resources labelled `staging` only: label your
  projects' environments on the connection page first, or every write is
  refused `risk-not-accepted`.
- **Environment labels decide what a preset contains.** An env-qualified
  entry (`supabase[staging].…`, `railway[prod].…`) is issued only when a
  selected resource carries that label (Vercel derives it from the call).
  Unlabelled resources silently narrow the mission: read the "left out" line
  under the preset.
- **The agent names its resources.** v4 filled `owner` / `repo`, `projectId`,
  `project_ref` in when a token had a single binding; v5 does not. The
  bootstrap kit's agent instructions list the refs; a call without them is
  rejected by the classifier (`Vaubaan rejected the call: …`, no refusal
  code).
- **The tool list is per provider, not per tool.** Every tool of a provider
  the mission holds is listed; a tool whose risk the mission does not accept
  is refused `risk-not-accepted` when called.
- **One connection per provider per mission.** Two GitHub connections in one
  mission are refused at issuance (`duplicate-provider`).
- **Tools that are gone**: the `*_to_venv` tools (Supabase, Vercel), the
  GitHub personal-access-token path. Supabase `execute_sql` and the `list_*`
  tools go to the read-only endpoint.
- **A quota extension is capped at what was consumed** in the period (quota
  5, consumed 5 → at most 5 more), and "Reset the period" resets every risk of
  the mission. A larger quota means a new mission: there is no edit screen,
  "Duplicate" pre-fills the form, and the duplicate has its own token.
- **Not built**: the stateless caps of the catalogs (items or bytes per call).
  No shipped catalog declares one any more and the door applies none
  ([scope-caps-not-enforced-in-v5-0](../decisions/scope-caps-not-enforced-in-v5-0.md)).
- **A provider 403 is a failed call**, not a dead credential: only a 401
  triggers the refresh and, if that is rejected, turns the connection
  `expired`.

## 3. Checklist

Preconditions: section 1 done; v4 untouched and serving.

### A. Validation (v4 stays on)

- [ ] **A1 — Deploy.** Image on the host, `/data` mounted, configuration
      provided (master key, `public_url`, admin rule, bootstrap token, telemetry
      disabled). `curl -s <public_url>/healthz` answers `"status":"ok"` with the
      expected version and commit.
- [ ] **A2 — Identity provider.** Open `/admin/bootstrap` with the bootstrap
      token; configure the IdP on Administration → Identity provider; "Test
      login" shows your email and Operator "yes (matches the admin rule)"; sign in through the IdP;
      `/admin` shows the bootstrap token as revoked.
- [ ] **A3 — Provider apps.** Enter each app of §1.3 on Administration →
      Provider apps; every card reads `configured` (GitHub also reads
      `installations verified`).
- [ ] **A4 — Connect each provider** of the inventory. Each ends `active`
      with its resources. **Live checks L1, L2 and L3 happen here** (§4).
- [ ] **A5 — Label environments** on the connection pages (Supabase and
      Railway projects: `staging`, `prod`), hide what no mission should see.
- [ ] **A6 — Issue one mission per code project**: its connections, the
      resources of that project only, the plugin's developer preset
      (`developer` for GitHub, Vercel, Railway; `staging-developer` for
      Supabase), recurring daily period, **no expiry**. Read the three-line
      summary and the "left out" lines. Copy the bootstrap kit — the token is
      shown once.
- [ ] **A7 — Repoint the project.** Export `VAUBAAN_MISSION_TOKEN` where
      Claude Code will read it, replace the v4 server entry of the project's
      `.mcp.json` with the kit's, paste the kit's agent instructions where the
      project keeps them, run the kit's verification `curl`.
- [ ] **A8 — Connect Claude Code. Live check L4** (§4).
- [ ] **A9 — Work a day** on every code project. Log every refusal in the
      table of [e2e-tests](../tests/e2e-tests.md#known-refusals-log) and
      classify it with §5.
- [ ] **A10 — Sign.** Zero unexpected refusal → fill the "Outcome" section of
      `docs/tests/e2e-tests.md` with the date and sign M1. Otherwise list the
      blocking refusals there; they go back into presets, catalogs or bug fixes,
      and A9 is run again on the fixed build.

### B. Recreation is complete when

- [ ] **B1** — Every active code project points at the v5 instance: a search
      of every `.mcp.json` for the v4 host returns nothing.
- [ ] **B2** — No v4 token has been used for 7 days (the v4 `audit_log`).

### C. Extinction of v4

Only after B. Each line is irreversible.

- [ ] **C1** — Take a final read-only export of the v4 `audit_log` and of the
      `tokens` metadata (no secrets) for forensic retention; store it outside the
      repository.
- [ ] **C2** — Revoke the v4 tokens in the v4 UI, so a forgotten `.mcp.json`
      fails loudly.
- [ ] **C3** — Revoke the provider credentials **at the providers**: uninstall
      and delete the v4 GitHub App and the separate GitHub OAuth App used for
      sign-in; revoke the v4 Supabase OAuth app and any Supabase management token;
      revoke the v4 Railway auth app; revoke the Vercel tokens; rotate or delete
      the Cloudflare, Upstash, Resend and Stripe keys that were pasted into v4;
      remove v4's SSH public keys from every host it was bound to.
- [ ] **C4** — Vercel (v4's host): delete the v4 project, or detach the
      domain and stop deployments; remove its environment variables; decide what
      the product's public domains point at (the landing page is outside v5).
- [ ] **C5** — Supabase (v4's database): pause, then delete, the v4
      production project and the staging one; delete the local
      `supabase/.temp` link; remove the `SUPABASE_*` secrets and the
      `production` environment from the repository's GitHub Actions settings.
- [ ] **C6** — Upstash (v4's cache): delete the Redis database and its REST
      token.
- [ ] **C7** — Resend (v4's email): delete the API key, and the sending
      domain if nothing else uses it.
- [ ] **C8** — GitHub repository: delete the Actions secrets nothing reads
      any more.
- [ ] **C9** — Local machine: destroy the `.env` copies that hold v4
      credentials; keep only the v5 `deploy/config/.env`, outside the repository.
- [ ] **C10** — Record the extinction date in `CHANGELOG.md` and close the
      "v4 billing" item of the pivot ADR's negative consequences.

### D. After the cutover (no deadline)

- [ ] **D1** — Tighten the missions one by one: narrow the risks, add
      `approval` on the protected-merge and prod-destructive entries (the gate
      of an accepted risk is edited on the mission page), move from "one mission per code project" to "one
      mission per objective". Feed the values that worked into the
      `mission-presets-default-values` ADR.

### Rolling back a project

Until C, v4 is intact: put the v4 entry back in the project's `.mcp.json` and
the project works as before. Nothing on the v5 side needs undoing; revoke the
mission if it should stop answering.

## 4. The live checks

Four things could not be verified offline during the build. Each is a
question with a yes / no answer; write the answer next to it.

### L1 — Does GitHub send `state` back on the install callback? (at A4)

The fix that binds an installation to the person who installs it relies on
GitHub returning the `state` the gateway put on the installation URL when
"Request user authorization (OAuth) during installation" is on.

- Do: connect GitHub on an account where the App is **not** installed yet.
- Expect: back on `/connections/<id>` with "Connected" and the repositories.
- If not: "Not connected: this authorization attempt has expired, was already
  used…" (`state-invalid`) means GitHub dropped the `state`. Copy the callback
  URL from the address bar (it holds no secret that outlives a minute) and
  stop: the connect flow needs a host-initiated authorize redirect before
  GitHub can be connected at all.
- [ ] Answer: \_\_\_\_

### L2 — Connecting an App that is already installed (at A4)

For an App already installed on the account, GitHub shows its configure page
instead of the installation page, and may come back without a `code`.

- Do: revoke the connection made in L1 on the gateway (the App stays
  installed at GitHub), then connect GitHub again.
- Expect: back with "Connected".
- If not: "Not connected — the provider returned no user authorization". The
  workaround for the day is to uninstall the App at GitHub and connect again
  (L1's path); report it, the same host-initiated redirect fixes both.
- [ ] Answer: \_\_\_\_

Also note, for the record: connecting proves that your GitHub account can
_reach_ the installation (`GET /user/installations`), not that you
administer the organisation.

### L3 — Does Railway's API accept the MCP-audience token? (at A4)

The Railway connection obtains a token for the audience of Railway's MCP
server (RFC 8707 resource indicator). Discovery and the variable tools call
Railway's `backboard` API with that same token. v4 made the same assumption;
it was never confirmed against the live API.

- Do: connect Railway.
- Expect: the projects are listed as resources. Then, from an agent, one
  `railway__*` read and one variable read.
- If not: the connection is kept but shows "resource discovery failed" with
  Railway's answer; the variable tools fail upstream. The mission can still
  use the tools that go through Railway's MCP server. Report Railway's error
  text.
- [ ] Answer: \_\_\_\_

### L4 — Claude Code itself (at A8)

**No one has connected Claude Code to a v5 instance.** The execution door was
verified with `curl`, with the official MCP client in both protocol eras, and
by the automated smoke — never with the client the cutover is for.

- Do: in a repointed project, start Claude Code, check the `vaubaan` server is
  connected and lists the mission's tools, call one read tool, then ask for
  something the mission does not accept.
- Expect: the tools of the mission's providers; the read returns the
  provider's answer; the refusal reaches the model as a structured error with
  its `code` and `hint`, and the model reports it instead of working around
  it.
- If the server does not connect: `curl` the kit's verification first. A 401
  with a fresh token means the `Authorization` header does not reach the
  instance (the variable is not exported where Claude Code runs, or the
  reverse proxy strips the header). A 401 whose `error.data.reason` is set
  (`token-rotated`, `token-revoked`, `holder-removed`, `holder-deactivated`)
  means the token authenticated before and no longer does: a newer token of
  the same holder replaced it, or it was revoked; export the current one. A 403 on every request means the client
  sends an `Origin` header; the door answers no CORS. Then read
  [execution-door](execution-door.md), "How to debug".
- [ ] Answer: \_\_\_\_ Claude Code version: \_\_\_\_

## 5. Reading a refusal

The log itself is in
[e2e-tests](../tests/e2e-tests.md#known-refusals-log) so that the signed
outcome and its evidence stay in one place. Its columns:

| #   | When (UTC) | Code project / mission | Tool | Refusal code | Risk or resource | Expected? | Why / what was done |
| --- | ---------- | ---------------------- | ---- | ------------ | ---------------- | --------- | ------------------- |
| 1   |            |                        |      |              |                  |           |                     |

Where to read each field: the agent's error (`code`, `hint`, and the fields
below), or the Audit page filtered by mission and decision `refused`.

| Code                               | Field to copy                    | Expected when…                                                                | Unexpected when…                                                                                           |
| ---------------------------------- | -------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `budget-exhausted`                 | `risk_id`, `claim_url`           | the day really spent the quota; you answered the claim and the replay passed  | a preset quota is too small for an ordinary day (→ preset value)                                           |
| `rate-limited`                     | `risk_id`, `retry_after_seconds` | a burst; the retry passed                                                     | ordinary work trips it repeatedly (→ preset rate)                                                          |
| `approval-required`                | `risk_id`, `approval_url`        | the risk is gated in the preset; you approved and the identical replay passed | the replay asked again with the same arguments (→ bug), or an ordinary action asks all day (→ preset gate) |
| `risk-not-accepted`                | `missing_risks`                  | an action a developer mission should not do unattended                        | an ordinary action (→ preset), or `…uncategorized-write` (→ catalog hole)                                  |
| `resource-not-in-mission`          | `cited_ref`                      | a resource you left out on purpose                                            | a resource the project needs, or one that went `stale` after a discovery refresh                           |
| `connection-unavailable`           | `owner`                          | you revoked the connection or the grant at the provider                       | a healthy connection (→ credential refresh; read the server log)                                           |
| `mission-inactive`                 | the reason                       | you revoked the mission                                                       | anything else                                                                                              |
| `wrong-credential-kind`            | `presented`                      | never during normal work                                                      | always: the token went to the wrong place, or a browser cookie rode along                                  |
| none — `Vaubaan rejected the call` | the sentence                     | the agent omitted a required ref and corrected itself                         | the classifier cannot place a legitimate call (→ plugin bug)                                               |
| none — `Upstream error`            | the provider's status            | the provider itself refuses the action (permissions of the app)               | the gateway built a wrong request (→ plugin bug)                                                           |

## Appendix — Decisions to confirm

Choices made during the build without the owner, and questions left open.
Each line says what the instance does **today**. Nothing here blocks the
cutover; each is a default that can be changed, most in one place.

### Execution door

| Question                                                                                                 | Current behaviour                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Is a provider 403 acceptable as a plain failed call?                                                     | Yes: only a 401 triggers refresh → retry → `expired`. A dead API key whose provider answers 403 is never marked `expired`.                                               |
| Should plugins declare the risks each tool can touch, so `tools/list` filters per tool as the spec says? | No declaration exists; the list is filtered per provider.                                                                                                                |
| CORS on `/mcp` for browser-based MCP clients (Inspector)?                                                | None; a foreign `Origin` is refused.                                                                                                                                     |
| Surface rate limit per mission                                                                           | 600 requests per minute, all agents together (`mcp.rate_limit_per_minute`).                                                                                              |
| An `unowned` connection serving calls (spec §2)                                                          | Yes: it serves until its credential dies (then `expired`); the operator reassigns an owner ([authority](authority.md)).                                                  |
| Stateless caps of the catalogs (items / bytes per call)                                                  | Declared by no shipped catalog (a structural test refuses them) and not enforced by the door; `infra_limits.calls_per_minute_max` is the one limit applied, at issuance. |

### Budget, claims and approvals

| Question                                                                | Current behaviour                                                                                              |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Quota extension capped at the period's consumption — acceptable for M1? | Capped: a granted claim is a credit on the period counter. Lifting the cap needs a per-period extension table. |
| "Reset the period" resets every risk of the mission — intended?         | Yes, every counter of the current period, not only the claimed risk.                                           |
| Time zone on the claim page                                             | Consequence lines show UTC, facts show the browser's local time.                                               |
| Default expiry of a claim / of an approval                              | 24 h / 10 min, both configurable (`requests.expiry`, `approvals.expiry`).                                      |
| The audit's argument hash as the approval fingerprint                   | Done: one canonical SHA-256 of the key-sorted JSON (64 hex).                                                   |
| Session events and past-period counters under the audit's retention?    | No: `retention_days` purges the audit only; events and counters grow.                                          |
| Should a one-off mission's period carry an anchor date?                 | No anchor for one-off periods.                                                                                 |
| Granting an approval                                                    | Done (P2.1): grant, open the gate for the rest of the period, or refuse; the gate is editable after issuance.  |
| A call touching two gated risks                                         | Asks once per gated risk, in turn (one request each); both approvals are consumed by the one replay.           |
| "Open the gate for the rest of the period" on a one-off mission         | Unavailable: there is no period end to bound it. The creator sets the gate to `auto` on the mission instead.   |

### Missions and presets

| Question                                                                 | Current behaviour                                                                                                      |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| One connection per provider per mission — acceptable?                    | Enforced (`duplicate-provider`): the policy is keyed by risk id, two connections would share one budget.               |
| Default expiry of a new mission                                          | Never. Default period: daily reload.                                                                                   |
| Should "Select all" include the fallback risk?                           | No: it leaves out the `uncategorized-write` fallback and deprecated entries.                                           |
| Mission rate limits bounded by catalog `caps` as well as `infra_limits`? | Bounded by `infra_limits` only.                                                                                        |
| A preset naming an env-scoped risk by its base id (Stripe `read-only`)   | Expanded at issuance into one line per environment the selection resolves.                                             |
| `rate_limit` mandatory on every preset entry?                            | Mandatory; not defaulted from a catalog cap.                                                                           |
| Preset values                                                            | The catalogs' own, provisional until the `mission-presets-default-values` ADR is written from this cutover's feedback. |
| Should issuance validate that a policy lists each risk once?             | The store refuses the duplicate at write time; issuance does not check earlier.                                        |
| Scope injection (auto-filling the single resource's ref)                 | Off: the agent passes the refs.                                                                                        |

### Connections and resources

| Question                                                                | Current behaviour                                                                                        |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Should revoking a connection also revoke the grant at the provider?     | No: the local credential is erased, and the page says so.                                                |
| May owners remove stale resources? What of missions that selected them? | Stale resources are marked, never deleted; a mission's call on one is refused `resource-not-in-mission`. |
| A declarative "owner-editable metadata" schema in the SDK?              | None: any discovered list of strings is editable.                                                        |
| Lock the `env` label when the plugin sets it (Stripe mode)?             | Locked: a plugin-set environment is read-only in the interface.                                          |
| "At least one of these fields" in a credential spec                     | Not expressible; checked by the plugin at discovery.                                                     |

### GitHub

| Question                                                                  | Current behaviour                            |
| ------------------------------------------------------------------------- | -------------------------------------------- |
| Does GitHub return `state` on the install callback?                       | Assumed yes — **live check L1**.             |
| Does connecting an already-installed App come back with a `code`?         | Unknown — **live check L2**.                 |
| Is "the user can reach the installation" enough, or require an org owner? | Reach is enough (`GET /user/installations`). |
| Drop the personal-access-token path?                                      | Dropped: App installation only.              |

### Other providers

| Provider   | Question                                                                               | Current behaviour                                                                                              |
| ---------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Railway    | Does `backboard` accept the MCP-audience token?                                        | Assumed yes — **live check L3**.                                                                               |
| Railway    | Should the environment, not the project, be the resource?                              | The project is the resource; `prod` / `staging` labels are per project.                                        |
| Vercel     | `vercel.read-account` matches every read — keep?                                       | Kept from v4: every read also requires it.                                                                     |
| Vercel     | Keep `deploy_to_vercel`?                                                               | Kept for parity.                                                                                               |
| Stripe     | Widen `subscription-create` to payment-intent writes rather than add a dedicated risk? | Widened (catalog v3).                                                                                          |
| Stripe     | Keep `stripe__create_payout` and `stripe__delete_customer`?                            | Kept, behind their own irreversible risks, gated `approval` in the live preset. v4 excluded customer deletion. |
| Resend     | Accept that a connection needs a full-access key?                                      | Required: discovery lists the domains.                                                                         |
| Resend     | Normalize environment labels to a closed list?                                         | Free text.                                                                                                     |
| Resend     | Owner edits to a domain's zone lists across re-discovery                               | Kept: discovery refreshes provider facts only.                                                                 |
| SSH        | Owner-curated "annotated scripts" per connection?                                      | Parked: no tool uses them.                                                                                     |
| SSH        | Widen the read-only whitelist so `… \| tail -n 50` is a read?                          | No: the v4 whitelist is kept, a pipe into `tail` is a write.                                                   |
| Gmail      | A structural "never acceptable" marker in the catalog schema?                          | None: the only guard is "in no preset" plus the issuance screen.                                               |
| Gmail      | Accept the `gmail.modify` over-grant for label tools, or drop them?                    | Neither yet: the plugin requests read-only and compose scopes and exposes no tool.                             |
| Cloudflare | Should "critical record" also cover CAA and SRV at the apex?                           | Apex, wildcard at apex, MX and NS only.                                                                        |
| Cloudflare | The extra pre-flight read on every ordinary `update_record`                            | Done on every update, to refuse an "ordinary" change of a critical record.                                     |
| Cloudflare | `list_zones` when a mission spans several accounts                                     | Filtered to the mission's zones.                                                                               |

### Identity and administration

| Question                                                                                    | Current behaviour                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entra ID groups are object ids: recommend emails, or document the app registration setting? | This page recommends `admin.emails` for Entra.                                                                                                                                                 |
| A manual "revoke the bootstrap token now" button?                                           | None: the token is revoked by the first IdP sign-in of a user matching the admin rule.                                                                                                         |
| Refuse `bootstrap_token` once an IdP is configured?                                         | Optional: harmless to leave set, refused once revoked.                                                                                                                                         |
| Where do non-operators land after sign-in?                                                  | On the page they came from; without one, on `/login`, which shows who is signed in. `/` goes to `/missions`.                                                                                   |
| How are acts done with the bootstrap token audited?                                         | Under the literal actor `bootstrap`.                                                                                                                                                           |
| OAuth refresh-token replay on the management door (P2.3)                                    | Built: a replayed refresh token or authorization code revokes the delegation, except the token just rotated, accepted once more within `oauth.refresh_reuse_window_seconds` (30 s by default). |

### Audit

| Question                                                                                    | Current behaviour                                                                         |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Should an operator see every call entry?                                                    | No: every administrative entry, but only the calls of their own missions and connections. |
| System-driven events (automatic refresh, connection marked expired) under a "system" actor? | Not audited; they are in the server log.                                                  |
| Are sign-in and sign-out audited?                                                           | No (the spec does not list them).                                                         |
| Retention sweep frequency                                                                   | At boot, then hourly; a constant, not a configuration key.                                |

### Platform

| Question                                                            | Current behaviour                                                                  |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| SQLite `synchronous=NORMAL`: acceptable for a quota store?          | `NORMAL`: a power loss (not a process crash) can lose the last transactions.       |
| `store.path` unreadable at boot: exit 78 or 1?                      | 1.                                                                                 |
| An explicit `store.migrations_dir` key for hosted builds?           | None: the directory is fixed at build time.                                        |
| Repositories returning persistence records rather than domain types | Records; services map them.                                                        |
| Should `BearerKind` and `Door` move to the shared package?          | They live in gateway-core.                                                         |
| Default telemetry collector host                                    | A provisional placeholder under the product's domain; telemetry is off by default. |
| Image size                                                          | About 456 MB (Debian slim, traced `node_modules`).                                 |

## References

- ADR
  [pivot-v4-to-v5-on-prem-mission-tokens](../decisions/pivot-v4-to-v5-on-prem-mission-tokens.md)
  D7; spec [vaubaan-gateway](../spec/vaubaan-gateway.md) §7.1–§7.6, §10.
- Scenario, pass criterion, log and outcome:
  [e2e-tests](../tests/e2e-tests.md).
- Deployment: [deploy/README](../../deploy/README.md),
  [configuration](configuration.md).
- Neighbours: [authentication](authentication.md),
  [connections](connections.md), [missions](missions.md),
  [execution-door](execution-door.md), [requests](requests.md),
  [audit](audit.md); provider pages under [providers/](providers/README.md).
