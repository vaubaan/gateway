---
title: E2E tests
status: current
date: 2026-05-22
last_synced: 2026-10-13
tracks:
  - apps/gateway/tests/e2e/v5/playwright.config.ts
  - apps/gateway/tests/e2e/
  - deploy/docker/smoke.sh
  - .github/workflows/ci.yml
---

# E2E tests

Two kinds of end-to-end check exist today:

1. the **container smoke test** (`deploy/docker/smoke.sh`), automated in CI
   since P0.4;
2. the **Playwright harness**: the root `playwright.config.ts` holds only
   legacy v4 specs that target the retired SaaS; the v5 specs run against an
   ephemeral instance with their own configuration
   (`apps/gateway/tests/e2e/v5/`, `npm run test:e2e:v5`, since P1.5). Nothing
   in CI runs Playwright.

The v5 browser scenarios (connection creation, mission issuance, inbox
approval, the agent's structured refusal) are written when the
corresponding features land (Phase 1 and 2); the sign-in scenario (P1.1) is
below, run by hand against a real IdP; each feature
adds its scenario here.

## Container smoke (v5, P0.4, automated in CI)

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

## Manual — operator bootstrap and OIDC sign-in (v5, P1.1, by hand)

> Covers: plan P1.1 DoD ("Renaud can log into a local instance with Google
> or Entra ID using only config values"), spec §7.1, §6 "human
> authentication". Handbook [[authentication]]. The automated counterpart
> runs against the in-process `FakeIdp`
> ([`integration-tests.md`](./integration-tests.md)); this check is the only
> one that touches a real identity provider and is never part of CI.

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

## Manual — connect a provider (v5, P1.4, by hand)

> Covers: plan P1.4 DoD ("Renaud connects GitHub, Vercel, Supabase, Railway
> on his instance with apps he registered"), spec §7.1 last step, §7.2.
> Handbook [[connections]]. The automated counterpart runs against mocked
> provider endpoints ([`integration-tests.md`](./integration-tests.md));
> this check is the only one that touches real providers and is never part
> of CI.

Prerequisites: the instance of the previous section, signed in as an
operator; at each redirect-flow provider, an app registered by the company
with the URL shown on `/admin/provider-apps`
(`<public_url>/connections/callback/<provider>`) as OAuth redirect URI
(Supabase, Railway, Gmail) or as setup URL with "redirect on update"
(GitHub App).

1. **Provider apps** — `/admin/provider-apps`: one card per provider that
   needs an app, `not configured`. Save GitHub (app id, private key PEM,
   slug) and Supabase / Railway (client id, secret) → `configured`; the
   secrets are never shown again ("A value is stored; leave blank to keep
   it"). A provider set through `providers.<id>.*` in the mounted
   configuration is read-only with its badge.
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

## Playwright harness

`playwright.config.ts` defines two projects over `apps/gateway/tests/e2e/`:

- `smoke` — `smoke.spec.ts`;
- `e2e-real-clouds` — every spec under `real-clouds/`.

`npm run test:e2e` runs both, `npm run test:e2e:real-clouds` the second
only. Without `E2E_BASE_URL` the config starts `npm run dev` on
`localhost:3000`; with it, the specs target that URL. Credentials come from
`.env.test` (gitignored) or the environment: `E2E_USER_EMAIL`,
`E2E_USER_PASSWORD`, `E2E_ORG_SLUG`, `E2E_PROJECT_SLUG`. Playwright is not
part of `npm run ci` and no workflow runs it.

### Ephemeral v5 instance (`tests/e2e/v5/`, P1.5)

`npm run test:e2e:v5` builds the app, then runs
`apps/gateway/tests/e2e/v5/playwright.config.ts` (its own configuration: the
root one targets a deployed v4 instance). Its `webServer` is
`ephemeral-instance.ts`: one process that builds the real composition root with
the `:memory:` store, the shipped plugins and P1.1's `FakeIdp` as the relying
party's `fetch`, seeds a user's connections through the repositories, and
serves the built app on it (`E2E_V5_PORT`, default 3105). No credential, no
network, not part of `npm run ci`.

The instance's `public_url` is `https://gateway.e2e.test`; the browser context
routes that origin to the local listener (`browser.ts`), so cookies stay
`Secure` and the origin check sees the public origin. Navigation redirects are
answered as pages that navigate, because Playwright does not route the hops of
a redirect. Control endpoints exist only in the launcher, under `/__e2e`: the
simulated IdP's consent and `idp/next-user` (who signs in next),
`verify-token`, and the executor's side of a claim — `exhaust` (issues a
mission with a two-action quota and records calls through
`SessionService.recordCall` until the budget refuses) and `replay`. `seed-day` (P1.8)
issues a mission for a user of its own (`E2E_AUDIT_USER`) and leaves a day of calls with their audit entries on it
(`tests/integration/audit/support.ts`). A request
still in flight when a test ends is ignored by the router.
`E2E_V5_SCREENSHOT_DIR=<folder>` keeps a screenshot of each step.

| Spec                        | Scenario                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issue-mission.spec.ts`     | **Issue a mission**: no session → sign-in through the simulated IdP; experimental provider hidden until toggled; name, three connections, one preset each; the three-line summary; **one page** (per-risk detail folded, ≤ 6 visible checkboxes, page ≤ 2 viewports at 1280×800, Issue button in view); resource deselection drops the preset's staging entries and says so; one quota and one gate adjusted; unresolvable entries shown and not tickable; reveal-once dialog and kit; the token verifies; the detail page masks it; rotate (old token refused); revoke (`revoked`).                                                      |
| `issue-mission.spec.ts`     | **Proposal and duplicate**: an agent's JSON proposal (provider and refs) is checked, what passes fills the form, what cannot resolve is listed; issue; duplicate → same policy, its own token.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `exhaust-and-claim.spec.ts` | **Exhaust and claim** (P1.7): the executor's third call is refused `budget-exhausted` with `<public_url>/r/<id>`; another signed-in user opens it → **403**, one sentence, no mission name, risk or creator, nothing in their inbox; the creator opens it without a session → sign-in → the request: budget of the risk, other risks, session events, four actions with their consequence (expiry extension unavailable: the mission never expires); the inbox and its count in the bar; the replay is still refused; **Reset the period** → `granted`, counters at zero, count gone; **the replay passes**.                              |
| `audit-session.spec.ts`     | **A day of calls** (P1.8): from the mission page to its session — state badge with the exhausted risk, quota / counted / left / gate per risk, the current period's counters, the two open requests as links to `/requests/<id>`, the agent labels seen, the timeline newest first with what is left after each call; then "Audit of this mission" — six calls and the issuance, remaining budget and argument hash per call, **the argument marker on neither page**, the eight filters on one row and the table without sideways scroll at 1280 px, filters by decision, tool and period, "Clear", the "Audit" entry of the navigation. |
| `audit-session.spec.ts`     | **Not yours**: the session page of an unknown mission answers 404.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### Implemented specs (legacy v4, deleted with the v4 UI in Phase 1)

The four specs predate the pivot and exercise the v4 SaaS (Supabase
sign-in, organisations, bindings, `/api/v1/*` routes). They are kept only
until P1.6 replaces the UI; none of them passes against a v5 instance.

| Spec                                 | What it did                                                                                                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smoke.spec.ts`                      | the landing page of the deployed SaaS renders a "Sign in" call to action                                                                                       |
| `golden-path.spec.ts`                | password sign-in → dashboard → organisation → project → roles catalogue (skipped without credentials)                                                          |
| `mint-flow.spec.ts`                  | authenticated `/tokens/new`: binding cards, risk rows, "Mint token" disabled until a risk is accepted (skipped without credentials)                            |
| `real-clouds/stripe-connect.spec.ts` | `POST /api/v1/stripe-bindings` validation (account id prefix, missing keys) and the Stripe binding UI; credentials from `E2E_USER_EMAIL` / `E2E_USER_PASSWORD` |

### Planned v5 scenarios (written with the features)

Each scenario is added to this file, with its spec file, by the feature
that makes it possible. Target list (spec §4, §5, §7):

1. **Bootstrap and first sign-in** — operator signs in with the bootstrap
   token, configures the IdP, a user signs in through OIDC (P1.1).
2. **Connection and share** — a user connects a provider, shares the
   connection with a group under a restriction (P1.2, P1.4).
3. **Mission issuance** — done: `v5/issue-mission.spec.ts` (P1.5).
4. **Agent call through the execution door** — an MCP client calls a tool
   within budget (allowed, audited), then beyond it (`budget-exhausted`
   with a claim URL) (P1.6). The claim itself — who may open the URL, the
   creator's decision, the replay — is done: `v5/exhaust-and-claim.spec.ts`
   (P1.7), with the calls recorded below the door.
5. **Approval from the inbox** — a gated call produces an approval request;
   the human grants it from the inbox and the agent's retry passes (P2.1).
6. **Refusal surfaces** — `risk-not-accepted`, `resource-not-in-mission`,
   `connection-unavailable`, `mission-inactive` each reach the agent with
   its hint (P1.6).

## Conventions

- Playwright specs never create state in a real cloud; the "no mock"
  posture of v4 (`e2e-real-clouds` against a dedicated GitHub organisation)
  is retired with the SaaS. Provider calls in v5 E2E run against the mock
  upstream of the plugin test kit (`mockFetch`).
- Transient resources, when a scenario must create one, are named
  `vaubaan-e2e-<spec-hash6>-<run-uuid8>` and removed by the scenario's
  teardown; there is no sweeper job.
