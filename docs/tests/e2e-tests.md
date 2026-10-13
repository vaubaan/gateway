---
title: E2E tests
status: current
date: 2026-05-22
last_synced: 2026-10-13
tracks:
  - playwright.config.ts
  - apps/gateway/tests/e2e/
  - deploy/docker/smoke.sh
  - .github/workflows/ci.yml
---

# E2E tests

Two kinds of end-to-end check exist today:

1. the **container smoke test** (`deploy/docker/smoke.sh`), automated in CI
   since P0.4 — the only E2E check of the v5 build so far;
2. the **Playwright harness** (`playwright.config.ts`), wired but holding
   only legacy v4 specs that target the retired SaaS; nothing in CI runs
   it.

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
3. **Mission issuance** — a mission over two connections with a budget per
   risk; the token is shown once (P1.3, P1.5).
4. **Agent call through the execution door** — an MCP client calls a tool
   within budget (allowed, audited), then beyond it (`budget-exhausted`
   with a claim URL) (P1.6).
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
