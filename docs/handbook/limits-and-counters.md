---
title: Ceilings and counters
tracks:
  - apps/gateway/src/server/limits/
  - apps/gateway/src/server/http/ops-stats.ts
  - apps/gateway/src/app/ops/stats/route.ts
  - apps/gateway/src/server/setup/state.ts
  - apps/gateway/src/server/compose/root.ts
last_reviewed: 2026-10-31
---

# Ceilings and counters — handbook

The `limits.*` ceilings on users, accounts and active missions, and `GET /ops/stats`.
Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §4.3 bis.

## Start here

- [`limits/counts.ts`](../../apps/gateway/src/server/limits/counts.ts) — the one definition of each count, and which edit revives a mission.
- [`limits/ceilings.ts`](../../apps/gateway/src/server/limits/ceilings.ts) — the refusal sentence, in one place.
- [`limits/service.ts`](../../apps/gateway/src/server/limits/service.ts) — `InstanceLimits`, built once as `root.limits`.
- [`http/ops-stats.ts`](../../apps/gateway/src/server/http/ops-stats.ts) — the endpoint's gate; the body is [`limits/stats.ts`](../../apps/gateway/src/server/limits/stats.ts).

## Invariants

- One count per item: the ceilings, the settings ("This gateway"), `/ops/stats` and the
  telemetry profile (`compose/root.ts`) all read `root.limits.counts`. Never count a list again.
- Every adding path asks `CeilingCheck.refusal(...)` before it writes; the services take it as
  an optional `ceilings` dep, and only the root passes it. A module built without it enforces
  nothing — tests rely on that.
- Where each count is enforced, and its refusal:
  - users — `completeLogin` for an unknown identity (`LoginError` `user-limit-reached`),
    the local invitation link before `createAccountFromLink`, an invitation for an address no
    active person holds, a reactivation, the setup's first administrator (`UserAdminError`
    `limit-reached`), naming an administrator from a sign-in test (`LimitReachedError`);
  - accounts — `AccountService.start` before any provider is reached, and `persist`
    before `accounts.create`; never with a `reconnectId` (`ConnectError`
    `account-limit-reached`);
  - active missions — `MissionService.issue` (so the duplicate, the `vaubaan` plugin and the v4
    import too: `IssueResult` `limit-reached`; door code `instance-limit-reached`), an edit and
    a granted `extend-expiry` that give an ended mission a new end (`revivesEndedMission`).
- Nothing at or above a ceiling is cut: no code path reads a ceiling except before an addition.

## Traps

- The check and the write are not one transaction: two additions racing for the last place
  may both pass. Accepted — a capacity rule, not a security boundary.
- The boot migration of local second factors (`auth/second-factor.ts` `adoptLocalFactors`)
  creates user rows and is deliberately not checked: a boot is never refused.
- The sign-in page and the claim form show a static sentence (`?error=` / `?problem=` carry a
  code only): the count reaches the log, never an anonymous visitor. JSON answers and
  administrators' notices carry the count.
- The import of a v4 account (`importPastedKey`, `importSshKey`) skips `start`: only the
  `persist` check refuses it.
- `/ops/stats` checks the token before the setup state: an outsider cannot tell setup from
  ready. It is in `SETUP_PATHS` (`setup/state.ts`) so the proxy does not redirect it.
- `store.bytes` adds the `-wal` file; right after a checkpoint the number drops.

## Outside the repo

- `ops.token` lives in the platform's secrets (`VAUBAAN_OPS_TOKEN_FILE`); the operator's
  monitoring sends it as `Authorization: Bearer`. Rotate by changing it and restarting.

## Debug

- 404 on `/ops/stats` with the right token → `ops.token` is not set (the boot log says
  `ops_stats: off`).
- Additions refused although the settings show room → the ceiling counts expired-but-unrevoked
  accounts and orphaned missions: revoke them.
