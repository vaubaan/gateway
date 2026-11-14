---
title: Requests
tracks:
  - apps/gateway/src/server/requests/
  - apps/gateway/src/server/execution/permission-request.ts
  - apps/gateway/src/server/store/repositories/requests.ts
  - apps/gateway/src/server/store/repositories/approvals.ts
  - apps/gateway/src/server/store/repositories/permission-requests.ts
  - apps/gateway/src/server/budget/consistency.ts
  - apps/gateway/src/server/budget/gates.ts
  - apps/gateway/src/app/(app)/waiting/
last_reviewed: 2026-11-01
---

# Requests — handbook

Claims, approval requests and permission requests: the `/r/<id>` URL, the
creator's decision, the expiry. Spec:
[vaubaan-gateway](../spec/vaubaan-gateway.md) §3.4, §3.5, §4.2, §7.6, §7.7;
ADR [atomic-budget-accounting](../decisions/atomic-budget-accounting.md).

## Start here

- [`request-service.ts`](../../apps/gateway/src/server/requests/request-service.ts) — inbox, views, decisions, sweep.
- [`requests.ts`](../../apps/gateway/src/server/store/repositories/requests.ts) — the decision transactions.
- [`claim.ts`](../../apps/gateway/src/server/requests/claim.ts), [`approval.ts`](../../apps/gateway/src/server/requests/approval.ts) — options and checks of each kind.
- [`permission-request.ts`](../../apps/gateway/src/server/execution/permission-request.ts) — the `vaubaan__request_permission` tool.

## Invariants

- Claims and approval requests are created by the budget's
  `SessionService.recordCall` inside the refusal transaction
  ([budget-and-sessions](budget-and-sessions.md)); permission requests only by
  `vaubaan__request_permission`. This module starts from the row. Both tell the
  creator's devices after commit, only for a request they created, never one
  found open ([notifications](notifications.md)).
- `RequestService.own()` is the only access check, for every read and
  decision: anyone but the creator gets `forbidden`, existing or not.
- `approvalView()` is the only caller of `RequestsRepo.getArguments`, after
  `own()`; the arguments are in no summary, event, audit entry, log or
  `decision_json`.
- `requestUrl()` builds both the URL a refusal carries and the route that
  answers it.
- `effectiveState()` reads an overdue request as `expired`: no reader depends
  on the sweeper's punctuality.
- No resolution edits `mission_policy`. A credit (reset, quota extension)
  lowers counters without touching the audit and records the credits in its
  event: `countersAgreeWithAudit` checks `counted + credited == audited`.
- An approval is keyed on tool **and** fingerprint, and is consumed only when
  the whole replayed call is allowed.
- A request is about `(set, risk)` lines (`request_lines`, migration 0029): a
  claim, its one line; an approval request, the gated line of each resource set
  the call was judged against; a permission request, the missing lines
  (`permission_refusal_lines`). A gate opened or a claim granted acts on those
  lines only. A caller giving only risk ids (`riskId`/`riskIds`) gets each risk
  in every set accepting it — the reading of a request made before 0029.

## Traps

- `own()` runs before the transaction (it derives `orphaned` through async
  repositories); the synchronous `apply` re-reads the mission's stored status
  and expiry inside `BEGIN IMMEDIATE`, so two decisions never move an expiry
  backwards.
- Bearers are refused on `/r/*` and `/api/requests` even with a valid cookie:
  an executor holding its human's cookie cannot answer for itself.
- Only `/r/*` is rate-limited, per address: a flood never blocks a signed-in
  creator. Without `trusted_proxies` every caller shares one key.
- A request of an orphaned mission still expires on the normal delay: sealed
  arguments must not outlive it. Known wart: the expiry event reads "The
  claim expired unanswered" though only a refusal was possible.
- A replay needing more gated risks than the open request lists opens a new
  request; one is never widened beyond what the page showed.
- Removing a permission from a mission closes its open claims and approval
  requests in the edit's transaction (`mission-changed`); permission requests
  stay open.
- A gate opening is derived from the period's `gate-opened` / `gate-changed`
  events (`openedGatesOf`); on an equal timestamp the edit wins.
- Pages word options from `resolution` and problem codes, never from the
  server's `label` / `consequence` strings.

## Debug

- **403 on `/r/…` for the right person** → not `missions.creator_user_id`
  (owning the account is not enough), or a bootstrap session.
- **429 on `/r/…` for everybody** → `trusted_proxies` empty.
- **`invalid-expiry` on a later date than shown** → another decision extended
  it meanwhile. **`invalid-amount`** → more than the current period consumed.
- **Replay still `approval-required` after a grant** → other arguments or
  tool (refusal `fingerprint` vs `approvals.fingerprint`), approval expired
  (10 min default) or consumed, or a gated risk it does not list.
- **`countersAgreeWithAudit` mismatch** → read the period's `reset` /
  `extension` event and its `details.credits`.
- **A gate reads `approval` but calls pass** → a `gate-opened` event for this
  period and no later `gate-changed`.
- **`no-period-end` on "open the gate"** → a one-off mission: set the gate to
  `auto`.
