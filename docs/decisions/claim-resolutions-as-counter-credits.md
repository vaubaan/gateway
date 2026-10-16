---
title: Claim resolutions — credits on the period's counters, a gate route for the request URL
status: accepted
date: 2026-10-13
extends:
  - atomic-budget-accounting
  - pivot-v4-to-v5-on-prem-mission-tokens
---

# Claim resolutions — credits on the period's counters, a gate route for the request URL

> Fixes how a granted claim (spec §3.4) changes the budget of
> [[atomic-budget-accounting]], and how the request URL is served. Implemented
> by feature P1.7. Handbook: [requests](../handbook/requests.md).

## Context

Spec §3.4 lets the mission creator answer a claim with "reset the period,
extend the quota, extend the expiry, or refuse". The plan's brief narrows the
second: the extension holds **for the current period only**; a permanent
change goes through editing the mission. Neither says how the three grants
are stored, and three constraints meet:

- the quota state is `session_counters(session_id, risk_id, period_start,
consumed)` with `CHECK (consumed >= 0)`, read as `quota - consumed` by the
  decision, the mission state, the Missions pages and the session page of a
  parallel feature;
- the store already ships `SessionsRepo.resetCounters` ("a granted claim
  'reset': the counters of the period go back to zero");
- the structural check `SUM(session_counters) == COUNT(audit allowed)`
  (spec §3.3, §10) holds by construction only while counters never go down.

Separately, spec §3.4 and §6 require the request page to refuse anyone but
the creator, to refuse a mission or delegated token, and to be rate limited
per IP. A Next.js page cannot choose its status code without the
`experimental.authInterrupts` flag, and cannot answer 429 at all.

## Decision

### A grant gives consumed actions back on the counters of the current period

- **Reset the period** sets every counter of the mission's current period to
  zero — all accepted risks, not only the claimed one. _(Changed 2026-10-13 by
  [claim-reset-is-the-claimed-risk-only](./claim-reset-is-the-claimed-risk-only.md):
  the claimed risk only.)_
- **Extend the quota** subtracts `amount` from the claimed risk's counter of
  the current period, with `1 <= amount <= consumed`. The amount is bounded by
  what was consumed: a claim can at most give back the period's consumption on
  that risk; a larger quota is a change of the mission.
- **Extend the expiry** moves `missions.expires_at` to a later date and
  touches no counter; a mission whose stored status is `expired` becomes
  `active` again.
- **Refuse** changes nothing.

`mission_policy` is never edited by a claim. The period acted upon is the one
current when the creator decides.

### The decision is one store transaction

`RequestsRepo.decideClaim(id, user, apply)` mirrors
`SessionsRepo.decideAndDecrement`: the rules live in the `RequestService`
callback, the store makes the state change, the counter or expiry effect and
the session event atomic, with the counters read inside the transaction.

### The credit is recorded on the event and the structural check adds it back

The `reset` / `extension` event carries `details.credits` (`risk → actions
given back`) and `details.period_start`. `countersAgreeWithAudit` becomes
`counted + credited == audited`. The audit stays what happened (every allowed
call), the counters stay what is left, and the difference is explained by
events of the same session.

### `/r/<id>` is a gate route; the creator's view lives at `/requests/<id>`

`GET /r/<id>` is a route handler over a host-agnostic `Request → Response`
function: per-IP limit (429), any `Authorization` header refused (403), no
session → sign-in and back, not the creator → 403 with one sentence, the
creator → 303 to `/requests/<id>`, a page of the application shell that
applies the same creator check. Only `/r/*` is rate limited.

## Consequences

- No migration and no change for any reader of the counters: the decision,
  `deriveMissionState`, the Missions and session pages see a granted claim as
  fewer consumed actions.
- A creator cannot grant more than the period consumed in one claim (quota 5,
  agent needs 50 more today: edit the mission). The page says so on the
  option.
- `session_counters.consumed` no longer equals the number of allowed calls of
  the period; whoever needs that number reads the audit, or adds the credits
  of the events as the check does. Purging `events` before the end of a
  period would make the check report the credits as mismatches.
- A reset is generous: it reopens every risk of the mission until the period
  ends. The quota extension is the targeted alternative.
- The forwarded URL answers with real status codes and is testable without
  Next; the price is one redirect for the creator and two addresses for one
  request (`/r/<id>` handed out, `/requests/<id>` displayed).
- Approvals (P2.1) add their own decide entry point next to `decideClaim`;
  nothing here constrains how an approval is stored.

## Rejected alternatives

- **A per-period extension table (`effective quota = quota + extra`), counters
  monotonic.** Keeps the audit identity untouched and allows any amount, but
  needs a migration while two features add theirs in parallel, and changes
  every reader of `quota - consumed` (decision, mission state, two UIs) at
  once. Worth revisiting if unbounded extensions are wanted.
- **Letting the counter go negative.** Forbidden by the schema's `CHECK`, and
  "consumed −15 of 5" is unreadable on the session page.
- **Clamping an oversized amount to what was consumed.** Silently grants less
  than the creator typed; a refusal naming the bound is clearer.
- **Reset of the claimed risk only.** Makes "reset the period" a synonym of
  "extend the quota by everything consumed"; the spec names two actions.
- **Editing the mission's quota from the claim.** The brief excludes it:
  permanent enlargement is an issuance-grade act with its own authority check.
- **A page at `/r/<id>` with `forbidden()`.** Needs
  `experimental.authInterrupts`, still cannot answer 429, and puts the access
  decision in a React render instead of a tested handler.
- **Rate limiting the decision endpoint with the same key.** With no trusted
  proxy configured the key is shared; a flood on `/r/*` would then block the
  creator's answer.
