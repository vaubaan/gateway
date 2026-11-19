---
title: Known limitations — what has not been done, and what is not there
tracks:
  - apps/gateway/src/server/execution/tools.ts
  - apps/gateway/src/server/execution/scope-caps.ts
  - apps/gateway/src/server/execution/credential-cache.ts
  - apps/gateway/src/server/rate-limit/sliding-window.ts
  - apps/gateway/src/server/compose/memory.ts
  - apps/gateway/src/server/store/repositories/users.ts
  - packages/telemetry/src/queue.ts
  - plugins/railway/src/credential.ts
  - plugins/railway/src/classify.ts
  - apps/gateway/tests/integration/auth/fake-idp.ts
  - apps/gateway/tests/demo/guards.ts
  - .github/workflows/release.yml
  - apps/gateway/src/server/git/
last_reviewed: 2026-10-27
---

# Known limitations

What to know before relying on this version: what was never tried, what is
not enforced, what is not built. One line each; a limitation leaves this page
in the change that removes it.

## Never run for real

- **Keycloak sign-in has never been run.** Tests and the demo use a simulated identity provider; live instances sign in through GitHub, Google and Entra ID. → [authentication](authentication.md)
- **Most plugins have never executed a tool on their service.** Tests answer with doubles. Live: GitHub (REST and git remote) and Fly.io ran real tools; Supabase, Vercel and Cloudflare DNS ran discovery only; the others have no live run. → [accounts](accounts.md)
- **Miro's tool calls have not run live**: sign-in and the tool list were verified on a real account; every discovery logs a difference from the captured list. → [miro](services/miro.md)
- **Railway account tokens were not checked against Railway's MCP server** (a workspace token was): a refusal fails the call naming the token kind, the account stays usable. → [railway](services/railway.md)
- **The git remote has not seen every move live**: a fast-forward of an existing branch and a force-push were not; tests run the real `git` client against `git http-backend`. → [git-remote](git-remote.md)
- **Community statistics start empty**: telemetry is off by default, so the "validated by the community" tag stays absent until a plugin version gathers enough reports. → [telemetry](telemetry.md)

## Not enforced, or more coarsely than expected

- **Scope caps are not enforced**: a catalog declares only the rate ceiling; a mission bounds a permission with quota, rate and gate. → [ADR](../decisions/scope-caps-amplification-axis.md)
- **`tools/list` is per service, not per tool**: a tool whose own permission is missing is listed, then refused `risk-not-accepted`. → [execution-door](execution-door.md)
- **Railway: no logs of a named deployment, no continued agent conversation**: `deploymentId` and `threadId` cannot be bound to the mission's project, so both are refused. → [railway](services/railway.md)
- **Railway: `railway-agent` cannot be bound**: Railway's own agent acts with the whole credential; the gateway requires four risks but cannot see what it does (threat model A18). → [railway](services/railway.md)
- **An administrative act and its audit entry are two writes**: if the entry fails, the request fails but the act stands. A call's entry is written before its answer. → [audit](audit.md)
- **Git: a push larger than GitHub's compare API lists (300 files, 250 commits per ref) or bringing more than 100 commits is refused**, to be split. `--atomic`, push options, signed pushes and Git LFS are not served. → [git-remote](git-remote.md)

## One process

- **Single process**: rate windows, the derived-credential cache, per-account refresh, pending connect attempts and consents, the IdP discovery cache, the telemetry queue and the timers live in one Node process (`// single-process only`); a second process would share none of it. → [configuration](configuration.md)
- **Plugins run in the gateway's process**, beside every credential it decrypts: the signature of a plugin is the boundary, not an isolation (threat model A-rows on plugins). → [plugin-loading](plugin-loading.md)
- **Long store work blocks every request**: the store is synchronous (`better-sqlite3`), so the audit retention's purge and a scheduled backup's copy hold the event loop while they run; on a store of several gigabytes that is seconds. → [store](store.md)
- **No high availability**: one image, one process, one SQLite file; a restart or a lost host is an outage, and what changed since the last scheduled backup is lost with the host. → [store](store.md)

## Backups

- **The scheduled backup has met one real service, Cloudflare R2**; Tigris, MinIO, AWS and the multipart upload (stores above 64 MiB) were not tried. Check the first run on Settings → Encryption. → [store](store.md)
- **A run blocks the server for the length of the copy** (`VACUUM INTO`), and the volume needs room for one more copy of the store and its compressed backup. → [store](store.md)
- **A backup of format v2 does not restore on 2.0.0-alpha.4 or earlier**: restore with an image at least as new as the one that made it. → [store](store.md)
- **No "back up now" button, no weekly schedule**: runs every 1 to 24 hours; the `backup` command makes a copy by hand.

## Not built

- **No tool moves a person to another issuer**: after a change of identity provider the same people arrive as new users, their old accounts and missions unreachable. → [authentication](authentication.md)
- **No deprovisioning feed from the identity provider**: a user removed there stays active until an administrator deactivates them. → [authentication](authentication.md)
- **The demo is not a deployment**: `npm run demo` signs anybody in as anybody, answers services from memory, binds loopback, refuses a production environment and is not in the image. → [demo-mode](demo-mode.md)

## Kept until the next major version
