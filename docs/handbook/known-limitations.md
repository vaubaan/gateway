---
title: Known limitations — what has not been done, and what is not there
status: current
date: 2026-10-13
last_synced: 2026-10-21
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

- **Keycloak sign-in has never been run.** The test suites and the demo
  sign in through a simulated provider (`FakeIdp`). Live, three instances
  have signed people in since 2026-10-14: one through a GitHub OAuth App,
  one through Google, one through Entra ID with its groups claim naming the
  administrators. Keycloak, and any other OpenID Connect provider, follows
  the same handbook without a recorded run. →
  [authentication, "Tests"](authentication.md#tests)
- **Most plugins have never executed a tool on the service they model.**
  Every provider call of every test is answered by a double (`mockFetch`, a
  fake SSH transport, the demo's simulated routes). Live, through the instance
  that serves this project's own development: GitHub (the REST tools and the
  git remote, since 2026-10-16) and Fly.io (apps, since 2026-10-18) have run
  real tools; Supabase, Vercel and Cloudflare DNS have been connected, which
  runs their discovery against the real service, and no tool call on them is
  recorded; Resend, Upstash Redis, Stripe, Gmail, SSH, Miro, Notion and
  Context7 have no live run at all, and Railway only the token check below. →
  [connections, "Tests"](connections.md#tests)
- **Miro's tool calls have not run live.** The sign-in and Miro's tool list
  were verified against a real Miro account on 2026-10-23 (the list is
  captured verbatim); what Miro answers to each call — discovery's board
  list included — is still known from its schemas and tested against mocks
  only. Every discovery logs a difference between Miro's live tool list and
  the captured one. →
  [miro, "The tool list: captured"](providers/miro.md#65-the-tool-list-captured)
- **One live check is still to do on Railway**: whether Railway's API
  accepts the token obtained for its MCP server (L3). The two GitHub checks
  (L1, L2) concerned the GitHub App's installation callback and are moot
  since GitHub connects with a fine-grained token (2026-10-20). →
  [cutover-from-v4, "The live checks"](cutover-from-v4.md#4-the-live-checks)
- **Railway tokens: what was checked live and what was not.** A workspace
  token was checked against Railway's MCP server on 2026-10-14; an account
  token was not (Railway documents that server for OAuth only — if it refuses
  one, the call fails naming the kind and the account stays usable), and the
  GraphQL queries a workspace token answers at paste and at discovery (its
  projects, its workspace's name) follow the public API's shape without a live
  run. →
  [railway, "Connecting with a workspace token"](providers/railway.md#connecting-with-a-workspace-token)
- **The git remote has seen four of its moves live, not all.** Since
  2026-10-16 the instance that serves this project's development has relayed
  fetches and created `feature/*` branches on `vaubaan/gateway`; on
  2026-10-18 it pushed the tag `v2.0.0-alpha.1` and refused an annotated
  tag (a defect, fixed by #62); on 2026-10-19 it deleted a merged branch. A
  fast-forward of an existing
  branch and a force-push have not been seen live. Its tests run the real
  `git` client against `git http-backend` standing in for GitHub, with a REST
  API computed from the same repositories: protocol v2 relayed to GitHub
  itself, GitHub accepting a pack under `refs/vaubaan/*`, the compare API's
  limits, the `commits` of a comparison, `GET commits/{sha}` and
  `GET commits?sha=` (the history the base of a review is searched in), the
  `PATCH git/refs` answers, and a compare-and-swap of an empty-pack
  receive-pack command for a force-push or a delete are read from GitHub's
  documentation, not observed. →
  [git-remote, "Tests"](git-remote.md#tests)
- **No `linux/arm64` image and no attestation have been published.** Every
  release so far — `2.0.0-alpha.1` (2026-10-18, run 39134680809: plan, gates,
  image, push, publish and release all passed), `2.0.0-alpha.2`
  (2026-10-19) and `2.0.0-alpha.3` (2026-10-21) — was cut while this repository was
  private, which publishes `linux/amd64` only and signs nothing, by design.
  The arm64 runner, the attestation and its verification by an operator have
  therefore never run outside a dry run. →
  [coding workflow, "Release"](../workflow/coding-workflow.md#on-a-private-repository)
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
  what your backups of that file give. The scheduled backup sends them off the
  host, but at most once an hour: what changed since the last one is lost with
  the host. → [store, "Scheduled backup"](store.md#scheduled-backup)

## Backups

- **The scheduled backup has met one real service: Cloudflare R2.** On
  2026-10-23 two instances on 2.0.0-alpha.4 backed up to R2 (endpoint
  `https://<account>.r2.cloudflarestorage.com`, region `auto`, path-style, one
  key scoped to one bucket): the self-check passed and the object was in the
  bucket at the reported size. Tigris, MinIO and AWS have not been tried, nor
  the multipart upload (stores above 64 MiB) against a real service. Check the
  first run on Settings → Encryption. → [store, "Scheduled backup"](store.md#scheduled-backup)
- **A run holds the server for the length of the copy.** `VACUUM INTO` runs on the
  server's own handle and blocks its event loop while it copies: unnoticed for a
  store of megabytes, seconds for a large one. The volume also needs room for the
  store twice more during a run. → [store, "Scheduled backup"](store.md#scheduled-backup)
- **No "back up now" button, no weekly schedule.** A run happens at the slots
  (every 1 to 24 hours) and once a minute after a start that missed one; the
  `backup` command still makes a plain copy by hand.
- **`/healthz` carries the backup report** until `/ops/stats` exists: anyone who
  can reach the health endpoint sees the latest object key, size and SHA-256 (no
  endpoint, bucket or credential).

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
