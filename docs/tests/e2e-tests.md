---
title: E2E tests
status: current
date: 2026-10-13
last_synced: 2026-10-14
tracks:
  - apps/gateway/tests/e2e/v5/playwright.config.ts
  - apps/gateway/tests/e2e/
  - apps/gateway/tests/manual/streaming-check.ts
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
   bootstrap token, enter issuer, client id and secret on Settings → Sign-in,
   "Test the sign-in", then sign in through the IdP as a person matching the
   admin rule. Settings → Setup then shows the bootstrap token as revoked.
3. **Register the company apps.** On Settings → Company apps, one app per
   service that needs one (GitHub App, Supabase, Railway, Google), each
   registered under the company's own account at that service.
4. **Connect an account** (Accounts → "Connect an account") at each service
   the owner has a v4 connection for today. Each account ends "connected" with
   its resources discovered; environments are labelled where the catalog holds
   permissions per environment.
5. **Create one mission per code project** (Missions → "New mission"). For
   each code project: its accounts, the resources of that project only, the
   plugin's developer preset for each account (`developer` for GitHub, Vercel
   and Railway, `staging-developer` for Supabase, and the equivalent for the
   others), limits that reset every day, **no expiry**. "Create mission"
   lists every permission with its limit before anything exists; the key is
   shown once on the page that follows, with the setup kit. Copy both.
6. **Replace `.mcp.json`.** In each code project, put the kit's client
   configuration (the instance's `/mcp` URL and
   `Authorization: Bearer ${VAUBAAN_MISSION_TOKEN}`) in place of the v4 entry,
   export the key in that variable, run the kit's verification `curl`, then start Claude Code
   and list the tools.
7. **Work a day.** Run the usual Claude Code workflow on every code project
   for one working day: read code, branch, commit, open pull requests, deploy
   previews, query and migrate the staging database, whatever the day brings.
8. **Log every refusal** in the table below, as it happens, and classify it.

### Pass criterion

**Zero unexpected refusal.** Every refusal met during the day is explained by
one of:

- a **limit** — `budget-exhausted` or `rate-limited`; the creator answered
  the request under "Waiting for you" (or waited for the window) and the
  replay passed;
- a **permission the mission does not hold** — `risk-not-accepted`, or
  `approval-required` on a permission the preset sets to "ask me first", for
  an action the owner agrees a `developer` mission should not do unattended;
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

One row per refusal, copied from the agent's output or from Activity
(filtered by mission and by decision; the code of a refusal is in the detail
of its line). The hint of the refusal says which
field to read.

| #   | When (UTC) | Code project / mission | Tool | Refusal code | Risk or resource | Expected? | Why / what was done |
| --- | ---------- | ---------------------- | ---- | ------------ | ---------------- | --------- | ------------------- |
| 1   |            |                        |      |              |                  |           |                     |
| 2   |            |                        |      |              |                  |           |                     |
| 3   |            |                        |      |              |                  |           |                     |

"Expected?" is one of `budget`, `risk not accepted`, `resource left out`, or
`UNEXPECTED`. For an unexpected row, "Why / what was done" names the fix
(preset entry, catalog entry, bug) and the commit that carries it.

Refusals that are expected before the day starts, because of what this version
ships (details in the handbook, "Known limits at M1"):

- `approval-required` on a permission the preset sets to "ask me first"
  (`gate: approval`): the owner opens the URL, approves ("Approve this
  call"), and the agent replays the same call. In the `developer`
  presets these are `github.workflow-write-via-file`,
  `github.mint-install-token-push`, `railway[prod].deploy` and
  `railway[prod].upsert-variable`. It is a refusal by design, logged as
  expected; a replay that asks again with unchanged arguments is not.
- Gmail exposes no tool (experimental plugin, classifier only).
- A tool is listed as soon as the mission holds an account of its service,
  then refused `risk-not-accepted` if the mission does not hold the
  permission it needs: the tool list is filtered per service, not per tool.

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
| Accounts connected (services)         |       |
| Code projects / missions created      |       |
| Refusals logged (expected/unexpected) |       |
| Verdict (M1 signed / blocked)         |       |
| Follow-ups (presets, catalogs, bugs)  |       |

## Cutover smoke (automated)

> `apps/gateway/tests/e2e/v5/cutover-smoke.spec.ts`. One Playwright test that
> walks the path of the scenario above on an ephemeral instance. Runs in the
> `e2e` job of `.github/workflows/ci.yml` on every push and pull request to `main` and `v5`, and
> locally with `npm run test:e2e:v5`.

What it does, in order:

1. **Sign in** — no session sends the browser to `/login`; the round trip
   through the simulated IdP's consent screen lands on `/accounts` as a
   user who owns nothing: one sentence, and the services to connect.
2. **Connect GitHub** — "Connect an account" jumps to the services (one that
   needs a company app nobody registered says so) → GitHub → the how-to is
   folded until asked → "Continue to GitHub";
   the browser goes to the App's installation page (mocked) and comes back on
   `/connections/callback/github` with the installation id, the user
   authorization code and the single-use state; the instance exchanges the
   code, checks the installation against the user's installations, mints an
   installation token and discovers two repositories. The page of the
   account says "Connected", whose it is, both repositories as resources, that
   no mission uses it and that nobody else holds it.
3. **Create a mission** — on `/missions/new`: name, the GitHub account, the
   plugin's `Developer` preset, one repository left out ("1 of 2"; the rail
   says "Nor the other 1 resource." and that the mission never expires), and
   — behind "Edit the permissions one by one" — the limit of
   `github.read-code` lowered to 2. The key is shown once, with the kit: a
   client configuration that names `<public_url>/mcp` and never the key, the
   `tools/list` verification, and instructions that cite the selected
   repository and not the other.
4. **`tools/list` and `tools/call` over HTTP on `/mcp`** — without a key: 401. With the mission's key: the kit's plain JSON-RPC `tools/list`, then the
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
7. **Claim** — the creator opens the URL, lands on the request ("… reached a
   limit", "2 of 2"), the count beside "Waiting for you" in the navigation
   reads one; "Give back some calls", one call
   → "Answer recorded", the request reads "answered", the count is gone.
8. **Replay** — the same call, same key, passes; the next one is refused
   again (one action was given back, not more).
9. **Activity** — the six `github__list_branches` lines of the mission (three
   allowed, one "resource not in this mission", two "limit reached") with the
   agent label, the write that was refused ("permission not in this
   mission"), the creation of the mission; the 64-hex fingerprint of the
   arguments in the detail of a line; neither the mission's key nor the
   installation token is in the page.
10. **The mission and its activity** — the mission page says "Limit reached";
    "Everything this mission did" leads to `/missions/<id>/session`:
    `github.read-code` at "Limit reached", the agent label seen, the three
    "allowed" calls with what was left after each, the two "limit reached"
    lines with their code `budget-exhausted`, the creator's "+1 given back",
    and "Review and answer" on the request the last refusal opened.

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
looks for it, and then starts **the server that ships**: the standalone
`server.js` of the build (`apps/gateway/.next/standalone/apps/gateway/server.js`),
required as is, the way `deploy/docker/Dockerfile` runs it — `.next/static` and
`public/` copied beside it, `PORT` and `HOSTNAME` in the environment. The
launcher wraps nothing: `server.js` owns the listening socket, and its
`getRoot()` finds the root already there. A file the build fails to trace into
the standalone tree (a migration, a plugin catalog, a native addon) therefore
fails the suite, and Next no longer prints that `next start` does not work with
`output: standalone`.

The app listens on `E2E_V5_PORT` (default 3105) and the launcher's control
endpoints on **the next port** (`controlPort()` in `instance.ts`): set another
port, with the one after it free, when several checkouts run the suite on one
machine. The launcher runs from the repository's sources with `tsx`; it needs
nothing of `tests/` inside the standalone tree.
Injected through `RootDeps`, and nothing else: the `FakeIdp` of the authentication suite as the relying
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
(`E2E_SHARE_OWNER` — Ines, an IdP user of her own —, `E2E_SHARE_TARGET`,
`E2E_OPERATOR`, whose email the instance's admin rule names) and its own
connections, so it changes nothing the other specs read. The simulated IdP has **no default user**:
each spec names the user it signs in as in its `beforeEach` (`signInAs`), and
a spec that does not fails at its sign-in.

The instance's `public_url` is `https://gateway.e2e.test`; the browser context
routes that origin to the local listener (`browser.ts`), so cookies stay
`Secure` and the origin check sees the public origin. Navigation redirects are
answered as pages that navigate, because Playwright does not route the hops of
a redirect. The pages a browser is sent to outside the instance are answered
by control endpoints that exist only in the launcher, under `/__e2e` on the
control port (`controlUrl('/<endpoint>')`); the app's port answers 404 for that
path, as the image does:

| Endpoint                          | What it does                                                                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `idp/authorize`, `idp/next-user`  | the simulated IdP's consent, and who signs in next                                                                                     |
| `provider-pages`, `provider-page` | the provider pages of the connect flows (the GitHub App's installation page) and the way back                                          |
| `verify-token`                    | what `MissionService.verifyToken` says of a bearer                                                                                     |
| `small-mission`                   | issues a mission of Ada with a two-action quota on `github.read-code`; returns its token                                               |
| `developer-mission`               | issues a mission of `E2E_APPROVER_USER` from the GitHub `developer` preset as shipped, on a connection of their own; returns its token |
| `upstream`                        | what the mocked provider received, and whether each request carried the installation token                                             |
| `seed-day`                        | issues a mission for `E2E_AUDIT_USER` and leaves a day of calls and their audit entries on it                                          |
| `share-scenario`                  | the share spec's cast known to the instance, and a GitHub connection owned by `E2E_SHARE_OWNER`                                        |

`seed-day` is the one fixture written **below the door**: the calls are
recorded through `root.budget.recordCall` and the audit writer
(`tests/integration/audit/support.ts`), because the day holds calls on gated
and exhausted risks, by tools no mocked provider answers. Everything else goes
through the door.

Both listeners — the app and the control endpoints — keep an idle connection
open for 180 s (`IDLE_SOCKET_MS` in `ephemeral-instance.ts`: the control
server's `keepAliveTimeout`, and `KEEP_ALIVE_TIMEOUT` for the standalone
`server.js`), longer than the 120 s a test may last. Playwright forwards the
browser's requests with its own HTTP client, which reuses its connections and
does not retry a reset; with the 5 s default of a Node server, a test that
left the page alone for about that long could send its next request on a
connection being closed (`route.fetch: socket hang up`).

A request still in flight when a test ends is ignored by the router.
`E2E_V5_SCREENSHOT_DIR=<folder>` keeps a screenshot of each step.

### Specs

| Spec                        | Signs in as                   | Scenario                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cutover-smoke.spec.ts`     | `E2E_CUTOVER_USER`            | **Cutover smoke**: see [above](#cutover-smoke-automated).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `issue-mission.spec.ts`     | `E2E_USER`                    | **Create a mission**: no session → sign-in through the simulated IdP; experimental service hidden until toggled; the rail says what stands in the way in the interface's words; name, three accounts, one preset each (a chip per preset with how many permissions it yields, and "Custom"); **the rail** per account (Can / Asks you / Cannot) and what the mission carries, with no protocol word; **a preset says what it means** (one sentence, then 8 run freely · 2 ask you first · 4 not included, link to `/reference/github#preset-developer`); **compact by default** (no editor open, ≤ 6 visible checkboxes, page ≤ 2 viewports at 1280×800, the Create button in view before and after scrolling); resource deselection drops the preset's staging entries and says so; **the permissions one by one** open in place on the preset's values (15 GitHub permissions by label, id and severity word; "why?" closed, then the reason, the six words, the reference in a new tab), one limit and one "ask me first" adjusted (the chip says "adjusted"), another preset asks before discarding; the Supabase catalog is searchable, "All" lists what is not available with the reason, and one plane can be chosen; **"Create mission" asks once and the dialog lists every permission with its limit**; **the key shown once on the page that follows**, with the kit; the mission page never holds it, marks nothing on a running mission, keeps the masked key behind "Show details" and **the explicit list one click away, remembered** (what was used, "why?" leading to the reference); **Replace key asks first and states the consequence** (cancelling keeps the key valid; Escape does not close the dialog that shows the new one); **Stop the mission** by typing its name (`stopped`, nothing that would be refused is offered afterwards); the list holds four columns, six with details.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `issue-mission.spec.ts`     | `E2E_USER`                    | **Proposal and duplicate**: an agent's JSON proposal (provider and refs) is checked, what passes fills the form as the person's own list (counted first, the editor on demand), what cannot resolve is listed in the interface's words with the id; a mission whose limits never reset heads its limit column "In total"; create; "Duplicate" behind "···" → same policy, its own key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `issue-mission.spec.ts`     | `E2E_USER`                    | **Reference**: "Reference" in the side navigation, the current entry marked, the person's menu behind one button; one line per plugin of the registry ("15 permissions · 3 presets · 26 tools", `experimental`), the services as a local navigation beside the content; the Supabase page: the place keeps its title and the service is the heading under it, plain-words summary, **three tabs with the permissions first, one panel at a time**, **help closed by default and remembered** (the question each of the six words answers); **the permissions against the presets** (a column per preset with what it holds, a cell per limit, "not included", "asks first"); **a text filter** narrows the list and says when nothing matches; **the filter by part** narrows the table and the tools, `other` holds what no part can be read for, the keyboard moves between tabs; the model as an outline with what carries the environment; **`#risk-<id>` opens Permissions on the entry's part and unfolds it** (held once per environment with each explicit id, the six words, what it covers in words and as written, its limits in each preset with the per-minute rate); **a row is folded until asked**; "anything not named" explained where it is listed; the name of a preset leads to its column; on GitHub no filter by part, `#preset-developer` reached by anchor, **the earlier `#risks` fragment still opens Permissions**, **fifteen permissions within 1.75 viewports**, no sideways scroll at 1280 px, the tool and the permissions that hand a token to the agent are marked, with the sentence that says what that means; an unknown service is not found.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `change-limits.spec.ts`     | `E2E_USER`                    | **Change limits** (spec §3.2, ADR mission-limits-editable-after-issuance), the executor an MCP client on `/mcp`: two reads pass, the third is refused `budget-exhausted`; the limit page's "change the limit" opens the mission with its permission table in edit mode for the limits only ("2 used today", no tick, no switch); "Review the change" is disabled until a value moves and while a field is not a whole number of at least 1; the confirmation lists "per day: 2 → 5" and says it applies from the next call; confirmed, the page returns to its permissions and **the agent's next call passes**; lowered to 3 (already used), the dialog says it is used up and the next call is refused `budget-exhausted` with quota 3; Activity lists "changed the limits of a mission"; the claim is then left until the reset, so nothing of the mission waits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `exhaust-and-claim.spec.ts` | Bob, then Ada                 | **Exhaust and claim**, the executor being an MCP client on `/mcp`: two `github__get_file_contents` pass, the third is refused `budget-exhausted` with `<public_url>/r/<id>`; another signed-in user opens it → **403**, one sentence, no mission name, risk or creator, an empty "Waiting for you" ("Nothing waits for you."); the creator opens it without a session → sign-in → the request: who was stopped and on which mission, the permission and "2 of 2", what led here (the stopped call, the request), the other permissions behind a disclosure, the ways of answering each with what it does ("Extend the mission" not offered: the mission has no end date); **the home lists it** ("… reached its … limit") with "Answer" leading to the request; "Waiting for you" opens it beside its list, the item marked current, and the count in the side navigation; the replay is still refused; **Reset the count** → "Answer recorded", the request reads "answered", "0 of 2", count gone; **the replay passes**; "Waiting for you" and the home each say in one sentence that nothing waits. The page of the limit says "change the limit", which leads to `/missions/<id>?edit=limits#permissions`, and no longer "duplicate the mission".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `approve-action.spec.ts`    | Bob, then `E2E_APPROVER_USER` | **Approve an action**, the executor being an MCP client on `/mcp` and the mission issued from the GitHub `developer` preset as shipped: a workflow file write is refused `approval-required` with `<public_url>/r/<id>`, the validity (600 s) and the replay instruction, nothing reaches the provider, a replay points to the same request; another signed-in user opens it → **403**, no argument, tool, mission or risk; the creator opens it without a session → sign-in → the request: who asks ("using your key") and on which mission, **the tool, each argument by its name**, the permission with its id, "ask me first" and its severity, **the room left of both permissions the call counts against**, the fingerprint and the two slices behind a disclosure, the refusal the agent holds, three answers — **what each does is said before the first button**; **the home lists it with its tool, offers no approval and holds no argument**; "Waiting for you" marks the item current, its list holds no argument; **Approve this call** → "Answer recorded", "approved", **the arguments are erased from the page**; **the identical replay reaches the provider with the gateway's credential**, the page says the agent ran it and both permissions count one less; the same call again and one byte changed each ask again; **Let it run freely until the reset** → both pass, the remaining request says the answer is not possible ("it already runs freely") and is refused; while it runs freely, the mission's activity (`/missions/<id>/session`) and the mission page both read "ask me first" and "runs freely until" on the permission, and the activity offers no switch; on the mission page **the "ask me first" switch is turned off, then on** — a toast says "runs freely", "From the next call.", a call passes in between, and the next one asks again before the period ended; **Activity** lists "approved a call", "let a permission run freely for the period", "refused a request", two "changed “ask me first”", the one call that passed "after a yes", and a call that had to ask as "asked you" (its code `approval-required` in the detail of the line), and holds no argument. At the end the timeline of the mission's activity says what each event did in the interface's words ("runs freely … without asking until", "set to “ask me first”" / "set to “runs freely”" with what it was, "approved … one call, usable until", "allowed … after the creator’s yes", "refused by the creator"), fits the window at 1280 px with these details, and holds no argument. On the home the row is **headed by what the agent wants to do** — "Write a file on a branch · acme/app" (`call-headline`: the plugin's title of the tool and the resource the call resolved to) — then "An agent with your key, on …" and the permission it needs.                                                                                                                                                                                                                                                                                                                                          |
| `approve-action.spec.ts`    | `E2E_APPROVER_USER`           | **Two gated risks, one question**: the creator also gates the ordinary write on a working branch (mission page); writing a workflow file there is refused once, with both risks in `risk_ids` and one URL; a replay before the decision gets the same URL; the request page lists both permissions, each "ask me first", under "one answer for the 2", and says "One yes covers the 2 permissions this call needs."; "Waiting for you" holds one item ("… and 1 more"); she approves once → **one replay reaches the provider**, the next identical call asks again with another request. The inbox item carries the same head, the permissions on the line under it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `audit-session.spec.ts`     | `E2E_AUDIT_USER`              | **A day of calls** (seeded below the door): **the mission page says what waits** — "Waiting for you" beside the title, the one filled box with "Review and answer" leading to `/waiting/<id>`, "And 1 request more", "Limit reached" in the summary — then its activity: the two waiting requests as rows answered by link, every permission with what was used (a red meter that says "Limit reached"; "ask me first" / "runs freely"), what the current period counted, the agent labels seen, **the calls of the current period per agent label** (coder 3 allowed and 2 refused, planner 1; "not verified, and it decides nothing"), the timeline newest first ("asked first" with `approval-required`, what is left after each call, links to the page that answers), **the timeline of one label** (`?agent=planner`: its one call, the permissions still open and unchanged) and back to the whole timeline; then "Full record of this mission" lands on **Activity** — six calls and the creation of the mission, in words ("created a mission"); **a call that had to ask reads "asked you", not "refused"**; the retention in the lede; **six columns by default, the mission a seventh behind "Show details", remembered across a reload**; **the detail of a line has an address** (`?open=<id>`): what is left of each permission touched, the agent label, "never stored" and the 64-hex fingerprint of the arguments; **the argument marker on neither page**; the period as four segments and four controls on one line, the other filters behind "More filters"; no sideways scroll of the page at 1280 px; filters by decision, tool (a refusal reads "limit reached", its code `budget-exhausted` and what the agent was told are in the detail), **agent** and period ("Nothing was recorded for these filters."), "Clear", the "Activity" entry of the navigation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `audit-session.spec.ts`     | `E2E_AUDIT_USER`              | **Every column of the Activity table at 1280 px**: with the detail of a line open (the 64-hex fingerprint) and the seventh column shown, neither the table nor the page scrolls sideways.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `audit-session.spec.ts`     | `E2E_AUDIT_USER`              | **Every column of a mission's timeline at 1280 px**: the page takes the wide measure, its table of five columns does not scroll sideways and the last cell ends inside the window (ids and details wrap).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `audit-session.spec.ts`     | `E2E_AUDIT_USER`              | **Not yours**: the activity of an unknown mission (`/missions/<id>/session`) answers 404.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `share-and-orphan.spec.ts`  | Ines, Joan                    | **Give access, remove it, give it again, then close**, the executor being an MCP client on `/mcp`: the owner's account page lists her alone under "Who has access" ("all 15"); **"Give access" opens a dialog over the page** — who, the presets as starting points, the checklist with a severity and a "why?" per line (reason, the six words, a link to the reference), a one-line summary, the confirming button named after what it gives and disabled while nothing is ticked; "Select all 14" ticks 14 of 15 (not "anything not named"); **a preset ticks its own explicit list** (Read-only: two reads); Clear, two reads ticked by hand, give → the note "Access given", and "Who has access" lists the person with "2 of 15 · read only", the explicit list on demand. The person who received it lands on **Accounts** from the earlier `/shares` path, reads it under **Shared with you** with the list on demand, owns no account, gets **404** on the page of the account and on its dialog, issues a mission whose editor offers only what she holds, and a call passes. The owner's page **names the mission that runs on her account** (not a link: it is not hers to open). **Remove is asked first** ("the 1 mission that uses it stops at once") → "1 mission … is stopped … until an access covers it again" → the same client is refused **`mission-inactive` / `orphaned`** → the other person's mission list says `orphaned`, Accounts shows nothing shared; her mission page says why and that it serves again when the authority is back. **Give again**: the stopped mission is on the owner's page ("Needs an owner"); the first post gives nothing: the dialog asks "Give access and bring a stopped mission back?" and names it with who created it, the client still refused; "Change the permissions" shows the checklist as posted; she confirms ("1 stopped mission is covered again …") → **the same client with the same token is served**, the mission reads `active`, its session kept its history, and its activity lists "left a mission without an owner" and "brought a mission back". **Close**: removed again, the mission carries "Needs an owner" with its cause and **Close**, which asks for its name; closed, it is among "the 1 that ended", the client stays refused and an access given again brings nothing back, with no confirmation step. **Disconnect** asks for the name of the account, says the gateway cannot withdraw the access at GitHub, and afterwards **what to do at the service is said once** ("Still granted at GitHub", the plugin's sentence, never "by hand") — by the note of the act alone, then by the page on every later visit; a disconnected account offers neither Give access nor Reconnect.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `share-and-orphan.spec.ts`  | Ops, Ines                     | **Ownership loop**: the administrator adds a local team (Settings → Teams, "Add a local team") and adds the owner to it; the owner **transfers her account, asked first** in a dialog that names the team and what its members become; the administrator removes her from the team, **asked first** → "1 account has no owner left", the team reads "Nobody left", the account leaves her list; **Setup lists "Accounts without owner" with "Name an owner"**, which leads to the page that lists it (who owned it, "Needs an owner"); an owner named by email → "… has a new owner", "Every account has an owner.", and she has it back and can give access.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `team-mission.spec.ts`      | Ines, Joan                    | **Work on a mission as a team** (spec §7.9 bis), the executors being MCP clients on `/mcp`: the creator starts from "Custom", creates the mission, and from its page adds a teammate picked among the people who signed in (no longer offered once added) and makes a machine key "CI runner" (shown once to her); the teammate finds the mission under "Shared with you" with the creator's address, reads one sentence saying she works on it with her own key, **sees none of the creator's acts** — no "Add people", no "Stop the mission", no "New machine key", no "Duplicate", no switch on a permission — and the server answers 404 to each of them, forged from her browser; her one act is the page's primary action, "Generate my key", in the dialog that shows it once; `GET /mcp/catalog` tells each of the three keys whose it is; after calls under three labels, the creator's page shows what each key did today and never holds the teammate's secret; the activity's "Who called" (counts, not limits), the per-holder filter of the timeline, the "Key holder" filter of Activity (behind "More filters") and its "Who" column, where a machine key says so; the teammate reads the activity and the record of the mission (the detail of a line says the arguments were never stored and that their fingerprint is shown to the creator and the owners only; no 64-hex value); then each way a key stops, **each asked first** — the teammate replaces hers after a dialog that says her key stops at once and the two others keep working (401 `token-rotated`), the creator removes her by typing her address (401 `holder-removed`, the mission gone from her list, its page 404), replaces the machine key in one act (the old one 401 `token-rotated`, the new one served) and revokes it by typing its name — the other holders being served each time; then she adds the teammate again, who generates a key and **leaves the mission** from "···" (never offered to the creator) by typing its name: 401 `holder-removed`, she lands on her missions, its page 404, the creator's page no longer lists her. **The acts of a row do not depend on hovering**: each is a button in the tab order, drawn when focused; at 390 px every act of every row is drawn, the table is rows of labelled lines (a cell wider than 300 px), nothing scrolls sideways, and the Setup kit dialog stays inside the screen with its button in view — as it does at 1280×800. **Dates** of the mission's timeline read "14 Oct, 01:48:59" in a browser set to US English, never "10/14/2026" or "AM".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `delegate-agent.spec.ts`    | `E2E_USER`                    | **Delegate to an agent, who prepares a mission**, the agent being the official MCP client pointed at `/mcp/manage` with nothing configured: it discovers the authorization server, registers and asks for the browser; the user is sent through the IdP and back, reads the consent screen (the application's name as a claim, their email, the scope `mgmt`, where the access goes, what it can never do, Deny before Authorize) and **clicks Authorize in a real browser** — the form post carries the `Origin` the browser really sends; the browser lands on the agent's loopback address with a code and the issuer; the agent exchanges it and **is admitted**; **the agent prepares a mission by itself** (spec §7.10): it lists the seven tools, reads the user's connections and the GitHub catalog, previews a draft built from the `read-only` preset on one repository, issues it and receives the token and the kit; **the mission token works on `/mcp`** (a read on the selected repository is allowed, another repository cannot be called) and is refused at `/mcp/manage`; the user finds the mission on Missions marked "prepared by … for you" and on its page (the app's name, its client id, "it is not verified"); **Connected apps** (reached from the earlier `/delegations` path) lists the app as "connected" with how long its consent is valid, its facts one click away (client id, where its access goes, "not verified", "Consent ends", the missions it prepared); **Disconnect is asked first** and says the missions stay; the agent's next connection is refused, its refresh token answers `invalid_grant`, and it asks for the browser again; the mission it issued stays the user's, active, its token still valid.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `delegate-agent.spec.ts`    | a user who delegated nothing  | **Connected apps, empty**: the page is under Settings (`/settings/connected-apps`; the entry of the main navigation and of the local one are current); it says no app is connected, how to connect one, and names the management door's URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `now-and-entry.spec.ts`     | a newcomer, then nobody       | **Sign-in**: no session → `/login`: "Sign in to `<host>`", one button, the build line, no navigation; a failed attempt says why by its code and an unknown code says nothing; signed in from the page itself: "You are signed in", who, "Open the gateway" → the one home. **First run**: "Welcome, Nora", what the product is, the model in five nodes, three steps of which the first leads to connecting an account; no setup list for someone who does not administer; neither list of the home; no sideways scroll at 1280 px; an empty "Waiting for you" says so. **Not found**: an unknown mission answers 404 inside the shell ("Not found", the way home); an unknown address without a session answers 404 outside it and says nothing of what exists. **Themed refusal**: the forwarded URL of a request that is not the reader's answers 403 "Not yours to answer" in the tokens of the interface — light, dark when the system asks, and **dark in the HTML itself when the person chose it**, with no script; the same address inside the application says the same sentence. **Signing in lands on the home**: from the sign-in page itself the next page is `/`, with no "You are signed in" card; `/login` sends a signed-in person home; a failed attempt while signed in shows its error and the card. **A refused form** (`/accounts/new/stripe`, a key of the wrong shape): the name typed is still there, the key is not and is nowhere in the page, the field is `aria-invalid` and says its shape again ("starts with sk*test* or rk*test* … A secret is never kept"), and a reload shows the plain form.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `shell.spec.ts`             | `E2E_USER`, then Ops          | **The frame every page shares**: no session → sign-in → **one home** (`/`), the brand leads back to it; **seven entries** in order, each leading to a page with a title and then the only one marked; the navigation is a 220 px column beside the page; the person's menu (name, email, "Sign out", Escape gives the focus back); the skip link is the first stop of the keyboard. **Collapsed**: 56 px of icons at 900 px, the names kept as titles and for assistive technology, no sideways scroll; a bar above the page at 390 px. **Theme**: System (no attribute; follows the device), Light, Dark; kept in a cookie; **the HTML the server sends already carries the theme**; the control of Settings and the toggle stay in step; System forgets the cookie. **Old paths**: `/connections`, `/connections/new/github`, `/requests/<id>`, `/audit?decision=refused`, `/providers/github` each answer **308** to the new path (`/accounts`, `/accounts/new/github`, `/waiting/<id>`, `/activity?decision=refused`, `/reference/github`) with the query kept; `/shares` → `/accounts` and `/delegations` → `/settings/connected-apps`, a form post to the earlier "revoke" address keeping its method; `/connections/callback/github` is not redirected; old bookmarks land on the new pages in a browser. **Settings**: "You" for a person; for an administrator the ten entries of the local navigation, Administration inside the same shell with "Settings" current; **People** marks the administrator in words and offers no button on one's own line; **Setup is a checklist** ("n of m done", sign-in, the public address, the company apps that are missing with a button that opens the form of the first, the administrator rule with the email it lists and what an administrator cannot do). **The gallery** (`/design`): a section per entry of its navigation, at least fifty specimens each on a light and a dark island, "Show details" adds the detail columns and is remembered across a reload, a meter is drawn only near its limit, "why?" unfolds a permission, a confirmation states its consequence, closes on Escape, and confirming shows a toast. **A phone** (390 px): the navigation is a bar at the bottom, as wide as the screen — Now, Waiting, Missions, Accounts and More, **each word drawn** under its icon, the link "Waiting for you" keeping its full name; "More" opens Activity, Reference and Settings in a sheet above the bar by Enter or by touch, Escape closes it and returns the focus, going to Settings through it marks "More" current; the local navigation of Settings is chips 32 px high or more; the page ends above the bar; **no page of the navigation scrolls sideways** (the home, Waiting for you, Missions, New mission, Accounts, Connect an account, Activity, Reference, the reference of GitHub, Connected apps). **Not an administrator**: Settings does not offer the interface reference, and `/admin` answers "You do not administer this gateway" inside the shell (seven entries, the person, the build line, "Go to Now"); an administrator is offered the interface reference, and the one undone step of Setup carries the one primary button. |

### Scenarios still to write

Each is added to this file, with its spec, by the feature that makes it
possible (spec §4, §5, §7):

1. **Bootstrap and first sign-in in a browser** — the bootstrap token,
   Settings → Sign-in, the first administrator sign-in. Today: integration
   suite against `FakeIdp`, and the manual check below.
2. **Give access to a team in a browser** — the access spec gives access to a
   person; teams as targets are driven in the integration suite.
3. **An administrator approves a registered app in a browser** (Settings →
   Registered apps) — the connected-app spec uses a loopback client, which
   needs no approval; the approval and the disabling of an app are driven in
   the integration suite.

## Container smoke (automated)

> Covers: spec §4.3, §6. Script `deploy/docker/smoke.sh <image>`
> (`SMOKE_PORT`, default 3999), run by the `docker` job of
> `.github/workflows/ci.yml` after the image build (tag
> `vaubaan-gateway:ci`) and locally with
> `npm run docker:build && npm run docker:smoke` (tag
> `vaubaan-gateway:local`). The release pipeline
> (`.github/workflows/release.yml`) runs it on each architecture
> (`linux/amd64`, `linux/arm64`, native runners): on the image it builds,
> then again on the digest it pushed, before any tag exists.

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
   prebuilt binaries and runtime files). `libsodium-wrappers` is exercised indirectly: the encryptor runs
   during boot, so a container that answers `/healthz` has loaded it.
5. **Non-root** — the process runs as uid 10001.
6. **No env file shipped** — the image contains no `apps/gateway/.env*`
   file (the build context excludes every `.env*`).
7. **No test file shipped** — outside `node_modules`, `/app` holds no
   `*.test.*`, `*.spec.*` or `*.bench.*` file, no `testing.ts` / `testing.js`,
   no `vitest.config.*` or `playwright.config.*`, and no directory named
   `tests`, `__tests__`, `e2e` or `fixtures`: a file trace that followed an
   import from a test helper would carry tests, fixtures, the simulated
   identity provider or the demo launcher into production. The step also
   fails when the search looked at no file at all.

Optional, when the caller knows what it built (the release pipeline sets
the three): `SMOKE_EXPECT_VERSION` and `SMOKE_EXPECT_COMMIT` — `/healthz`
must answer that version (the root `package.json`) and that commit —, and
`SMOKE_EXPECT_ARCH` — Node's `process.arch` inside the image (`x64`,
`arm64`). Step 4 on `arm64` is what proves the two native addons load on
both published architectures.

The container smoke and the cutover smoke do not overlap: the first proves the
image boots from configuration, the second proves the application path on a
root built in-process. No automated check runs the application path _inside
the image_; the manual scenario does.

## Manual checks by feature

Run by hand against a real identity provider or real providers when the
feature changes. The cutover acceptance scenario exercises all three on the
way; these are the detailed versions.

### Administrator bootstrap and OIDC sign-in

> Covers: spec §7.1, §6 "human authentication". Handbook [authentication](../handbook/authentication.md).
> The automated counterpart runs against the in-process `FakeIdp`
> ([integration-tests](./integration-tests.md)).

Prerequisites: an instance behind TLS (`deploy/compose.yaml` with Caddy, or
`next dev` behind a local https proxy) whose `public_url` is the browser's
URL; an app registered at the IdP with redirect URI
`<public_url>/auth/callback`; `admin.group` or `admin.emails` naming the
tester; `bootstrap_token` set, `idp` **not** set in the configuration.

1. **Bootstrap** — open `<public_url>/login`: "Sign-in is not set up yet"
   ("No identity provider is configured yet.") with "Set it up".
   `/admin/bootstrap` ("Set up this gateway") with a wrong token shows
   "Refused" and "The bootstrap token was not accepted."; with the right token
   it lands on `/admin` (Settings → Setup), and the person's menu says
   "installing this gateway".
2. **Configure** — Settings → Sign-in (`/admin/identity-provider`): issuer,
   client id, client secret, claim names (Entra ID: leave `groups`; the admin
   rule must then name the group **object id** unless the app emits names, and
   the groups claim must be limited to "Groups assigned to the application" —
   a user above Entra's group limit is otherwise refused at sign-in with
   `groups-overage`; Google: no groups, rely on `admin.emails`). "Save" → the
   note "Saved"; the page no longer asks for the secret ("A secret is stored;
   leave blank to keep it. It is asked again when the issuer changes.").
3. **Test the sign-in** — the IdP consent screen appears, the browser comes
   back to `/admin/identity-provider?tested=1` with the note "What the
   identity provider returned": Email, Teams (one tag per group returned),
   "Administrator: yes: you match the rule". Setup now says the bootstrap
   token was revoked, with the date.
4. **Bootstrap refused** — in a private window, `/admin/bootstrap` says "The
   bootstrap token no longer works" and offers "Sign in"; posting the token
   anyway is refused.
5. **Not an administrator** — sign in as a person outside the rule: `/login`
   says "You are signed in" with their name and teams, no "administrator"
   mark and no link to Settings; `/admin` renders "You do not administer this
   gateway", naming the rule.
6. **Session** — refresh after sign-in keeps the session; "Sign out" returns
   to `/login` signed out; the cookie `__Host-vbn_session` is
   `HttpOnly; Secure; SameSite=Lax`, `Path=/` and has no `Domain` in the
   browser's storage inspector; the
   sign-in survives a container restart (rows in `web_sessions`).
7. **Logs** — the server log carries `user signed in`,
   `bootstrap token revoked after the first operator sign-in`, and never
   the client secret or the bootstrap token.
8. **Deactivation** — as the administrator, Settings → People lists
   everyone who signed in; the administrator's own line has no "Deactivate".
   Deactivate the person of step 5 (asked first, with what stops): the note
   says what was revoked and left; in that person's window the next
   navigation lands on `/login`, and signing in again at the IdP comes back
   with "This account was deactivated on this gateway by an administrator".
   "Reactivate": the person signs in again with a new session. The automated
   counterpart is `tests/integration/auth/deactivate-user.test.ts`
   ([integration-tests](./integration-tests.md)).

### Connect an account

> Covers: spec §7.1 last step, §7.2.
> Handbook [connections](../handbook/connections.md). The automated
> counterparts run against mocked provider endpoints: the integration suite
> for the four credential kinds, the cutover smoke for the GitHub App
> installation in a browser.

Prerequisites: the instance of the previous section, signed in as an
administrator; at each redirect-flow service, an app registered by the company
with the address shown on Settings → Company apps (`/admin/provider-apps`)
(`<public_url>/connections/callback/<provider>`) as OAuth redirect URI
(Supabase, Railway, Gmail) or, for the GitHub App, as the callback URL of its
user authorization.

1. **Company apps** — Settings → Company apps (`/admin/provider-apps`): one
   line per service that needs an app, "not registered". "Register" opens the
   form under the line: GitHub (app id, private key PEM, slug, client id,
   client secret) and Supabase / Railway (client id, secret) → "registered";
   the secrets are never shown again. A service set through
   `providers.<id>.*` in the mounted configuration is read-only and tagged
   "set in the mounted configuration".
2. **Picker** — Accounts → "Connect an account" (`/accounts/new`) lists the
   services as cards: the ones whose app is registered and the key-based ones
   (Vercel, Stripe, Cloudflare DNS, Resend, Upstash Redis, SSH); Gmail is
   tagged "experimental" once its app is saved; a service whose company app
   is missing is drawn unavailable and says why.
3. **OAuth** — Supabase: "Continue to Supabase" → consent → back on
   `/accounts/<id>`, "connected", with the projects as resources. Same for
   Railway.
4. **App installation** — GitHub, with "Request user authorization
   (OAuth) during installation" enabled on the App and the gateway callback
   registered as its callback URL: install the App on the organisation →
   authorize → back with the repositories as resources (the callback
   carries `code`, `installation_id` and the `state`). Then, as another
   person of the gateway whose GitHub account cannot reach that organisation:
   start connecting, and open the callback by hand with that organisation's
   `installation_id` and the fresh `state` → the note "Not connected", no
   account, a `connection-refused` entry in Activity. With the checkbox
   disabled on the App: "Not connected", saying that the service returned no
   user authorization.
5. **API key** — Vercel with a token and a team id → connected with the
   projects. Resend with a sending-only key → "Not connected", with
   Resend's own error; with a full-access key → domains and segments.
   Stripe: the `test` / `live` resources carry an environment the plugin
   sets, which the page does not let the owner edit.
6. **SSH** — fill host, user, fingerprint ("Make the key pair and connect")
   → the page of the account shows the public key; "Refresh" fails with the
   plugin's message until the key is in `authorized_keys`, then lists the
   host.
7. **Curate** — on a resource of the account: label a Supabase project
   `prod`, rename it, tick "Hide from new missions" on another; on a Resend
   domain fill the internal domains; "Refresh" → everything is kept. Delete a
   project at the service → after a refresh it is marked "no longer found
   since <date>", and still listed.
8. **Replay** — reopen the callback URL of step 3 from the browser history
   → "Not connected": the attempt has expired or was already used; no second
   account.
9. **Refresh** — wait for a Supabase access token to expire (one hour) and
   use "Refresh": it succeeds, and the log carries `credential
refreshed`. Revoke the app's access at the service, refresh again →
   the account reads "Needs reconnecting"; "Reconnect" brings it back with
   the same id.
10. **Disconnect** — "Disconnect this account…", type the name of the account
    → "Account disconnected"; the account reads "disconnected", offers neither
    "Give access" nor "Reconnect", and the list shows the state.
11. **Logs and store** — the log never shows a token, a key or a client
    secret; `sqlite3 gateway.sqlite "select hex(credential_blob) from
connections"` shows blobs starting with `01`, never readable text.

### An agent through the execution door

> Covers: handbook [execution-door](../handbook/execution-door.md). Spec §4.1,
> §4.4 (bootstrap kit), §7.5.

Done once on 2026-10-13 on the standalone build with a temporary
configuration and SQLite file; the transcript is in the handbook ("Manual
check").

1. Build (`npm run build --workspace @vaubaan/gateway-app`), export the
   `VAUBAAN_*` variables of a throw-away instance, and seed it:
   `cd apps/gateway && npx tsx tests/manual/seed-demo.ts` creates a user, a
   GitHub connection with two repositories (placeholder installation) and a
   `read-only` mission on one of them, and prints the setup kit.
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

### Streaming through the standalone server and the reference proxy

> Covers: handbook [execution-door](../handbook/execution-door.md),
> "Streaming" and "Manual check: streaming". Spec §4.1.

Done on 2026-10-13; the transcript and the timings are in the handbook. Not
automated: it needs the standalone build, and Docker for the proxy leg.

1. Build, then `PORT=<free port> HOSTNAME=127.0.0.1 NODE_ENV=production npx
tsx apps/gateway/tests/manual/streaming-check.ts serve`: the real root on
   the `:memory:` store, a fixture provider reading a slow chunked response
   from a local stand-in upstream, served by the **standalone** `server.js`.
   It prints a mission token.
2. In another shell, `npx tsx apps/gateway/tests/manual/streaming-check.ts
probe http://127.0.0.1:<port> <token>` → five progress frames about
   300 ms apart, then the result, for raw 2025-era JSON-RPC and for the
   official MCP client in both eras. **The probe exits non-zero if the
   frames arrive together.**
3. Same run: a stream the upstream cuts (parts, then `isError`), a refused
   call (its error alone), no progress token (one JSON body), a caller that
   disconnects after the first frame.
4. The `audit:` lines of the serve process: `upstream_latency_ms` of about
   1500 ms for the complete streams, `stream failed after N parts`, `stream
stopped after 1 part: the caller was gone`.
5. Proxy leg: the serve process and the pinned Caddy image with
   `deploy/caddy/Caddyfile` on one Docker network (`GATEWAY_DOMAIN=localhost`),
   the probe against Caddy's HTTPS port with
   `NODE_TLS_REJECT_UNAUTHORIZED=0` → the same timings.

Run it again after a change of Next.js version, of the MCP SDK, of
`next.config.ts` (`compress`), or of the proxy configuration.

## Known gaps

- **No browser test of the bootstrap token and of Settings → Sign-in**, nor
  of an administrator approving an app under Settings → Registered apps (see
  "Scenarios still to write"), nor of deactivating and reactivating a person
  under Settings → People (driven in the integration suite, through the two
  routes; `shell.spec.ts` only reads the page) and of the note Connected apps
  shows for an app whose consent was replayed (the view behind it is
  unit-tested). The management door's tools are driven by
  `delegate-agent.spec.ts` for one mission created; replacing a key and
  stopping a mission through the door are covered by the integration suite
  only.
- **The browser suite runs the standalone server, not the image.** It proves
  the build's standalone tree serves every page; the container itself (user,
  volume, healthcheck) is the container smoke's.
- **One service in the browser.** Only the GitHub App installation flow is
  driven in a browser; the OAuth, API-key and SSH flows are covered by the
  integration suite, never in a browser.
- **Playwright ran in no pipeline before the `e2e` job existed.** The audit table regression,
  the unbound label and a stale assertion (a 16-hex fingerprint) were all
  found the first time the whole suite was run on the merged branch.

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
