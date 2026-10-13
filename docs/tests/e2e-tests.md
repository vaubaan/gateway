---
title: E2E tests
status: current
date: 2026-10-13
last_synced: 2026-10-13
tracks:
  - apps/gateway/tests/e2e/v5/playwright.config.ts
  - apps/gateway/tests/e2e/
  - deploy/docker/smoke.sh
  - .github/workflows/ci.yml
---

# E2E tests

The end-to-end criterion of the v5 gateway is one scenario, run by a human on
real accounts: the **cutover acceptance scenario** (spec
[vaubaan-gateway](../spec/vaubaan-gateway.md) §10 "End to end"; ADR
[pivot-v4-to-v5-on-prem-mission-tokens](../decisions/pivot-v4-to-v5-on-prem-mission-tokens.md)
D7 step 1). Everything automated in this file exists to make that run boring.

| Check                                                              | Runs                                     | Real IdP | Real provider | Real coding agent |
| ------------------------------------------------------------------ | ---------------------------------------- | -------- | ------------- | ----------------- |
| [Cutover acceptance scenario](#cutover-acceptance-scenario-manual) | **by hand**, once, by the instance owner | yes      | yes           | yes (Claude Code) |
| [Cutover smoke](#cutover-smoke-automated)                          | CI job `e2e`, `npm run test:e2e:v5`      | no       | no            | no                |
| [Other browser specs](#other-browser-specs-automated)              | CI job `e2e`, `npm run test:e2e:v5`      | no       | no            | no                |
| [Container smoke](#container-smoke-automated)                      | CI job `docker`, `npm run docker:smoke`  | no       | no            | no                |
| [Manual checks by feature](#manual-checks-by-feature)              | by hand, when the feature changes        | yes      | yes           | partly            |

Nothing automated touches a real identity provider, a real provider or a real
coding agent, and nothing manual is ever run by CI.

## Cutover acceptance scenario (manual)

> Acceptance criterion of milestone M1 and of the cutover from the v4 SaaS
> (ADR D7): _connect every provider used today, issue one mission per code
> project, run the daily workflow with Claude Code with no unexpected
> refusal._ The step-by-step checklist with tick boxes, what to prepare and the
> live checks is the handbook
> [cutover-from-v4](../handbook/cutover-from-v4.md); this section is the
> scenario and its pass criterion.

**Who and where.** The owner of the instance, on their own v5 instance behind
TLS, with their own accounts at the identity provider and at each provider.
v4 stays on for the whole run.

**Precondition.** The [cutover smoke](#cutover-smoke-automated) is green on
the commit the image was built from.

### Steps

1. **Install.** Deploy the image, mount `/data`, provide the configuration
   (`public_url` in https, master key, admin rule, bootstrap token, telemetry
   disabled). `GET /healthz` answers `ok`.
2. **Configure the identity provider.** Open `/admin/bootstrap` with the
   bootstrap token, enter issuer, client id and secret on Administration →
   Identity provider, "Test login", then sign in through the IdP as a user
   matching the admin rule. The bootstrap token shows as revoked.
3. **Register the provider apps.** On Administration → Provider apps, one app
   per provider that needs one (GitHub App, Supabase, Railway, Google), each
   registered under the company's own account.
4. **Connect each provider** the owner has a v4 connection for today. Each
   connection ends `active` with its resources discovered; environments are
   labelled where the catalog scopes risks by environment.
5. **Issue one mission per code project.** For each code project: its
   connections, the resources of that project only, the plugin's developer
   preset for each connection (`developer` for GitHub, Vercel and Railway,
   `staging-developer` for Supabase, and the equivalent for the others),
   recurring period, **no expiry**. Copy the bootstrap kit.
6. **Replace `.mcp.json`.** In each code project, put the kit's client
   configuration (the instance's `/mcp` URL and
   `Authorization: Bearer ${VAUBAAN_MISSION_TOKEN}`) in place of the v4 entry,
   export the token, run the kit's verification `curl`, then start Claude Code
   and list the tools.
7. **Work a day.** Run the usual Claude Code workflow on every code project
   for one working day: read code, branch, commit, open pull requests, deploy
   previews, query and migrate the staging database, whatever the day brings.
8. **Log every refusal** in the table below, as it happens, and classify it.

### Pass criterion

**Zero unexpected refusal.** Every refusal met during the day is explained by
one of:

- the **budget** — `budget-exhausted` or `rate-limited`; the creator answered
  the claim (or waited for the window) and the replay passed;
- a **risk the mission does not accept** — `risk-not-accepted`, or
  `approval-required` on a risk the preset gates, for an action the owner
  agrees a `developer` mission should not do unattended;
- the **resource selection** — `resource-not-in-mission` for a resource the
  owner deliberately left out.

Anything else is unexpected and blocks M1: a refusal on an action the day
needs (preset too tight), a call the classifier cannot place
(`Vaubaan rejected the call: …`), a `risk-not-accepted` on the
`uncategorized-write` fallback (catalog hole), `connection-unavailable` or
`mission-inactive` on a healthy connection, an upstream failure the provider
would not have returned to v4, a tool that v4 offered and v5 does not list.
Each unexpected refusal is fed back into the plugin's preset or catalog, or
filed as a bug, and the day is run again on the fixed build.

### Known refusals log

One row per refusal, copied from the agent's output or from the Audit page
(filter by mission, decision `refused`). The hint of the refusal says which
field to read.

| #   | When (UTC) | Code project / mission | Tool | Refusal code | Risk or resource | Expected? | Why / what was done |
| --- | ---------- | ---------------------- | ---- | ------------ | ---------------- | --------- | ------------------- |
| 1   |            |                        |      |              |                  |           |                     |
| 2   |            |                        |      |              |                  |           |                     |
| 3   |            |                        |      |              |                  |           |                     |

"Expected?" is one of `budget`, `risk not accepted`, `resource left out`, or
`UNEXPECTED`. For an unexpected row, "Why / what was done" names the fix
(preset entry, catalog entry, bug) and the commit that carries it.

Refusals that are expected before the day starts, because of what Phase 1
ships (details in the handbook, "Known limits at M1"):

- `approval-required` on a risk the preset gates `approval`: the owner opens
  the URL, approves, and the agent replays the same call. In the `developer`
  presets these are `github.workflow-write-via-file`,
  `github.mint-install-token-push`, `railway[prod].deploy` and
  `railway[prod].upsert-variable`. It is a refusal by design, logged as
  expected; a replay that asks again with unchanged arguments is not.
- Gmail exposes no tool (experimental plugin, classifier only).
- A tool is listed as soon as the mission holds its provider, then refused
  `risk-not-accepted` if the mission does not accept its risk: the tool list
  is filtered per provider, not per tool.

### Outcome

> **Not run yet.** Placeholder written on 2026-10-13, when the scenario and the
> smoke were delivered. The run is the instance owner's; nobody else, and no
> agent, has executed it. Fill in below and remove this notice.

| Field                                 | Value |
| ------------------------------------- | ----- |
| Date of the run                       |       |
| Run by                                |       |
| Image (version, commit)               |       |
| Identity provider                     |       |
| Providers connected                   |       |
| Code projects / missions issued       |       |
| Refusals logged (expected/unexpected) |       |
| Verdict (M1 signed / blocked)         |       |
| Follow-ups (presets, catalogs, bugs)  |       |

## Cutover smoke (automated)

> `apps/gateway/tests/e2e/v5/cutover-smoke.spec.ts`. One Playwright test that
> walks the path of the scenario above on an ephemeral instance. Runs in the
> `e2e` job of `.github/workflows/ci.yml` on every push and pull request, and
> locally with `npm run test:e2e:v5`.

What it does, in order:

1. **Sign in** — no session sends the browser to `/login`; the round trip
   through the simulated IdP's consent screen lands on `/connections` as a
   user who owns nothing.
2. **Connect GitHub** — "Connect a provider" → GitHub → "Continue to GitHub";
   the browser goes to the App's installation page (mocked) and comes back on
   `/connections/callback/github` with the installation id, the user
   authorization code and the single-use state; the instance exchanges the
   code, checks the installation against the user's installations, mints an
   installation token and discovers two repositories. The connection is
   `active` with both repositories as resources.
3. **Issue a mission** — on `/missions/new`: name, the GitHub connection, one
   repository left out, the plugin's `Developer` preset, and the quota of
   `github.read-code` lowered to 2. The bootstrap kit is revealed once: the
   token, a client configuration that names `<public_url>/mcp` and never the
   token, the `tools/list` verification.
4. **`tools/list` and `tools/call` over HTTP on `/mcp`** — without a token: 401. With the mission token: the kit's plain JSON-RPC `tools/list`, then the
   official MCP client (`@modelcontextprotocol/client`) connects, lists the
   same tools and calls `github__list_branches`; the answer is the mocked
   provider's, the provider received the installation token, and the agent's
   answer does not contain it.
5. **Two expected refusals** — the repository left out answers
   `resource-not-in-mission` with the allowed resources; a write on `main`
   answers `risk-not-accepted` with the missing risks.
6. **Exhaust** — the second read passes, the third is refused
   `budget-exhausted` with `risk_id` and a claim URL `<public_url>/r/<id>`
   repeated in the hint; the provider received exactly two reads.
7. **Claim** — the creator opens the URL, lands on the request ("quota 2 ·
   consumed 2 · 0 left"), the inbox counts one; "Extend the quota" by one →
   `granted`, the count is gone.
8. **Replay** — the same call, same token, passes; the next one is refused
   again (one action was given back, not more).
9. **Audit page** — the six `github__list_branches` entries of the mission
   (three allowed, one outside the mission, two on the budget) with the agent
   label and a 64-hex argument fingerprint, the `risk-not-accepted` entry, the
   issuance; neither the mission token nor the installation token is in the
   page.
10. **Session page** — `github.read-code` exhausted with nothing left, the
    agent label seen, the three allowed calls with what was left after each,
    the two refusals, the creator's "+1 given back".

What it stands on, and therefore does **not** prove:

| In the smoke                                                                  | In the manual scenario                                              |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `FakeIdp`, an in-process OpenID Connect provider, as the relying party's HTTP | a real IdP: discovery, consent, claims, groups, the admin rule      |
| a mocked GitHub (`mockFetch` as `RootDeps.providerFetch`), one provider       | every provider in use, their real OAuth / installation / key flows  |
| the installation page answered by the launcher, which always sends `state`    | whether GitHub sends `state` back, and the already-installed case   |
| the official MCP client and plain JSON-RPC, on the local listener             | Claude Code, through the TLS terminator, with the kit's `.mcp.json` |
| the `:memory:` store, one process, one minute                                 | the SQLite file on a volume, restarts, a working day                |
| the real composition root, door, pipeline, budget, requests, audit and the UI | the same code, in the image                                         |

## Other browser specs (automated)

One configuration, `apps/gateway/tests/e2e/v5/playwright.config.ts`, one
project (Chromium, 1280×800), one worker. `npm run test:e2e` is an alias of
`npm run test:e2e:v5`, which builds the app then runs Playwright; the CI job
`e2e` runs the same command after `npx playwright install --with-deps
chromium`. It is not part of `npm run ci`.

### The ephemeral instance

The configuration's `webServer` is `ephemeral-instance.ts`: one process that
builds the **real composition root** (`getRoot(testRootDeps(…))`) with the
`:memory:` store and the shipped plugins, publishes it where production code
looks for it, and serves the built app on it (`E2E_V5_PORT`, default 3105;
set another port when several checkouts run the suite on one machine).
Injected through `RootDeps`, and nothing else: P1.1's `FakeIdp` as the relying
party's `fetch`, and a mocked GitHub as `providerFetch` — the user
authorization token endpoint, the user's installations, the installation
token, the installation's repositories, two read endpoints and the file
write. Any other outbound request rejects. The GitHub App's settings come in as
`VAUBAAN_PROVIDER_GITHUB_*`, with a key pair and secrets generated per run.

The launcher holds no budget and no door of its own: every executor call of
every spec is an HTTP request on `/mcp` with a mission token
(`agent.ts`: the official MCP client, and the kit's plain `tools/list`), and
runs through `root.execution` and `root.budget`.

Seeded through the repositories: Ada (`E2E_USER`) owns a GitHub, a Supabase, a
Vercel and a Gmail connection; her GitHub connection is an installation of the
mocked GitHub. Bob owns nothing. The share spec brings its own cast
(`E2E_SHARE_OWNER`, `E2E_SHARE_TARGET`, `E2E_OPERATOR`, whose email the
instance's admin rule names) and its own connections, so it changes nothing
the other specs read. The simulated IdP has **no default user**:
each spec names the user it signs in as in its `beforeEach` (`signInAs`), and
a spec that does not fails at its sign-in.

The instance's `public_url` is `https://gateway.e2e.test`; the browser context
routes that origin to the local listener (`browser.ts`), so cookies stay
`Secure` and the origin check sees the public origin. Navigation redirects are
answered as pages that navigate, because Playwright does not route the hops of
a redirect. The pages a browser is sent to outside the instance are answered
by control endpoints that exist only in the launcher, under `/__e2e`:

| Endpoint                          | What it does                                                                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `idp/authorize`, `idp/next-user`  | the simulated IdP's consent, and who signs in next                                                                                     |
| `provider-pages`, `provider-page` | the provider pages of the connect flows (the GitHub App's installation page) and the way back                                          |
| `verify-token`                    | what `MissionService.verifyToken` says of a bearer                                                                                     |
| `small-mission`                   | issues a mission of Ada with a two-action quota on `github.read-code`; returns its token                                               |
| `developer-mission`               | issues a mission of `E2E_APPROVER_USER` from the GitHub `developer` preset as shipped, on a connection of their own; returns its token |
| `upstream`                        | what the mocked provider received, and whether each request carried the installation token                                             |
| `seed-day`                        | issues a mission for `E2E_AUDIT_USER` and leaves a day of calls and their audit entries on it                                          |

`seed-day` is the one fixture written **below the door**: the calls are
recorded through `root.budget.recordCall` and the audit writer
(`tests/integration/audit/support.ts`), because the day holds calls on gated
and exhausted risks, by tools no mocked provider answers. Everything else goes
through the door.

A request still in flight when a test ends is ignored by the router.
`E2E_V5_SCREENSHOT_DIR=<folder>` keeps a screenshot of each step.

### Specs

| Spec                        | Signs in as                   | Scenario                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cutover-smoke.spec.ts`     | `E2E_CUTOVER_USER`            | **Cutover smoke**: see [above](#cutover-smoke-automated).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `issue-mission.spec.ts`     | `E2E_USER`                    | **Issue a mission**: no session → sign-in through the simulated IdP; experimental provider hidden until toggled; name, three connections, one preset each; the three-line summary; **one page** (per-risk detail folded, ≤ 6 visible checkboxes, page ≤ 2 viewports at 1280×800, Issue button in view); resource deselection drops the preset's staging entries and says so; one quota and one gate adjusted; unresolvable entries shown and not tickable; reveal-once dialog and kit; the token verifies; the detail page masks it; rotate (old token refused); revoke (`revoked`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `issue-mission.spec.ts`     | `E2E_USER`                    | **Proposal and duplicate**: an agent's JSON proposal (provider and refs) is checked, what passes fills the form, what cannot resolve is listed; issue; duplicate → same policy, its own token.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `exhaust-and-claim.spec.ts` | Bob, then Ada                 | **Exhaust and claim** (P1.7), the executor being an MCP client on `/mcp`: two `github__get_file_contents` pass, the third is refused `budget-exhausted` with `<public_url>/r/<id>`; another signed-in user opens it → **403**, one sentence, no mission name, risk or creator, nothing in their inbox; the creator opens it without a session → sign-in → the request: budget of the risk, other risks, session events, four actions with their consequence (expiry extension unavailable: the mission never expires); the inbox and its count in the bar; the replay is still refused; **Reset the period** → `granted`, counters at zero, count gone; **the replay passes**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `approve-action.spec.ts`    | Bob, then `E2E_APPROVER_USER` | **Approve an action** (P2.1), the executor being an MCP client on `/mcp` and the mission issued from the GitHub `developer` preset as shipped: a workflow file write is refused `approval-required` with `<public_url>/r/<id>`, the validity (600 s) and the replay instruction, nothing reaches the provider, a replay points to the same request; another signed-in user opens it → **403**, no argument, tool, mission or risk; the creator opens it without a session → sign-in → the request: **the tool, the arguments in clear, the two slices, the budget of both risks the call touches**, three actions with their consequence; the inbox row names the tool, not the arguments; **Approve this action** → `granted`, **the arguments are erased from the page**; **the identical replay reaches the provider with the gateway's credential**, the page shows the approval consumed and both counters at one; the same call again and one byte changed each ask again; **Open the gate for the rest of the period** → both pass, the remaining request shows the option unavailable and is refused; on the mission page the gate shows "open until", **Set to auto** then **Require approval** (the next call asks again before the period ended); the Audit page lists `approval-granted`, `gate-opened`, `request-refused`, two `gate-changed` and "approval consumed", and holds no argument; so does the session timeline. |
| `audit-session.spec.ts`     | `E2E_AUDIT_USER`              | **A day of calls** (P1.8, seeded below the door): from the mission page to its session — state badge with the exhausted risk, quota / counted / left / gate per risk, the current period's counters, the two open requests as links to `/requests/<id>`, the agent labels seen, the timeline newest first with what is left after each call; then "Audit of this mission" — six calls and the issuance, remaining budget and 64-hex argument fingerprint per call, **the argument marker on neither page**, the eight filters on one row, no sideways scroll of the page at 1280 px, filters by decision, tool and period, "Clear", the "Audit" entry of the navigation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `audit-session.spec.ts`     | `E2E_AUDIT_USER`              | **Every column of the audit table at 1280 px**: the table does not scroll sideways (the 64-hex argument fingerprint wraps inside its cell).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `audit-session.spec.ts`     | `E2E_AUDIT_USER`              | **Not yours**: the session page of an unknown mission answers 404.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### Scenarios still to write

Each is added to this file, with its spec, by the feature that makes it
possible (spec §4, §5, §7):

1. **Bootstrap and first sign-in in a browser** — the bootstrap token, the
   Identity provider page, the first operator sign-in. Today: integration
   suite against `FakeIdp`, and the manual check below.
2. **Share** — a user shares a connection with a group under a restriction;
   a member issues within it (P2.2).
3. **An agent prepares a mission** through the management door (P2.3).
4. **Revoke and orphan** — revoking a connection orphans its missions, whose
   calls answer `mission-inactive` with the reason (integration suite today).

## Container smoke (automated)

> Covers: plan P0.4 DoD ("`docker compose up` serves the UI stub on the
> configured port; container exits with a named variable when config is
> incomplete"), spec §4.3, §6. Script `deploy/docker/smoke.sh <image>`
> (`SMOKE_PORT`, default 3999), run by the `docker` job of
> `.github/workflows/ci.yml` after the image build (tag
> `vaubaan-gateway:ci`) and locally with
> `npm run docker:build && npm run docker:smoke` (tag
> `vaubaan-gateway:local`).

1. **Incomplete configuration** — `docker run` with only `VAUBAAN_PUBLIC_URL`
   exits 78 (`EX_CONFIG`) and stderr names `encryption.master_key` with
   `VAUBAAN_MASTER_KEY or VAUBAAN_MASTER_KEY_FILE`, `store.path` and
   `bootstrap_token`.
2. **http public URL** — a complete configuration with `http://` exits 78;
   stderr contains `public_url: must use https`.
3. **Complete configuration** — the container stays up and
   `GET /healthz` answers 200 `{"status":"ok",...}` within 30 s; the logs
   contain neither the master key nor the bootstrap token.
4. **Native addons** — `argon2` hashes and `better-sqlite3` opens an
   in-memory database and runs a query inside the image (file tracing of
   prebuilt binaries and runtime files; P0.6 added the `better-sqlite3`
   check). `libsodium-wrappers` is exercised indirectly: the encryptor runs
   during boot, so a container that answers `/healthz` has loaded it.
5. **Non-root** — the process runs as uid 10001.
6. **No env file shipped** — the image contains no `apps/gateway/.env*`
   file (the build context excludes every `.env*`).

The container smoke and the cutover smoke do not overlap: the first proves the
image boots from configuration, the second proves the application path on a
root built in-process. No automated check runs the application path _inside
the image_; the manual scenario does.

## Manual checks by feature

Run by hand against a real identity provider or real providers when the
feature changes. The cutover acceptance scenario exercises all three on the
way; these are the detailed versions.

### Operator bootstrap and OIDC sign-in (P1.1)

> Covers: plan P1.1 DoD ("the owner can log into a local instance with Google
> or Entra ID using only config values"), spec §7.1, §6 "human
> authentication". Handbook [authentication](../handbook/authentication.md).
> The automated counterpart runs against the in-process `FakeIdp`
> ([integration-tests](./integration-tests.md)).

Prerequisites: an instance behind TLS (`deploy/compose.yaml` with Caddy, or
`next dev` behind a local https proxy) whose `public_url` is the browser's
URL; an app registered at the IdP with redirect URI
`<public_url>/auth/callback`; `admin.group` or `admin.emails` naming the
tester; `bootstrap_token` set, `idp` **not** set in the configuration.

1. **Bootstrap** — open `<public_url>/login`: "No identity provider is
   configured yet" with the bootstrap link. `/admin/bootstrap` with a wrong
   token shows "The bootstrap token was not accepted"; with the right token
   lands on `/admin` with the `Bootstrap operator` badge.
2. **Configure** — `/admin/identity-provider`: issuer, client id, client
   secret, claim mapping (Entra ID: leave `groups`; the admin rule must
   then name the group **object id** unless the app emits names; Google:
   no groups, rely on `admin.emails`). Save → "Saved" banner; the page no
   longer asks for the secret ("A secret is stored").
3. **Test login** — the IdP consent screen appears, the browser comes back
   to `/admin/identity-provider?tested=1` with the "Test login result"
   banner: email, groups badges, `Operator: yes`. `/admin` now shows the
   bootstrap token as `revoked <timestamp>`.
4. **Bootstrap refused** — in a private window, `/admin/bootstrap` says the
   token was revoked and links to `/login`; posting the token anyway is
   refused.
5. **Non-operator** — sign in as a user outside the rule: `/login` shows
   the `User` badge and no Administration link; `/admin` renders "Not an
   operator" naming the rule.
6. **Session** — refresh after sign-in keeps the session; "Sign out" returns
   to `/login` signed out; the cookie `vbn_session` is
   `HttpOnly; Secure; SameSite=Lax` in the browser's storage inspector; the
   sign-in survives a container restart (rows in `web_sessions`).
7. **Logs** — the server log carries `user signed in`,
   `bootstrap token revoked after the first operator sign-in`, and never
   the client secret or the bootstrap token.

### Connect a provider (P1.4)

> Covers: plan P1.4 DoD ("the owner connects GitHub, Vercel, Supabase, Railway
> on their instance with apps they registered"), spec §7.1 last step, §7.2.
> Handbook [connections](../handbook/connections.md). The automated
> counterparts run against mocked provider endpoints: the integration suite
> for the four credential kinds, the cutover smoke for the GitHub App
> installation in a browser.

Prerequisites: the instance of the previous section, signed in as an
operator; at each redirect-flow provider, an app registered by the company
with the URL shown on `/admin/provider-apps`
(`<public_url>/connections/callback/<provider>`) as OAuth redirect URI
(Supabase, Railway, Gmail) or, for the GitHub App, as the callback URL of its
user authorization.

1. **Provider apps** — `/admin/provider-apps`: one card per provider that
   needs an app, `not configured`. Save GitHub (app id, private key PEM,
   slug, client id, client secret) and Supabase / Railway (client id, secret)
   → `configured`; the secrets are never shown again ("A value is stored;
   leave blank to keep it"). A provider set through `providers.<id>.*` in the
   mounted configuration is read-only with its badge.
2. **Picker** — `/connections/new` lists the configured providers and the
   key-based ones (Vercel, Stripe, Cloudflare DNS, Resend, Upstash Redis,
   SSH); Gmail carries the `experimental` badge once its app is saved; the
   unconfigured ones are named in the muted line.
3. **OAuth** — Supabase: "Continue to Supabase" → consent → back on
   `/connections/<id>` with "Connected" and the projects in the resources
   table. Same for Railway.
4. **App installation** — GitHub, with "Request user authorization
   (OAuth) during installation" enabled on the App and the gateway callback
   registered as its callback URL: install the App on the organisation →
   authorize → back with the repositories as resources (the callback
   carries `code`, `installation_id` and the `state`). Then, as another
   gateway user whose GitHub account cannot reach that organisation: start
   a connection, and open the callback by hand with that organisation's
   `installation_id` and the fresh `state` → "Not connected", no
   connection, a `connection-refused` entry in the audit. With the checkbox
   disabled on the App: "Not connected — the provider returned no user
   authorization".
5. **API key** — Vercel with a token and a team id → connected with the
   projects. Resend with a sending-only key → "Not connected", with
   Resend's own error; with a full-access key → domains and segments.
   Stripe: the `test` / `live` resources show their environment as "set by
   the plugin", not editable.
6. **SSH** — fill host, user, fingerprint → the detail page shows the
   public key; "Refresh discovery" fails with the plugin's message until
   the key is in `authorized_keys`, then lists the host.
7. **Curate** — label a Supabase project `prod`, rename it, hide another;
   on a Resend domain open "Settings" and fill `internal domains`; "Refresh
   discovery" → everything is kept. Delete a project at the provider →
   after a refresh it is `stale since <date>`, still listed.
8. **Replay** — reopen the callback URL of step 3 from the browser history
   → "Not connected: this authorization attempt has expired, was already
   used…"; no second connection.
9. **Refresh** — wait for a Supabase access token to expire (one hour) and
   use "Refresh discovery": it succeeds, and the log carries `credential
refreshed`. Revoke the app's access at the provider, refresh again →
   the connection turns `expired`; "Reconnect" brings it back with the
   same id.
10. **Revoke** — "Revoke", type the connection name → `revoked`, no action
    left on the page; the list shows the state.
11. **Logs and store** — the log never shows a token, a key or a client
    secret; `sqlite3 gateway.sqlite "select hex(credential_blob) from
connections"` shows blobs starting with `01`, never readable text.

### An agent through the execution door (P1.6)

> Covers: handbook [execution-door](../handbook/execution-door.md). Spec §4.1,
> §4.4 (bootstrap kit), §7.5.

Done once on 2026-10-13 on the standalone build with a temporary
configuration and SQLite file; the transcript is in the handbook ("Manual
check").

1. Build (`npm run build --workspace @vaubaan/gateway-app`), export the
   `VAUBAAN_*` variables of a throw-away instance, and seed it:
   `cd apps/gateway && npx tsx tests/manual/seed-demo.ts` creates a user, a
   GitHub connection with two repositories (placeholder installation) and a
   `read-only` mission on one of them, and prints the bootstrap kit.
2. Start `node apps/gateway/.next/standalone/apps/gateway/server.js`.
3. Run the kit's `curl … tools/list` against the instance → the GitHub tools,
   as plain JSON.
4. `tools/call` on the repository outside the mission → JSON-RPC error
   `-32603` whose `data` is the `resource-not-in-mission` refusal with
   `allowed_resources` and the hint.
5. `GET /mcp/catalog` → tool surface, callable set, resources, remaining
   budget. No `Authorization` → 401.
6. An MCP client (`@modelcontextprotocol/client`) connects over HTTP with the
   2025-era handshake and with the 2026-07-28 revision, and lists the tools.
7. The server log holds one `tools/call` line with the token prefix and a
   64-hex `arguments_hash`, and never the token secret.

Steps 3 to 6 are now also covered by the cutover smoke and the integration
suite. **Never done by anyone, human or agent:** the same with Claude Code
itself against an instance behind TLS with a real connection. It is step 6 of
the cutover acceptance scenario and the first thing to try.

## Known gaps

- **No browser test of the bootstrap token and of the Identity provider
  page**, of shares, of the management door (see "Scenarios still to
  write").
- **One provider in the browser.** Only the GitHub App installation flow is
  driven in a browser; the OAuth, API-key and SSH flows are covered by the
  integration suite, never in a browser.
- **The connection-name field's label is not bound to its input** (its
  accessible name is its placeholder), so the smoke reaches it by its form
  name.
- **Playwright ran in no pipeline before P1.9.** The audit table regression,
  the unbound label and a stale assertion (a 16-hex fingerprint) were all
  found the first time the whole suite was run on the merged Phase 1.

## Conventions

- Playwright specs never create state in a real cloud; the "no mock"
  posture of v4 (`e2e-real-clouds` against a dedicated GitHub organisation)
  is retired with the SaaS. Provider calls in v5 E2E run against the mock
  upstream of the plugin test kit (`mockFetch`), whose endpoints are read off
  the plugin's own credential spec, never written down a second time.
- A spec names the IdP user it needs in `beforeEach`; it never relies on the
  user another spec left behind, nor restores one in `afterEach`.
- A spec that needs an executor uses `agent.ts` (an MCP client on `/mcp`).
  Recording a call below the door is reserved to `seed-day`, and said so.
- Transient resources, when a scenario must create one, are named
  `vaubaan-e2e-<spec-hash6>-<run-uuid8>` and removed by the scenario's
  teardown; there is no sweeper job.
