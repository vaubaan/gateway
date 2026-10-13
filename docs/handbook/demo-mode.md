---
title: Demo mode — the whole interface in a browser, with a simulated identity provider and simulated providers
status: current
date: 2026-10-13
last_synced: 2026-10-13
tracks:
  - apps/gateway/tests/demo/
  - apps/gateway/tests/integration/demo/
  - apps/gateway/tests/integration/auth/fake-idp.ts
  - packages/plugin-sdk/src/catalog-path.ts
---

# Demo mode — the whole interface in a browser, with a simulated identity provider and simulated providers

`npm run demo` starts the real application on `http://localhost:3210`, signed
into through a demo identity provider, connected to simulated providers and
already filled with data, so that somebody can click through every page
without registering an OIDC client or a provider app. Nothing leaves the
machine. Decision: [local-demo-mode](../decisions/local-demo-mode.md).
Neighbours: [authentication](authentication.md) (the sign-in that runs
unchanged), [connections](connections.md) (the connect flows),
[missions](missions.md), [requests](requests.md), [authority](authority.md),
[audit](audit.md), [execution-door](execution-door.md),
[management-door](management-door.md), [configuration](configuration.md)
(the composition root and its injection points). The browser tests' ephemeral
instance ([e2e-tests](../tests/e2e-tests.md)) is the same construction for a
robot; the demo is the one for a human. One difference: the browser tests
start the standalone `server.js` the image ships, the demo serves the built
application through `next({ dev: false })` (step 5 below).

**It is not an instance.** Anybody who reaches the listener signs in as
anybody, without a password. It is a development tool, never deployed: see
[Safety](#safety).

## Run it

```console
$ npm run demo
DEMO — simulated identity provider and providers, no data leaves this machine
Building the web application (DEMO_SKIP_BUILD=1 serves the existing build)…
  … building the composition root
  … seeding people, connections, missions and calls
  … starting the web application

Open        http://localhost:3210
…
```

| Variable            | Effect                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `DEMO_PORT=<port>`  | listen on another port (default 3210; `0` lets the system pick one, as the smoke test does) |
| `DEMO_KEEP=1`       | keep the SQLite file and the instance log on exit, and say where they are                   |
| `DEMO_SKIP_BUILD=1` | serve the build already under `apps/gateway/.next` instead of running `next build` first    |

- **Browser.** Chrome and Firefox accept the session cookie — marked `Secure`,
  as on a real instance — on `http://localhost`. Safari does not: use Chrome
  or Firefox.
- **From another machine.** The listener is bound to `127.0.0.1`. Forward the
  port and open the same URL on your side:
  `ssh -L 3210:localhost:3210 <host>`. The URL must stay
  `http://localhost:<port>`: it is the instance's public URL, the redirect URI
  of the sign-in and the origin every form is checked against.
- **Stop.** `Ctrl-C`. The data directory is deleted unless `DEMO_KEEP=1`.
  Every run starts from the same seeded state.

The command prints a tour: the URL, the accounts, three mission tokens with
ready-made `curl` commands, and the list below with this run's request URLs.

## Accounts

No password. The sign-in page of the application redirects to the demo
identity provider, which shows an account picker.

| Account | Who                                 | Sees                                                                                                                                       |
| ------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Alice   | owner and operator                  | her connections, missions in every state, two open requests, a share received from Carol, the audit of the whole instance, the Admin pages |
| Bob     | teammate (share beneficiary)        | no connection of his own, one share received from Alice, one mission issued within it                                                      |
| Carol   | member of the "GitHub admins" group | the GitHub connection owned by that group, her own Stripe connection (test and live as two resources), whose test mode she shares to Alice |

Alice is the operator because the demo's admin rule lists her email. "Sign
out" in the top bar returns to the picker.

## What is seeded

Created by `seed.ts` through the application's own code paths (see
[How it is built](#how-it-is-built)), so every state is one the application
can reach by itself.

| For   | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alice | **Connections**: "Acme product repositories" (GitHub, four repositories); "Acme platform repositories" (GitHub, transferred to the local group "GitHub admins"); "Acme cache" (Upstash Redis, databases labelled `prod` and `staging`); "Acme transactional mail" (Resend, the staging domain labelled, the production domain and the segment left without a label: the mission form and the share dialog warn about it); "Acme DNS" (Cloudflare)                                                                                                             |
|       | **A share** of "Acme product repositories" to Bob, restricted to five risks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
|       | **Missions**: "Ship the billing page" (active, GitHub + Redis, a session of calls under the agent labels `planner` and `coder`, one refused call); "Nightly dependency audit" (quota spent, **open claim**); "Release 2.4 hotfix" (the `release-manager` preset, **open approval request** for a merge, with its arguments); "Migration dry-run (finished)" (expired); "Spike: move the status page DNS" (revoked); "Fix the flaky checkout test" (issued by the delegated client "Claude Code (demo)"); "Tour: a tiny quota to exhaust" (fresh, three reads) |
|       | **A delegation** to "Claude Code (demo)", a client registered through dynamic registration                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Bob   | "Review the docs pull requests", issued within the share, with two calls                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Carol | "Acme billing" (Stripe, test and live), its test mode shared to Alice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Admin | local groups "GitHub admins" (Alice, Carol) and "Contractors" (Bob), next to the IdP group `engineering`; the GitHub App as provider app; telemetry off and locked by the configuration                                                                                                                                                                                                                                                                                                                                                                       |

Audit entries are the ones those acts and calls wrote.

## The tour

1. **Sign in as Alice.** Missions lists every state: active, quota spent,
   waiting for an approval, expired, revoked, issued by an agent.
2. **Connect a provider**: Connections → Connect a provider. Stripe (test key
   `sk_test_demo`, live key `sk_live_demo`), Cloudflare DNS (API token
   `demo-cloudflare-token-0123456789`), Resend (`re_demo_key`), Upstash Redis
   (any email, any key), GitHub (a simulated installation page: pick an
   organisation). Any value of the right shape is accepted. Vercel has no
   simulation: connecting it fails with a message that says so, and nothing
   is sent.
3. **Read what a provider is**: Providers → GitHub. What the plugin connects
   to, its data model as a tree, each risk with the reason it is a risk and
   its six badges, each preset with everything it contains, the tools.
4. **Issue a mission on one screen**: Missions → New mission. Include a
   connection and pick a preset: the block says what it allows, what waits
   for your approval and what it leaves out. Switch to **Custom** to accept
   risks one by one — every risk is listed with its quota, rate limit and
   gate, "Start from preset…" pre-fills, and going back to Preset after an
   edit asks first.
5. **Open the bootstrap kit** shown right after issuing: the token (shown
   once), the MCP client configuration, the instructions for the agent, a
   `curl`.
6. **Call `tools/list` on `/mcp`** with a mission token: the kit's own
   command, or the one the tour prints for the seeded mission
   (`$VAUBAAN_MISSION_TOKEN`).
7. **Exhaust a quota**: the printed loop reads a file four times with
   `$VAUBAAN_QUOTA_TOKEN`; the fourth answer is a refusal `budget-exhausted`
   carrying a `claim_url`. Open it as Alice (or Requests), grant a reset or an
   extension, run the loop again.
8. **Approve the pending action**: Requests shows the merge of pull request
   #128 with its arguments. Approve it, then replay the call with exactly the
   same arguments (the printed `curl`, `$VAUBAAN_APPROVAL_TOKEN`): it now
   executes.
9. **Share to Bob**: Connections → "Acme product repositories" → Share. Bob
   already holds a share of it; sign in as Bob to see Shares received and his
   mission.
10. **Revoke that share** as Alice: Bob's mission reads `orphaned` and every
    call with its token is refused. **Share again**: the same mission comes
    back, same token, same counters.
11. **Audit**: every call and administrative act, with filters (mission, agent
    label, decision). On a mission, "Session" shows the calls of the current
    period per agent label.
12. **Admin**, as Alice: Identity provider, Provider apps, Groups, Connections
    without owner, OAuth clients, Telemetry.
13. **Sign in as Carol**: the group-owned GitHub connection and her Stripe
    account.

## How it is built

```
apps/gateway/tests/demo/
  main.ts            the command: guards, build, global-fetch guard, start, tour, shutdown
  guards.ts          assertDemoAllowed(env), demoPort(env), DemoRefusal
  demo-instance.ts   startDemo(): listener, configuration, composition root, seed, Next
  demo-idp.ts        DemoIdp (FakeIdp over HTTP under /__demo/idp), the account picker, demoPage()
  providers.ts       createDemoProviders(): the one `fetch` of every provider request
  people.ts          Alice, Bob, Carol; the names of the local groups
  seed.ts            seedDemo(): what the instance contains on first load
  tour.ts            the banner and the printed tour
apps/gateway/tests/integration/demo/
  demo-smoke.test.ts   spawns the command, signs in over HTTP, reads the pages, calls /mcp, stops it
  demo-safety.test.ts  the guards; no demo file in the build; no demo seam in the application
```

`startDemo()` (`demo-instance.ts`), in order:

1. **Listen** on `127.0.0.1:<port>` with a handler that answers 503 until the
   rest is ready. The port is known first because it is part of the public
   URL.
2. **Configuration**, in memory. `loadInstanceConfig` is called with an
   environment built here — a master key generated for the run, a store path
   under a fresh `mkdtemp` directory of the OS temp dir, `ALICE`'s email as
   the admin rule, `telemetry.enabled: false`, the `providers.github` block of
   a GitHub App whose RSA key pair and secrets are generated for the run — and
   an https placeholder as `public_url`, because **the loader accepts https
   only and is not changed**. The typed result then gets
   `publicUrl = http://localhost:<port>` and the demo IdP as `idp`. Nothing is
   read from the process environment or from a file.
3. **The composition root**, through `getRoot(deps)`: it is published on
   `globalThis` exactly as in production, so the Next application started in
   step 5 serves on it ([web-app](web-app.md), "One root, several module
   graphs"). The
   injection points used, all pre-existing:

   | `RootDeps`            | Demo value                                                                                             |
   | --------------------- | ------------------------------------------------------------------------------------------------------ |
   | `loadConfig`          | the configuration of step 2                                                                            |
   | `buildRegistry`       | the shipped plugins without SSH, GitHub's `installUrl` pointed at `/__demo/github/install` (see below) |
   | `oidc`                | `allowInsecureIssuer` (the issuer is `http://localhost`), and a `fetch` that dials `127.0.0.1` for it  |
   | `providerFetch`       | `createDemoProviders().fetch`                                                                          |
   | `telemetryFetch`      | refuses                                                                                                |
   | `clientDocumentFetch` | refuses                                                                                                |
   | `rateLimiter`         | the real sliding-window limiter, lifted while the seed runs                                            |
   | `logWrite`            | appends to `gateway.log` in the data directory                                                         |

   The store is the default one: the SQLite file of `store.path`.

4. **Seed** (`seedDemo`), then the surface rate limits apply again.
5. **Next**: `next({ dev: false })` on the built application, behind the same
   listener. Paths under `/__demo/` are answered by the demo; everything else
   goes to the application.

### The demo identity provider

`DemoIdp` extends the suite's `FakeIdp`
(`tests/integration/auth/fake-idp.ts`: discovery, JWKS, token and userinfo in
memory, ID tokens signed ES256 with a key generated per instance) and
publishes it over HTTP under `/__demo/idp/`: `metadata()` is overridden so
that the issuer and every endpoint carry the prefix, and `handle()` hands each
request to `FakeIdp.fetch`. The relying party of the application discovers it
and exchanges codes with it over HTTP on the listener, so `/login`,
`/auth/login`, the redirect and `/auth/callback` run as against any OIDC
provider. `GET /__demo/idp/authorize` is the account picker; choosing an
account adds `account=<key>` to the same URL, which validates the
authorization request (`FakeIdp.authorize`) and redirects to the callback with
a code bound to that person's claims (`sub`, `email`, `name`,
`groups: ['engineering']`).

### The simulated providers

`createDemoProviders()` returns one `fetch` built on the SDK's `mockFetch`
with routes for GitHub (the user verification of an installation, installation
tokens, the repositories of two installations, the REST endpoints of the
common tools), Stripe, Cloudflare DNS, Resend and Upstash Redis. Every URL is
read off the plugin that calls it (credential spec, exported API base). A
request no route answers throws `DemoProviderError` — "demo mode: no simulated
answer for `<METHOD> <URL>` — nothing was sent to the real provider" — which
the page shows as the provider's error and the command writes on stderr.
Adding an endpoint is one route in `providers.ts`.

GitHub's connect flow sends the browser to GitHub's installation page. The
demo cannot let a real browser go to github.com, so its registry is the
shipped plugins with **one function replaced**: `credential.installUrl` of the
GitHub plugin answers `/__demo/github/install`, a page that lists two
organisations and redirects back to `/connections/callback/github` with an
installation id, a code and the state. The rest of the flow is the shipped
code against the simulated API: the code exchange, the check that the
installation is among the user's, the installation token, discovery.

The SSH plugin is left out of the demo's registry: its calls do not go through
`fetch` but open connections to the host the user names, which no simulation
here answers.

### The seed

`seedDemo` runs in the process, on the root's host-agnostic handlers and
services, and writes nothing to the store directly:

- each person **signs in** (`auth.handlers.loginStart` → `DemoIdp.consent` →
  `loginCallback`): the account and its IdP group are created by the sign-in;
- groups through `GroupService`, connections through
  `ConnectionService.start` / `complete` (discovery runs against the simulated
  providers), labels through `updateResource`, the transfer through
  `transfer`, shares through `ShareService.share`;
- missions through `MissionService.issue` / `revoke`; the delegated one
  through the OAuth handlers (registration, consent answered with Alice's
  session, code exchange) and `issue_mission` on the management door;
- calls through `execution.handlers.mcp` with the mission token and an agent
  label: the quota is spent by real calls, the claim and the approval request
  are opened by the door;
- the expired mission is issued with an expiry two seconds ahead, and the seed
  ends after that instant.

`SeedSummary` carries what the tour prints (three tokens, the two request
URLs, the names).

## Safety

| Guarantee                          | How                                                                                                                                                                                                                                                  | Held by                             |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Not in the image                   | the demo lives under `apps/gateway/tests/`; no file of `tests/` is in `.next/standalone`, no built file names `/__demo`                                                                                                                              | `demo-safety.test.ts` (after build) |
| No seam in the application         | nothing under `apps/gateway/src/` names the demo; a normally composed root has GitHub's own `installUrl`, an https public URL and no IdP                                                                                                             | `demo-safety.test.ts`               |
| Refuses a real environment         | `assertDemoAllowed`: `NODE_ENV=production`, `VAUBAAN_CONFIG_FILE` or `VAUBAAN_PUBLIC_URL` set → exit 2 before anything is opened                                                                                                                     | `demo-safety.test.ts`               |
| Nothing leaves the machine         | provider calls go to `providers.ts`; the SSH plugin is not registered; telemetry and client-document fetches refuse; the command also replaces the global `fetch` with one that refuses any host but the loopback, and disables Next's own telemetry | `providers.ts`, `main.ts`           |
| Not reachable from the network     | the listener binds `127.0.0.1`                                                                                                                                                                                                                       | `demo-instance.ts`                  |
| No lasting secret, no lasting data | master key, GitHub App key pair, IdP signing key and client secrets are generated per run and kept in memory; the SQLite file is in a `mkdtemp` directory deleted on exit                                                                            | `demo-smoke.test.ts` (deletion)     |
| Said on every surface              | the banner "DEMO — simulated identity provider and providers, no data leaves this machine" is printed at start and shown on the picker and the installation page                                                                                     | `demo-smoke.test.ts`                |

The first line needed a fix outside the demo: the plugins' computed catalog
path made Next trace the whole `apps/gateway` directory into the standalone
output, test fixtures included. `catalogPathNextTo` now marks that path as
ignored by the bundler's tracing; the catalogs are still traced by name
([plugin-sdk](plugin-sdk.md), "Catalog path").

The pages of the application carry no demo banner: they are the application,
unmodified.

## How to debug

- **`The demo refuses to start: …`** (exit 2): the message names the variable
  or the port. Use a shell without `VAUBAAN_*`, or `DEMO_PORT`.
- **Sign-in loops back to `/login`**: the browser dropped the `Secure` cookie
  (Safari), or the page was opened as `http://127.0.0.1:<port>` or through a
  forwarded port with another number. Open `http://localhost:<port>`.
- **`demo mode: no simulated answer for …`** on a page or on stderr: a tool or
  a connect flow called an endpoint `providers.ts` does not simulate. Nothing
  was sent. Add the route.
- **A page shows an error**: `DEMO_KEEP=1 npm run demo`, then read
  `gateway.log` in the printed directory (the instance's structured log).
- **Stale pages after pulling**: the command rebuilds unless
  `DEMO_SKIP_BUILD=1`.
- **A connect attempt is refused as rate-limited**: the real per-user connect
  limit (10 per minute) applies after the seed.

## Tests

`apps/gateway/tests/integration/demo/` ([integration-tests](../tests/integration-tests.md),
"Demo mode"). `demo-smoke.test.ts` needs a build and is skipped without one;
`npm run ci` builds first.

## Limits

- One process, one run: every start is the seeded state again. `DEMO_KEEP=1`
  keeps the files for inspection; it does not resume from them.
- Simulated answers are canned: a write changes nothing a later read shows.
- Vercel is listed and not simulated: connecting it fails with the message
  above. Supabase, Railway and Gmail need a company app, which the demo does
  not register; registering one in Admin → Provider apps does not make the
  provider real, the code exchange is still refused. SSH is absent.
- The identity provider settings are read-only in Admin, as with a mounted
  configuration.

## References

- Decision: [local-demo-mode](../decisions/local-demo-mode.md).
- The same construction for the browser tests (which start the standalone
  `server.js` instead of `next()`):
  `apps/gateway/tests/e2e/v5/ephemeral-instance.ts`,
  [e2e-tests](../tests/e2e-tests.md).
- Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §4.2 (the pages), §10
  ("no integration test against a real provider").
