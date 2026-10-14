---
title: Known limitations — what has not been done, and what is not there
status: current
date: 2026-10-13
last_synced: 2026-10-14
tracks:
  - apps/gateway/src/server/execution/tools.ts
  - apps/gateway/src/server/execution/scope-caps.ts
  - apps/gateway/src/server/execution/token-verifier.ts
  - apps/gateway/src/server/execution/credential-cache.ts
  - apps/gateway/src/server/rate-limit/sliding-window.ts
  - apps/gateway/src/server/compose/memory.ts
  - apps/gateway/src/server/connections/pending.ts
  - apps/gateway/src/server/connections/install-verification.ts
  - apps/gateway/src/server/oauth-as/authorization.ts
  - apps/gateway/src/server/store/repositories/users.ts
  - apps/gateway/src/server/config/telemetry-default.ts
  - packages/gateway-core/src/cache.ts
  - packages/telemetry/src/queue.ts
  - plugins/railway/src/classify.ts
  - plugins/railway/src/execute.ts
  - plugins/railway/src/token.ts
  - apps/gateway/tests/integration/auth/fake-idp.ts
  - apps/gateway/tests/demo/guards.ts
  - deploy/collector/
  - .github/workflows/release.yml
  - apps/gateway/src/server/git/
---

# Known limitations

What a reader should know before relying on this version: what was never
tried, what is not enforced, what is not built. One line each; the link at the
end of a line is where the detail is. A limitation leaves this page in the
change that removes it.

## Never run for real

- **Never run with Claude Code as the agent.** No person and no agent has
  pointed Claude Code at a running instance; the automated suites drive both
  doors with the official MCP client instead. →
  [cutover-from-v4, live check L4](cutover-from-v4.md#l4--claude-code-itself-at-a8)
- **Never run against a real identity provider.** Every sign-in of the test
  suites and of the demo goes through a simulated provider (`FakeIdp`); the
  sign-in with Google, Entra ID or Keycloak is a manual check that no run has
  recorded. →
  [authentication, "Tests"](authentication.md#tests)
- **Never run against a real provider.** Every provider call of every test is
  answered by a double (`mockFetch`, a fake SSH transport, the demo's simulated
  routes); no plugin has executed a tool on the service it models. →
  [connections, "Tests"](connections.md#tests)
- **Three live checks are still to do on GitHub and Railway**: whether GitHub
  returns `state` on the installation callback (L1), whether connecting an App
  that is already installed comes back with a `code` (L2), and whether
  Railway's API accepts the token obtained for its MCP server (L3). →
  [cutover-from-v4, "The live checks"](cutover-from-v4.md#4-the-live-checks)
- **Railway tokens: what was checked live and what was not.** A workspace
  token was checked against Railway's MCP server on 2026-10-14; an account
  token was not (Railway documents that server for OAuth only — if it refuses
  one, the call fails naming the kind and the account stays usable), and the
  GraphQL queries a workspace token answers at paste and at discovery (its
  projects, its workspace's name) follow the public API's shape without a live
  run. →
  [railway, "Connecting with a workspace token"](providers/railway.md#connecting-with-a-workspace-token)
- **The git remote has never pushed to github.com.** Its tests run the real
  `git` client against `git http-backend` standing in for GitHub, with a REST
  API computed from the same repositories: protocol v2 relayed to GitHub
  itself, GitHub accepting a pack under `refs/vaubaan/*`, the compare API's
  limits, the `commits` of a comparison and `GET commits/{sha}`, the
  `PATCH git/refs` answers, and a compare-and-swap of an empty-pack
  receive-pack command for a force-push or a delete are read from GitHub's
  documentation, not observed. →
  [git-remote, "Tests"](git-remote.md#tests)
- **The release pipeline has never run.** `.github/workflows/release.yml` is
  written and its Node scripts are tested, but no `v2.*` tag exists: no image was
  published, signed or attested by it. →
  [coding workflow, "Release"](../workflow/coding-workflow.md#release)
- **Telemetry is postponed until after the pilot.** It is off by default
  (`telemetry.enabled: false`) and stays so; the collector is not deployed: the
  built-in collector URL is a placeholder to which nothing is sent even when
  telemetry is enabled, and the collector's SQL under `deploy/collector/` was
  applied to a local database only. Nothing in the collector is being worked
  on before the pilot has run (product owner's decision of 2026-10-13). →
  [telemetry, "Pointing an instance at a collector"](telemetry.md#pointing-an-instance-at-a-collector)

## Not enforced, or enforced more coarsely than one would expect

- **Scope caps are not enforced.** The execution door has no cap stage: a catalog declares only the rate ceiling the gateway enforces, and a mission
  bounds a permission (a risk of the catalog) with its limits — the quota and
  the rate limit — and its gate ("ask me first") (ADR
  [scope-caps-not-enforced-in-v5-0](../decisions/scope-caps-not-enforced-in-v5-0.md)). →
  [execution-door, "Scope caps: not enforced"](execution-door.md#scope-caps-not-enforced-scope-capsts)
- **`tools/list` is per provider, not per tool.** Every tool of a
  non-experimental provider for which the mission holds an account (a
  connection) and at least one permission (an accepted risk) is listed; a
  listed tool whose own permission the mission does not hold is refused
  `risk-not-accepted` when called. →
  [execution-door, "Discovery and catalog"](execution-door.md#discovery-and-catalog-toolsts)
- **Railway: the logs of a named deployment, and the continuation of an agent
  conversation, are not available.** `deploymentId` and `threadId` cannot be
  bound to the mission's project, so the gateway refuses both rather than
  forward them: `get-logs` reads the latest deployment of a service, and every
  `railway-agent` call starts a new conversation. →
  [railway, "Identifiers"](providers/railway.md#identifiers)
- **Railway: `railway-agent` cannot be bound at all.** It hands a free-text
  request to Railway's own agent, which acts with the whole credential; the
  gateway classifies the call on the mission's project and requires the
  `agent-action`, `deploy` and both variable risks, but it cannot see or limit
  what that agent then does (threat model, accepted risk A18). → [railway, "Classification"](providers/railway.md#classification)
- **An administrative act and its audit entry are two writes.** A teammate
  removed, a key revoked or issued, a key replaced or a mission stopped: the store
  commits the act, then the entry is written. If that second write fails, the
  request fails, the act stands, and a retry finds nothing left to do and
  records nothing. Calls are not concerned: a call's entry is written before
  its answer. → [audit, "Administrative entries: who writes what"](audit.md#administrative-entries-who-writes-what)

- **Git: a push is reviewed through GitHub's compare API, so a push larger
  than it lists (300 files, 250 commits per ref) is refused**, to be split, as
  is a push bringing more than 100 commits (each is read for workflow
  changes). A push refused after its pack was stored — by the review, or
  waiting for an approval — has cost one upload (threat model A31).
  `git push --atomic`, push options, signed pushes and Git LFS are not
  served; signed commits are. →
  [git-remote, "Push"](git-remote.md#push)

## One process

- **Single process.** The state marked `// single-process only` in the code
  lives in the memory of one Node process: the rate-limit windows (the
  budget's and the surfaces', the one on the argon2id check of legacy tokens),
  the cache of derived provider credentials, the one-at-a-time credential
  refresh per connection, the single use of a pending connection attempt and
  of a pending consent, the identity provider's discovery cache, the telemetry
  queue and the timers of the audit retention and of the token sweep. A second
  process would neither share nor replace any of it. →
  [configuration, "Ports and their single-process implementations"](configuration.md#ports-and-their-single-process-implementations)
- **No high availability.** One image, one process, one SQLite file on a
  volume: a restart or the loss of the host is an outage, and durability is
  what your backups of that file give. → [store, "Backup"](store.md#backup)

## Not built

- **No tool moves a person to another issuer.** A user is the pair (issuer,
  subject): after a change of identity provider the same people arrive as new
  users, and the earlier ones keep their accounts and missions, unreachable,
  until somebody edits the store. →
  [authentication, "A user is (issuer, subject)"](authentication.md#a-user-is-issuer-subject)
- **No deprovisioning feed from the identity provider.** A user removed there
  stays active here until an administrator deactivates them (Settings →
  People). →
  [authentication, "Deactivating a user"](authentication.md#deactivating-a-user)
- **The demo is not a deployment.** `npm run demo` signs anybody in as anybody
  without a password, answers every provider from memory, binds the loopback
  interface and deletes its data on exit; it refuses to start in a production
  environment and is not in the image. → [demo-mode, "Safety"](demo-mode.md#safety)

## Kept until the next major version

- **The argon2id check of legacy tokens stays until the next major version.** A
  mission token stored by an earlier build as an argon2id hash is still checked
  the slow way, behind its own throttle, until its first use moves it to its
  SHA-256 digest; a token never used again never moves. The path, its throttle
  and the native `argon2` addon the image carries go only with the next major
  version (owner's decision of 2026-10-14). →
  [ADR mission-token-sha256-digest, D5](../decisions/mission-token-sha256-digest.md)
