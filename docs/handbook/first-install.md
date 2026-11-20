---
title: First installation — the acceptance run
tracks:
  - deploy/compose.yaml
  - deploy/config/
  - apps/gateway/src/server/missions/bootstrap-kit.ts
  - apps/gateway/tests/e2e/cutover-smoke.spec.ts
  - apps/website/content/docs/install/check-your-instance.mdx
last_reviewed: 2026-11-20
---

# First installation — handbook

The maintainers' acceptance run of a release on a real instance, with a real
identity provider, real services and Claude Code. An operator's own checks
after an install, and how to read a refusal, are on the site:
[check your instance](https://vaubaan.com/docs/install/check-your-instance)
(installing: [Install](https://vaubaan.com/docs/install)). Scenario
conventions: [e2e-tests](../tests/e2e-tests.md).

Coming from v4, the earlier hosted product: import an organization with
[import-from-v4](import-from-v4.md), then run this checklist.

## Start here

- [`cutover-smoke.spec.ts`](../../apps/gateway/tests/e2e/cutover-smoke.spec.ts) — the automated smoke that precedes the run.
- [`bootstrap-kit.ts`](../../apps/gateway/src/server/missions/bootstrap-kit.ts) — what the agent's project receives.

## Procedures — acceptance run

1. Deploy an image from a tagged commit whose `e2e` job is green; `curl -s <public_url>/healthz` answers `"status":"ok"` with that version and commit.
2. Run the site's [check your instance](https://vaubaan.com/docs/install/check-your-instance) steps 2 to 5 as written: they are the run's script, and a step that does not work as written is a docs bug of the run. Sign in at `/admin/bootstrap`, then "Finish setup" on `/admin` once the sign-in provider works (it revokes the bootstrap token; see [authentication](authentication.md)).
3. Connect every service the owner uses, and issue one mission per code project.
4. Work a day on every project. **Log each refusal**: code, field to copy, expected or unexpected (the site page's "Reading an unexpected refusal"). Zero unexpected refusal passes the run; each unexpected one goes back to a trust level, a catalog or a fix.

## Traps

- Account set-up, as met in the runs so far: GitHub wants a fine-grained token per organisation, with the organisation as resource owner, and Workflows write only if missions push `.github/workflows/`; Resend a full-access key (discovery lists domains); Cloudflare an API token, not the Global API Key.
- The refusals the site page lists as expected (an `approval_url` until approved, no code without a resource ref, `duplicate-service`, a 403 that does not refresh) are not failures of the run.

## Debug

- "Vaubaan rejected the call" with no code on a legitimate call: the classifier cannot place it, a plugin bug ([plugin-sdk](plugin-sdk.md#debug)). "Upstream error" on a call the service should accept: the gateway built a wrong request.
- Claude Code does not connect after the site page's checks: [execution-door](execution-door.md).
