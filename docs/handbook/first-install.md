---
title: First installation — the acceptance run
tracks:
  - deploy/compose.yaml
  - deploy/config/
  - apps/gateway/src/server/missions/bootstrap-kit.ts
  - apps/gateway/tests/e2e/v5/cutover-smoke.spec.ts
last_reviewed: 2026-11-05
---

# First installation — handbook

How to validate a new instance with a real identity provider, real services
and Claude Code, after installing it with
[`deploy/README.md`](../../deploy/README.md). Scenario conventions:
[e2e-tests](../tests/e2e-tests.md).

Coming from v4, the earlier hosted product: import an organization with
[import-from-v4](import-from-v4.md), then run this checklist.

## Start here

- [`cutover-smoke.spec.ts`](../../apps/gateway/tests/e2e/v5/cutover-smoke.spec.ts) — the automated smoke that precedes the run.
- [`bootstrap-kit.ts`](../../apps/gateway/src/server/missions/bootstrap-kit.ts) — what the agent's project receives.

## Procedures — acceptance run

1. `curl -s <public_url>/healthz` answers `"status":"ok"` with the expected version and commit (image from a tagged commit with a green `e2e` job).
2. Sign in at `/admin/bootstrap`, configure the sign-in provider, sign in through it as an administrator, then "Finish setup" on `/admin` (it revokes the bootstrap token; see [authentication](authentication.md)).
3. Connect each account; each ends "Connected" with its resources.
4. Label environments (`staging`, `prod`) and hide what no mission should see **before** issuing missions: an env-qualified permission is only issued when a selected resource carries that label.
5. One mission per code project, from the GitHub macro-actions Read and Propose at Trusting; copy the kit (the key is shown once), export `VAUBAAN_MISSION_TOKEN` where Claude Code runs, add the kit's `.mcp.json` entry and instructions, run its `curl`.
6. Work a day on every project. **Log each refusal**: code, field to copy, expected or unexpected (Debug below). Zero unexpected refusal passes the run; each unexpected one goes back to a trust level, a catalog or a fix.

## Traps

- Expected during the day: a gated permission refuses with an `approval_url` until approved, then the identical call replays; a call without its resource ref is "Vaubaan rejected the call" with no code; one connection per provider per mission (`duplicate-provider`); a provider 403 is a failed call, only a 401 refreshes and may expire the connection.
- GitHub: a fine-grained token per organisation, the organisation as resource owner; Workflows write only if missions push `.github/workflows/`. Resend: a full-access key (discovery lists domains). Cloudflare: an API token, not the Global API Key.

## Debug — reading a refusal

Read the agent's error (`code`, `hint`) or Activity filtered by mission and "refused".

- `budget-exhausted` (`risk_id`, `claim_url`) — unexpected when an ordinary day overruns the trust level's quota.
- `rate-limited` (`retry_after_seconds`) — unexpected when ordinary work trips it repeatedly (the trust level's rate).
- `approval-required` (`approval_url`) — unexpected when the identical replay asks again (bug) or an ordinary action asks all day (the row's gate at that trust level).
- `risk-not-accepted` (`missing_risks`) — unexpected for an ordinary action (a macro-action not ticked, or left out by its trust level), or `…uncategorized-write` (catalog hole).
- `resource-not-in-mission` (`cited_ref`) — unexpected for a resource the project needs, or one gone `stale` after a discovery refresh.
- `connection-unavailable` — unexpected on a healthy connection: credential refresh, read the server log.
- `wrong-credential-kind` — always unexpected: the token went to the wrong door, or a browser cookie rode along.
- "Vaubaan rejected the call" with no code — unexpected when the classifier cannot place a legitimate call (plugin bug); "Upstream error" — unexpected when the gateway built a wrong request.
- Claude Code does not connect: `curl` the kit's check first. 401 with a fresh token → the `Authorization` header does not reach the instance (variable not exported, or the proxy strips it); 401 with `error.data.reason` → export the current token; 403 on every request → the client sends `Origin`, the door answers no CORS. Then [execution-door](execution-door.md).
