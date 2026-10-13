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
Building the web application…
  … building the composition root
  … seeding people, connections, missions and calls
  … starting the web application

Open        http://localhost:3210
…
```

| Variable            | Effect                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `DEMO_PORT=<port>`  | listen on another port (default 3210; `0` lets the system pick one, as the smoke test does)                                  |
| `DEMO_KEEP=1`       | keep the SQLite file and the instance log on exit, and say where they are                                                    |
| `DEMO_SKIP_BUILD=1` | serve the build already under `apps/gateway/.next` as it is, whatever it was built from (it still builds when there is none) |

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

The command prints a tour: the URL, the accounts, the tokens of three seeded
missions and of the named token "CI runner", with
ready-made `curl` commands, and the list below with this run's request URLs.

### Starting it

The application is built on the first start, and again only when a file a
build reads has changed since (`build-stamp.ts`). After a build the command
writes a stamp, `demo-build-stamp`, inside `apps/gateway/.next`: the SHA-256
of the path and the contents of every build input (`BUILD_INPUTS`: the
application's `src`, `public`, `migrations`, `next.config.ts`,
`package.json` and `tsconfig.json`, the whole of `packages/` and `plugins/`,
and the root `package.json`, `package-lock.json` and `tsconfig.base.json`),
directories named `node_modules`, `.next`, `dist`, `tests` or `.turbo` left
out. At the next start the digest is computed again, before anything is
built:

| What is under `apps/gateway/.next`       | The command says                                                          | And does                 |
| ---------------------------------------- | ------------------------------------------------------------------------- | ------------------------ |
| a build whose stamp equals the digest    | `The web application is already built from these sources.`                | serves it                |
| a build with another stamp, or with none | `The sources changed since the last build: building the web application…` | builds, stamps, serves   |
| no build                                 | `Building the web application…`                                           | builds, stamps, serves   |
| a build, and `DEMO_SKIP_BUILD=1`         | `Serving the existing build as it is (DEMO_SKIP_BUILD=1).`                | serves it, digest unread |

The digest is over contents, not dates: a checkout that rewrites a file with
the same bytes costs no build, an edit always does, and so does a file added
or renamed. A build made by anything else (`npm run build`, the CI) carries
no stamp and is rebuilt once. The stamp lives in the build directory, so it
goes away with the build. The digest is taken before the build starts: a
file edited while it runs makes the next start build again.

## Accounts

No password. The sign-in page of the application redirects to the demo
identity provider, which shows an account picker.

| Account | Who                                 | Sees                                                                                                                                                   |
| ------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Alice   | owner and operator                  | her connections, missions in every state, two open requests, a share received from Carol, the audit of the whole instance, the Admin pages             |
| Bob     | teammate (share beneficiary)        | no connection of his own, one share received from Alice, one mission issued within it, and Alice's "Ship the billing page" shared with him as a member |
| Carol   | member of the "GitHub admins" group | the GitHub connection owned by that group, her own Stripe connection (test and live as two resources), whose test mode she shares to Alice             |

Alice is the operator because the demo's admin rule lists her email. To
switch account, open your name at the foot of the side navigation and "Sign
out": it returns to the picker.

## What is seeded

Created by `seed.ts` through the application's own code paths (see
[How it is built](#how-it-is-built)), so every state is one the application
can reach by itself.

| For   | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alice | **Connections**: "Acme product repositories" (GitHub, four repositories); "Acme platform repositories" (GitHub, transferred to the local group "GitHub admins"); "Acme cache" (Upstash Redis, databases labelled `prod` and `staging`); "Acme transactional mail" (Resend, the staging domain labelled, the production domain and the segment left without a label: the mission form and the share dialog warn about it); "Acme DNS" (Cloudflare)                                                                                                                                                                                                                                            |
|       | **A share** of "Acme product repositories" to Bob, restricted to five risks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
|       | **Missions**: "Ship the billing page" (active, GitHub + Redis, a session of calls under the agent labels `planner` and `coder`, one refused call; **a team**: Bob is a member and has generated his own token, and a named token "CI runner" exists, each with calls of its own); "Nightly dependency audit" (quota spent, **open claim**); "Release 2.4 hotfix" (the `release-manager` preset, **open approval request** for a merge, with its arguments); "Migration dry-run (finished)" (expired); "Spike: move the status page DNS" (revoked); "Fix the flaky checkout test" (issued by the delegated client "Claude Code (demo)"); "Tour: a tiny quota to exhaust" (fresh, three reads) |
|       | **A delegation** to "Claude Code (demo)", a client registered through dynamic registration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Bob   | "Review the docs pull requests", issued within the share, with two calls; member of Alice's "Ship the billing page" ("Shared with me"), with his own token                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Carol | "Acme billing" (Stripe, test and live), its test mode shared to Alice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Admin | local groups "GitHub admins" (Alice, Carol) and "Contractors" (Bob), next to the IdP group `engineering`; the GitHub App as provider app; telemetry off and locked by the configuration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Audit entries are the ones those acts and calls wrote.

## The tour

The list the command prints (`tour.ts`), without the values of the run
(port, tokens, request URLs):

1. **Sign in as Alice.** Missions lists the seeded missions in every state:
   running, waiting for you (a limit reached, a yes to give), expired,
   stopped, prepared by an agent.
2. **Connect a provider**: Connections → Connect a provider.

   | Provider   | What to type                                              |
   | ---------- | --------------------------------------------------------- |
   | Stripe     | test key `sk_test_demo`, live key `sk_live_demo`          |
   | Cloudflare | API token `demo-cloudflare-token-0123456789`              |
   | Resend     | API key `re_demo_key`                                     |
   | Upstash    | any email address, API key `demo-key`                     |
   | Vercel     | token `demo-vercel-token`, team id `team_demo`            |
   | GitHub     | opens a simulated installation page: pick an organisation |

   Any value of the right shape is accepted. Supabase and Railway connect
   through an OAuth app the demo does not configure: the picker says so.

3. **Read what a provider is**: Providers → GitHub. What the plugin connects
   to, then four tabs: its presets side by side against the risks, each risk
   with the reason it is a risk and its six-cell profile, its data model, its
   tools. Supabase adds a plane control (db, storage, auth, functions).
4. **Create a mission on one screen**: Missions → New mission. Include an
   account and pick a preset: it says what it yields here, and the rail says
   what the mission will be able to do. **Edit the permissions one by one**
   opens every permission with its limits and "ask me first". **Create
   mission** lists every permission with its limit before anything exists.
5. **Read what follows the creation**: the key (shown once), then the kit —
   the MCP client configuration, the instructions for the agent, a `curl`.
6. **Call `tools/list` on `/mcp`** with a mission token: the kit's own
   command, or the one the tour prints for the seeded mission "Ship the
   billing page" (`$VAUBAAN_MISSION_TOKEN`).
7. **Exhaust a quota.** The mission "Tour: a tiny quota to exhaust" allows
   three file reads: the printed loop reads a file four times with
   `$VAUBAAN_QUOTA_TOKEN`, and the last answer is a refusal
   `budget-exhausted` carrying a `claim_url`. Open it as Alice (or Requests),
   grant a reset or an extension, run the loop again. An older claim is
   already waiting; the tour prints its URL.
8. **Approve the pending action**: Requests shows a merge of pull request
   #128 with its arguments (the tour prints the request's URL). Approve it,
   then replay the call with exactly the same arguments (the printed `curl`,
   `$VAUBAAN_APPROVAL_TOKEN`).
9. **Give access to Bob**: Accounts → "Acme product repositories" → Give
   access. Bob already holds one ("Who has access"); sign out, sign in as
   Bob: Accounts → "Shared with you", and his mission.
10. **Remove that access** as Alice ("Who has access" → Remove, asked first);
    as Bob, his mission is stopped and every call with its key is refused.
    **Give access again** as Alice: the dialog names the mission it brings
    back — same key, same limits.
11. **Work on a mission as a team.** Alice added Bob as a member of "Ship the
    billing page" and created the named token "CI runner". Sign in as Bob:
    Missions → "Shared with you" → that mission. He reads it and cannot
    change it. Behind "···", **Replace my key**: the dialog says his current
    key stops at once; his new key is shown once, to him, with the kit; Alice
    never sees it. Copy the export line of the dialog, then ask the gateway
    whose key it is
    (`curl …/mcp/catalog` with `$VAUBAAN_MISSION_TOKEN`, printed by the
    tour): the answer reads
    `"token": { "kind": "member", "holder": "bob@…" }`. The machine's token
    (`$VAUBAAN_CI_TOKEN`) answers with its name. Sign in as Alice: "People
    and keys" lists Bob and "CI runner" with what each key did today;
    "Everything this mission did" has "Who called", and each call of the
    timeline names its holder. Remove Bob (you type his address): his key is
    refused at once (401, reason `holder-removed`), the others keep working.
12. **Audit**: every call and every administrative act, with filters
    (mission, token holder, agent label, decision). On a mission,
    "Everything this mission did" shows the calls of the current period per
    key holder and per agent label (`planner`, `coder`).
13. **Admin**, as Alice (she is the operator): Identity provider, Provider
    apps (the GitHub App), Groups ("GitHub admins", "Contractors"),
    Connections without owner, OAuth clients ("Claude Code (demo)"),
    Telemetry (off).
14. **Sign in as Carol**: she sees the GitHub connection owned by the group
    "GitHub admins", which Alice transferred to it, and her own Stripe
    account (test and live mode as two resources), whose test mode she shares
    to Alice.

## How it is built

```
apps/gateway/tests/demo/
  main.ts            the command: guards, build when the sources changed, global-fetch guard, start, tour, shutdown
  build-stamp.ts     sourceDigest(), buildIsFresh(), writeBuildStamp(): is the build that of the sources as they are
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
  demo-vercel.test.ts  the shipped Vercel plugin against the simulated Vercel: discovery, a REST tool, a rewrapped tool
  build-stamp.test.ts  the stamp: fresh while no input changed, stale once one changed or a file was added
```

`startDemo()` (`demo-instance.ts`), in order:

1. **Listen** on `127.0.0.1:<port>` with a handler that answers 503 until the
   rest is ready. The port is known first because it is part of the public
   URL.
2. **Configuration**, in memory. `loadInstanceConfig` is called with an
   environment built here — a master key and a bootstrap token generated for the run (the token is never printed), a store path
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
common tools), Stripe, Cloudflare DNS, Resend, Upstash Redis and Vercel. Every URL is
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

**Vercel** is one team (`acme`) and two projects, `acme-storefront` and
`acme-docs`, each with a production and a preview deployment and two
environment variables. A connection made with the token `demo-vercel-token`
and the team id `team_demo` (any team id is answered: the demo has one team)
discovers the two projects, each with the environments `prod`, `preview` and
`development`. The routes answer the team and project listing of discovery,
the environment-variable endpoints of the REST API (list, create, delete),
the deployment lookup that binds a deployment to its project, and the remote
MCP server the plugin rewraps: one JSON-RPC exchange answered as one SSE
frame of canned text (teams, projects, a project, deployments, build and
runtime logs; any other tool answers `{ "simulated": true }`).

**Upstash Redis**: the REST endpoint of a simulated database is a host under
the plugin's pinned REST suffix (`<database name>.upstash.io`, built from
the plugin's `UPSTASH_REST_HOST_SUFFIX`). The plugin posts a database's token
to a host of that domain and to no other, so a simulated host anywhere else
would be refused by the plugin itself. Like every provider URL here it is
answered from memory and never dialled.

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
- the team through `MissionTeamService`: `addMember` as Alice, `generateToken`
  as Bob (his token is his: the seed uses it for his calls and prints it
  nowhere), `createNamedToken` as Alice;
- missions through `MissionService.issue` / `revoke`; the delegated one
  through the OAuth handlers (registration, consent answered with Alice's
  session, code exchange) and `issue_mission` on the management door;
- calls through `execution.handlers.mcp` with the mission token and an agent
  label: the quota is spent by real calls, the claim and the approval request
  are opened by the door;
- the expired mission is issued with an expiry two seconds ahead, and the seed
  ends after that instant.

`SeedSummary` carries what the tour prints (three tokens of Alice's missions,
the named token of the team mission, the two request URLs, the names).

## Safety

| Guarantee                          | How                                                                                                                                                                                                                                                  | Held by                             |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Not in the image                   | the demo lives under `apps/gateway/tests/`; no file of `tests/` is in `.next/standalone`, no built file names `/__demo`                                                                                                                              | `demo-safety.test.ts` (after build) |
| No seam in the application         | nothing under `apps/gateway/src/` names the demo; a normally composed root has GitHub's own `installUrl`, an https public URL and no IdP                                                                                                             | `demo-safety.test.ts`               |
| Refuses a real environment         | `assertDemoAllowed`: `NODE_ENV=production`, `VAUBAAN_CONFIG_FILE` or `VAUBAAN_PUBLIC_URL` set → exit 2 before anything is opened                                                                                                                     | `demo-safety.test.ts`               |
| Nothing leaves the machine         | provider calls go to `providers.ts`; the SSH plugin is not registered; telemetry and client-document fetches refuse; the command also replaces the global `fetch` with one that refuses any host but the loopback, and disables Next's own telemetry | `providers.ts`, `main.ts`           |
| Not reachable from the network     | the listener binds `127.0.0.1`                                                                                                                                                                                                                       | `demo-instance.ts`                  |
| No lasting secret, no lasting data | master key, bootstrap token, GitHub App key pair, IdP signing key and client secrets are generated per run and kept in memory; the SQLite file is in a `mkdtemp` directory deleted on exit                                                           | `demo-smoke.test.ts` (deletion)     |
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
- **Stale pages after pulling**: the command rebuilds when a build input
  changed, unless `DEMO_SKIP_BUILD=1`, which serves whatever build is there.
  To force a build, delete `apps/gateway/.next/demo-build-stamp`.
- **A connect attempt is refused as rate-limited**: the real per-user connect
  limit (10 per minute) applies after the seed.

## Tests

`apps/gateway/tests/integration/demo/` ([integration-tests](../tests/integration-tests.md),
"Demo mode"). `demo-smoke.test.ts` needs a build and is skipped without one;
`npm run ci` builds first. Two files need neither a build nor a listener:
`demo-vercel.test.ts` runs the shipped Vercel plugin against the demo's
`fetch` (a connection made with the tour's values discovers the team's two
projects with their three environments; a REST tool and a rewrapped tool
answer; discovery sent `GET` requests only, all to simulated routes), and
`build-stamp.test.ts` holds the stamp on a temporary tree (an unstamped
build is not fresh; fresh while no input changed, whatever the file dates;
stale once an application source, a workspace package, a plugin catalog or
the lockfile changed; another digest when a file is added; tests,
dependencies and the build itself ignored; not fresh without a build even
with a matching stamp; the stamp inside the build directory, the input list
naming the application sources and the plugins).

## Limits

- One process, one run: every start is the seeded state again. `DEMO_KEEP=1`
  keeps the files for inspection; it does not resume from them.
- Simulated answers are canned: a write changes nothing a later read shows
  (an environment variable created on the simulated Vercel is not in the
  next listing).
- Vercel's rewrapped tools answer canned text from one team and two
  projects; a tool the simulation has no answer for returns
  `{ "simulated": true }` with its name.
- Supabase, Railway and Gmail need a company app, which the demo does
  not register; registering one in Admin → Provider apps does not make the
  provider real, the code exchange is still refused. SSH is absent.
- **The Administration overview says "build dev" while the page footer shows
  the stamped version.** The footer is rendered by the built application,
  where the version and the commit were frozen at build time; the overview
  reads the build of the composition root, and the demo composes the root in
  its own process, outside the built application, where nothing is stamped.
  Whatever else reads the root's build says `dev` in the demo for the same
  reason (`/healthz`, the footer of the authorization server's pages). An
  instance started from the image has one process and one stamp.
- The build stamp sees the build inputs listed above and nothing else: a
  change to a file outside them does not trigger a build.
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
