---
title: Budget and mission logs — the decision, the mission log service, rate windows
tracks:
  - apps/gateway/src/server/budget/
  - apps/gateway/src/server/rate-limit/
  - apps/gateway/src/server/store/repositories/mission-logs.ts
  - apps/gateway/src/server/store/repositories/approvals.ts
  - packages/gateway-core/src/fingerprint.ts
  - packages/shared/src/mission-log-events.ts
  - apps/gateway/src/server/compose/wire-modules.ts
last_reviewed: 2026-11-25
---

# Budget and mission logs — handbook

How a call that passed the risk check is counted against its mission's quota, rate and gate. Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §2.3, §3.2–3.5, §6; ADRs [atomic-budget-accounting](../decisions/atomic-budget-accounting.md), [resource-sets-partition-a-mission-connection](../decisions/resource-sets-partition-a-mission-connection.md). Claims and approvals after a refusal: [requests](requests.md).

## Start here

- [`decide.ts`](../../apps/gateway/src/server/budget/decide.ts) — the pure decision, and `combineSetDecisions` across the resource sets of one call.
- [`mission-log-service.ts`](../../apps/gateway/src/server/budget/mission-log-service.ts) — `recordCall`: runs `decide()` inside the store transaction, writes events, opens requests.
- [`gates.ts`](../../apps/gateway/src/server/budget/gates.ts) — `effectiveGate`, `openedGatesOf`.
- [`mapping.ts`](../../apps/gateway/src/server/budget/mapping.ts) — the only store ⇄ domain translation for missions.
- [`sliding-window.ts`](../../apps/gateway/src/server/rate-limit/sliding-window.ts) — rate windows and surface limits.

## Invariants

- **Decrement and decision are one transaction.** `missionLogs.decideAndDecrement` reads counters, the live policy (`livePolicy`: quota, rate, window and gate as stored now; a touched risk no longer stored fails closed), opened gates and usable approvals, then calls `decide()`: no call decided after an edit commits passes above the new limit.
- **Dimension-major order**: every touched risk's quota, then every rate window, then every gate; the first failing risk names the refusal and refuses the whole call. An approved call still passes quota and rate first.
- **A refused call changes nothing**: no counter, no window entry, no approval consumed. Windows are peeked before `decide()` and pushed only on allow, inside the transaction callback.
- **Each resource set keeps its budget** (risk model §4.7). `recordCall` runs `decide()` once per set the call was judged against (`resource_set_ids` of the risk verdict; absent, the sets whose policy names a touched risk — an empty list throws `BudgetInvariantError`), and `combineSetDecisions` keeps the dimension-major order across the sets: a quota refusal in any set before a rate refusal in any, before an approval. An allowed call is charged in every set; the audit entry carries the charged sets (`audit_resource_sets`), and `countersAgreeWithAudit` compares per `(set, risk)`. An approval stays per call: it covers each gated line of each set.
- **Rollover is a key change.** Counters are keyed `(mission_log, set, risk, period_start)`; after the period ends the new key has no row, so counters read zero. Nothing runs in the background.
- **One spelling of the gate in force.** `effectiveGate` is used by `decide()`, the request page and the mission page. An opening counts only for the current `period_start` and while no later `gate-changed` or `permission-removed` of that line exists, ties included (the edit wins). Openings are per line (`openedGatesOf` → `Set<PolicyLineKey>`): an event with no `resource_set_id` (written before 0029 on an event the migration could not attribute) opens nothing, and closes every set.
- **One budget per mission.** `agent_label` and the token holder are copied into events, never a key nor an input of `decide`: adding a token or a label adds no budget.
- **One fingerprint everywhere.** `fingerprintArguments` (canonical JSON, `@vaubaan/gateway-core`) binds approval requests, approvals, the `approval-required` refusal and the audit's `arguments_hash`. The approval key is mission + tool + fingerprint.
- **One event contract.** `MissionLogEventDetails` (`packages/shared/src/mission-log-events.ts`) types every writer's `NewEvent`; readers call `parseEventDetails` only (`null` on an unknown kind or bad shape, never throws). Stored keys are data: renaming one needs a migration of `events`.
- **`counted + credited == audited`** per risk and period (`countersAgreeWithAudit`, `consistency.ts`): asserted after a mixed run through the real `CallPipeline`, usable live.
- **Edits never reset counters or windows**: none of mission log, risk or period moves — which is why the period is not editable.

## Traps

- **Arguments are sealed before the transaction** (`requests.prepareArguments`): the encryptor is async, the SQLite transaction is not. The blob is kept only if an approval request is created.
- **`BudgetInvariantError` is not a refusal**: a touched risk absent from the policy means the risk stage broke its guarantee; the transaction rolls back and the pipeline turns it into a `rejected`, audited call.
- **Not refunded.** The increment commits before the upstream call; an upstream failure, a broken or abandoned stream included, keeps the credit consumed. The creator gives it back through a claim.
- **One-off anchor.** `budget-stage.ts` re-reads the mission row for a one-off period's anchor, because the shared one-off `Period` carries none.
- **Name clash.** The store's camelCase entry is also called `MissionPolicyEntry`; consumers alias it `MissionPolicyEntryRecord`.
- **Readers built before the service.** Missions and requests are built before the `MissionLogService` (which needs `requestUrl`), so they default to `missionUsageReader(store.missionLogs)` — the same current-period-only read, not a copy.
- **One limiter, disjoint keys.** The root builds one `SlidingWindowRateLimiter` for the budget (`mission:<id>:set:<set>:risk:<risk>`) and every surface limit (the key prefix of each `rateLimiter.take`: `mcp:mission:`, `auth:`, `connect:`, `request-page:`, …); a new surface limit takes a prefix of its own. It is in memory and single-process; a hosted replacement is Redis behind the same two interfaces, probing before the SQLite transaction and recording after commit.
- **Set membership is read twice.** The risk stage judges a call on the sets of the mission context loaded at admission, and the budget transaction charges those set ids; an edit that moves a resource to another set between the two charges the call on the sets it was judged against (known limitation, not fixed).
- **A longer rate window after an edit** counts only what memory still holds: slightly lenient for one window's length.
- **Git push preflight.** `preflightLimits` runs the same transaction and `decide()` without approvals and counts nothing; the git door calls it before a pack leaves ([git-remote](git-remote.md)).

## Debug

- **Usage disagrees with the audit** → `countersAgreeWithAudit(...)` lists `mismatches`; a one-off mission older than the retention mismatches by design ([audit](audit.md)).
- **"Ask me first" yet calls pass** → a `gate-opened` event for the current period; a later `gate-changed` closes it.
- **Exhausted yesterday, fine today** → expected: state reads the current period's counters only.
