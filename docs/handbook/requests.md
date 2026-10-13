---
title: Requests — claims, the request URL, the creator's decision, the inbox
status: current
date: 2026-10-13
last_synced: 2026-10-13
tracks:
  - apps/gateway/src/server/requests/
  - apps/gateway/src/app/r/
  - apps/gateway/src/app/api/requests/
  - apps/gateway/src/app/(app)/requests/
  - apps/gateway/src/components/shell/OpenRequestCount.tsx
  - apps/gateway/src/server/store/repositories/requests.ts
  - apps/gateway/src/server/budget/consistency.ts
  - apps/gateway/tests/integration/requests/
  - apps/gateway/tests/e2e/v5/exhaust-and-claim.spec.ts
  - apps/gateway/tests/e2e/v5/agent.ts
  - apps/gateway/src/server/store/repositories/sessions.ts
  - apps/gateway/src/components/shell/AppShell.tsx
  - apps/gateway/src/server/compose/root.ts
---

# Requests — claims, the request URL, the creator's decision, the inbox

What happens to a request once a refusal dropped it into the creator's inbox:
the URL the refusal carries, who may open it, what the creator sees and
decides, the events, the expiry. Spec:
[vaubaan-gateway](../spec/vaubaan-gateway.md) §0 (Request, Claim), §2.3
(Request states), §3.4, §4.2 "Request inbox", §6 ("requests are granted only
in a human session", "surface rate limits … on the request page per IP"),
§7.6. Decision:
[claim-resolutions-as-counter-credits](../decisions/claim-resolutions-as-counter-credits.md).

The request row itself is **not** created here: the budget's
`SessionService.recordCall` inserts the `claim` inside the refusal
transaction and reuses the open one on a replay
([budget-and-sessions](budget-and-sessions.md)). This module starts from that
row.

## Layout

```
apps/gateway/src/server/requests/        host-agnostic, never imports `next`
  url.ts              REQUEST_PATH_PREFIX (/r), INBOX_PATH (/requests), requestPath(), inboxRequestPath(), requestUrl(), requestUrlBuilder()
  state.ts            nextState(), effectiveState(), isDecidable(), isTerminal()                    (pure)
  claim.ts            ClaimDecision, ClaimSituation, claimOptions(), checkClaimDecision(),
                      parseClaimDecision(), formatUtc()                                             (pure, browser-safe)
  events.ts           describeEvent(), eventLineOf() — one line per session event                   (pure)
  client-ip.ts        clientIpResolver(trustedProxies) — the key of the per-IP limit
  request-service.ts  RequestService: inbox / openCount / view / decide / decideClaim / sweep
  handlers.ts         Request → Response handlers: open (GET /r/:id), inbox, decide
  sweeper.ts          startRequestSweeper() — the in-process expiry timer
  index.ts            createRequestsModule(deps) → root.requests; server-only barrel
apps/gateway/src/app/
  r/[id]/route.ts                        GET  /r/<id>            → handlers.open
  api/requests/route.ts                  GET  /api/requests      → handlers.inbox
  api/requests/[id]/decide/route.ts      POST /api/requests/<id>/decide → handlers.decide
  (app)/requests/page.tsx                /requests       — the inbox
  (app)/requests/[id]/page.tsx           /requests/<id>  — the creator's view and the four actions
  (app)/requests/requests.module.css
apps/gateway/src/components/shell/OpenRequestCount.tsx   the count next to "Requests" in APP_NAV
```

The route files are one-line adapters; everything that decides is under
`server/requests` and is tested without Next.

## The request URL — one builder

`requestUrl(publicUrl, id)` = `<public_url origin>/r/<id>` (`url.ts`). The
composition root exposes it as `root.requests.requestUrl`, which is the
`requestUrl` dependency of the budget's `SessionService`: the URL in a
`budget-exhausted` / `approval-required` refusal and the route that answers it
come from the same constant (`REQUEST_PATH_PREFIX`). The id is
`encodeURIComponent`-ed.

The composition root builds the `SessionService` (`compose/root.ts`) with
`requestUrl: requests.requestUrl` and
`requestExpirySeconds: config.requests.expirySeconds`, and hands it to the
execution door as `budget`.

## Access rule

A request is addressed to the creator of its mission
(`missions.creator_user_id`). `RequestService.own(user, id)` is the only
check, used by every read and every decision: unknown id, another user, a
beneficiary of a share on the same connection, a co-owner of the connection
through its owner group, an operator — all get `forbidden`, the same answer
whether the request exists or not. The bootstrap operator is not a user and
is refused before the service is asked.

## `GET /r/<id>` — the gate of the forwarded URL

`handlers.open`, in this order:

| Step | Check                                             | Answer                                                                    |
| ---- | ------------------------------------------------- | ------------------------------------------------------------------------- |
| 1    | per-IP rate limit                                 | 429 page, `Retry-After`                                                   |
| 2    | an `Authorization` header is present              | 403 JSON `wrong-credential-kind` (`presented`, `expected: human-session`) |
| 3    | no web session                                    | 303 `/auth/login?return_to=%2Fr%2F<id>` (sign-in, then back here)         |
| 4    | bootstrap session, or the user is not the creator | 403 page: "This request is addressed to its creator." and nothing else    |
| 5    | the creator                                       | 303 `/requests/<id>`                                                      |

The 403 and 429 pages are self-contained HTML built in `handlers.ts` (`page()`):
the route answers with a real status code before any application shell
exists, `noindex`, `no-store`. The sentence is `ADDRESSED_TO_CREATOR`; the
page `/requests/<id>` shows the same one to a non-creator who types its
address.

**Rate limit.** `RateLimiter.take('request-page:ip:<ip>',
REQUEST_PAGE_RATE_LIMIT (30), REQUEST_PAGE_RATE_WINDOW_MS (60 s))` through the
composition root's port. The address is `clientIpResolver(config.trustedProxies)`:
the right-most `X-Forwarded-For` hop that is not a trusted proxy (addresses
or CIDR blocks, IPv4 and IPv6, `node:net` `BlockList`). With no
`trusted_proxies` configured the header is ignored and every caller shares
the key `unknown`: the limit is then global to `/r/*` rather than bypassable
with a forged header. Only `/r/*` is limited; the inbox and the decision
endpoint are not, so a flood on the forwarded URL never keeps a signed-in
creator from answering.

**Bearers.** Step 2 applies to the three routes, even when a valid session
cookie comes with the header: an executor that also holds its human's cookie
still cannot claim for itself through its HTTP client. `presented` is
`mission-token` when the value has the `vbn_live_` shape, `bearer` otherwise;
nothing is verified or looked up.

## The service

```ts
const requests = new RequestService({ store, registry, publicUrl, clock, logger });

await requests.inbox(user); // RequestSummary[] — open, unexpired, oldest first
await requests.openCount(user); // the badge
await requests.view(user, id); // { outcome: 'ok', view } | { outcome: 'forbidden' }
await requests.decide(user, id, raw); // untrusted body; dispatches on the request's kind
await requests.decideClaim(user, id, decision);
await requests.sweep(); // expires overdue open requests; returns how many
```

`RequestSummary` = `{ id, kind, state, risk_id, risk_label, created_at,
expires_at, decided_at, decision, url, mission: { id, name } }`. `state` is
always `effectiveState(request, now)`. `risk_label` comes from the plugin's
catalog through the registry (`enumerateCatalog`), the id itself when the
plugin or the entry is gone.

`view()` for a claim returns a `ClaimView`: the summary, `mission { id, name,
state, expires_at }` (`deriveMissionState`), the current `period`, `risk`
(`{ risk_id, label, quota, consumed, remaining }`, `null` when the risk left
the policy), `other_risks`, `events` (the last `SESSION_EVENTS_SHOWN` = 20
session events, most recent first, each with a one-line `summary` from
`describeEvent`) and `options` (empty once the request is not open). For an
approval request it returns `{ kind: 'approval', request }` and nothing else.

### State machine (`state.ts`)

`open → granted | refused | expired`; the three are terminal
(`nextState`). The stored state of an overdue request stays `open` until the
sweeper or a decision attempt flips it; `effectiveState()` reads it as
`expired` meanwhile (`expires_at <= now`, the same boundary as the store), so
no reader depends on the sweeper's punctuality.

### The four resolutions (`claim.ts`)

`ClaimDecision` is `{ resolution: 'reset-period' } | { resolution:
'extend-quota', amount } | { resolution: 'extend-expiry', expires_at } |
{ resolution: 'refuse' }`. `claimOptions(situation)` always returns the four,
in this order, each with a one-line `consequence` and `unavailable`
(`ClaimProblem | null`); `checkClaimDecision(situation, decision)` applies the
same rules to a decision. `ClaimSituation` is read at decision time: mission
state, expiry, current period end, the risk's quota and what it consumed in
the current period.

| Resolution      | Effect                                                                                | Refused when                                                                                        |
| --------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `reset-period`  | every counter of the mission's **current** period → 0 (all risks)                     | mission revoked / orphaned (`mission-closed`), expired (`mission-expired`), risk left the policy    |
| `extend-quota`  | `amount` actions given back on the claimed risk, current period only                  | same, plus `nothing-consumed`; `amount` not an integer in `1 … consumed` (`invalid-amount`)         |
| `extend-expiry` | `missions.expires_at` moved; a mission stored `expired` becomes `active` again        | `mission-closed`; no expiry (`no-expiry`); date not later than max(now, current) (`invalid-expiry`) |
| `refuse`        | nothing; the risk stays exhausted until the next period, the other risks keep running | never                                                                                               |

No resolution edits `mission_policy`: the next period starts from the
mission's quota. The period is the one current **when the creator decides**
(a claim answered after a rollover acts on the new period, where usually
nothing is exhausted any more). `parseClaimDecision(raw)` accepts a JSON body
or form fields (strings); unknown keys are refused; a date-time with no
offset — what a `datetime-local` field posts — is read as UTC.

### `decideClaim` — one transaction

1. `own()`; the request must be a claim (`unsupported-kind` otherwise).
2. `store.requests.decideClaim(id, userId, apply)` runs in one
   `BEGIN IMMEDIATE` transaction (store primitive, below): the request must
   still be open and unexpired — an overdue one is flipped to `expired` right
   there and the answer is `not-open`; `apply` reads the counters **inside**
   the transaction, re-checks the decision (`ClaimProblemError` rolls
   everything back), applies the effect and records the event; then the
   conditional `UPDATE … WHERE state = 'open'` stores state, `decided_at`,
   `decided_by_user_id` and `decision_json`.
3. After commit: an admin audit entry (object `{ type: 'request', id }`) and
   a log line.

| Resolution      | Request state | Session event                                                                               | Audit act         |
| --------------- | ------------- | ------------------------------------------------------------------------------------------- | ----------------- |
| `reset-period`  | `granted`     | `reset` `{ request_id, period_start, period_end, credits: { <risk>: n, … } }`               | `period-reset`    |
| `extend-quota`  | `granted`     | `extension` `{ request_id, dimension: 'quota', amount, period_start, period_end, credits }` | `budget-extended` |
| `extend-expiry` | `granted`     | `extension` `{ request_id, dimension: 'expiry', expires_at_before, expires_at }`            | `expiry-extended` |
| `refuse`        | `refused`     | `request` `{ request_id, request_kind, state: 'refused' }`                                  | `request-refused` |

Every event carries `riskId` (the claimed risk) and `actorUserId`. These shapes
are the `reset`, `extension` and `request` members of `SessionEventDetails`
(`@vaubaan/shared`); `ClaimDecisionContext.recordEvent` takes a typed
`NewEvent`, and the timeline (`events.ts`) and the check below read them back
through `parseEventDetails` (budget handbook, "One contract for event
details"). An event whose stored details are malformed reads as a line without
detail (`Allowed a tool`, `A request changed state`, `The creator extended the
mission`…). The mission
token does not change; the executor replays its call. Once a claim is decided
or expired, the next refused call drops a new one (budget handbook).

`DecideResult`: `{ ok: true, request }` or `{ ok: false, reason: 'forbidden' |
'not-open' (+ state) | 'unsupported-kind' (+ kind) | 'invalid' (+ problem) }`.

### Credits and the counters-vs-audit check

A granted `reset-period` or quota `extension` lowers `session_counters`
without touching the audit. Its event records how many actions it gave back
per risk (`details.credits`, for the period `details.period_start`), and
`countersAgreeWithAudit` (`budget/consistency.ts`) compares
`counted + credited == audited` per risk, reading the `reset` / `extension`
events of the period (`CREDIT_EVENT_KINDS`). Each report line is
`{ risk_id, counted, credited, audited }`.

## HTTP surface

| Route                           | Handler  | Answers                                                                                                                                                                                       |
| ------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /r/:id`                    | `open`   | see the gate above                                                                                                                                                                            |
| `GET /api/requests`             | `inbox`  | 200 `{ requests }` · 401 · 403 (bearer, bootstrap)                                                                                                                                            |
| `POST /api/requests/:id/decide` | `decide` | 200 `{ request }` · 400 not a body · 401 · 403 `origin-mismatch` / `forbidden` / `wrong-credential-kind` · 409 `request-not-open` (+ `state`) / `unsupported-kind` · 422 `<ClaimProblemCode>` |

`decide` checks, in order: bearer, then `guardMutation(request, deps, 'user')`
(origin, user session; handbook [authentication](authentication.md)), then
the service. `inbox` and `open` are reads: bearer, then `guardSession` (the
same session and role check, no origin). A JSON body gets JSON; a form post (the page's forms,
`application/x-www-form-urlencoded` or `multipart/form-data`) gets a 303 back
to `/requests/<id>` with `?decided=1` or `?problem=<code>`
(`DecideProblemCode`), except `forbidden`, which gets the same 403 page as
`/r/<id>`. All answers are
`Cache-Control: no-store`.

## Pages

- **`/requests`** — the inbox: one row per open request addressed to me
  (kind, mission, risk label and id, asked, expires). Reachable from the
  application bar without any forwarded URL. `APP_NAV` has the entry
  `{ href: '/requests', label: 'Requests', Count: OpenRequestCount }`; an
  entry's optional `Count` is a server component rendered after the label
  (`AppShell`), here a badge with `openCount()`, nothing at zero.
- **`/requests/<id>`** — the creator's view, top to bottom: _What is asked_
  (mission and its state, risk, `quota · consumed · left` this period, period
  end, mission expiry, asked, expiry or outcome), _Your decision_ (one row per
  option: a plain `method="post"` form to `/api/requests/<id>/decide` with a
  hidden `resolution`, the consequence line, the amount field for
  `extend-quota` pre-filled with the maximum, the `datetime-local` field for
  `extend-expiry`, the reason when unavailable), _Other risks this period_,
  _Last session events_. Once decided or expired the actions are gone and the
  outcome is shown. No client component, no script.

## Expiry sweeper

`startRequestSweeper({ sweep, logger, intervalMs })` (`sweeper.ts`) calls
`RequestService.sweep()` every `REQUEST_SWEEP_INTERVAL_MS` (60 s) on an
`unref`-ed timer; `createRequestsModule` starts it when the composition root
is built and `root.close()` stops it (`root.requests.sweeper.stop()`). A
failing pass is logged (`request sweep failed`) and the next one runs; a pass
is never stacked on one still running; `runOnce()` is exposed for tests and
diagnostics.

`sweep()` → `store.requests.sweepExpired()`: every `open` request with
`expires_at <= now` becomes `expired`, its sealed arguments are erased, and a
`request` event `{ request_id, request_kind, state: 'expired' }` is recorded
on its mission's session, all in one transaction. The delay is the
configuration's `requests.expiry` (`VAUBAAN_REQUEST_EXPIRY`, default `24h`),
stamped as `expires_at` by the budget when it drops the request. The flip is
idempotent, so several replicas may each run their own sweeper against a
shared store.

## What the store gained

Additive, in `store/repositories/requests.ts` and `sessions.ts`:

- `RequestsRepo.decideClaim(id, decidedByUserId, apply)` →
  `{ status: 'decided', request, outcome } | { status: 'not-open', request }`.
  `apply(ctx)` is synchronous and gets a `ClaimDecisionContext`: `request`,
  `session`, `now`, `counters(periodStart)`, `resetCounters(periodStart)`
  (returns what each counter held), `creditCounter(periodStart, riskId,
amount)` (one conditional `UPDATE … WHERE consumed >= amount`; `false` and
  nothing written otherwise — a counter never goes below zero),
  `setMissionExpiry(iso)`, `recordEvent(event)`. Not a claim →
  `InvariantError`; unknown id → `NotFoundError`.
- `RequestsRepo.sweepExpired()` → the expired `RequestRecord[]` (the older
  `expireOpen()` still returns a bare count and records no event).
- `SessionsRepo.listEvents(sessionId, { kinds?, order?: 'asc' | 'desc', since?, limit? })`.

## Approvals

Approval requests (`kind: 'approval'`, spec §3.5) are decided in feature
**P2.1**. Until then:

- they appear in the inbox and through `GET /api/requests` like any request;
- `view()` returns `{ kind: 'approval', request }` and the page shows a
  neutral notice ("Approval requests are handled in a later version"), never
  the arguments;
- `RequestService.decide()` answers `unsupported-kind` (409) — the `switch` on
  the request's kind is where `decideApproval` plugs in, one decide entry
  point per kind;
- the sweeper already expires them and erases their sealed arguments.

## How to debug

- **The claim URL answers 403 to the right person** — they are not
  `missions.creator_user_id` (an owner of the connection is not enough), or
  they are signed in with the bootstrap token.
- **429 on `/r/…` for everybody** — no `trusted_proxies`: all callers share
  one key. Set it to the address or CIDR of the TLS terminator.
- **`request-not-open`** — already decided, or past `expires_at`
  (`requests.state`, `decided_at`, `decision_json`). The executor's next
  refused call opens a new claim.
- **`invalid-amount` on a quota extension** — the amount exceeds what the
  risk consumed in the _current_ period (`session_counters`); after a
  rollover that is 0 and the option is unavailable.
- **The risk is still refused after `extend-expiry`** — by design: the expiry
  moved, the counters did not.
- **`countersAgreeWithAudit` reports a mismatch after a grant** — look for the
  `reset` / `extension` event of the period and its `details.credits`.

## Tests

- Unit, beside the code (58): `state.test.ts` (9, with the URL builder),
  `claim.test.ts` (37), `client-ip.test.ts` (2: the page uses the shared
  client-address rule, itself tested in `src/server/http/client-ip.test.ts`,
  11), `events.test.ts` (6), `sweeper.test.ts` (4).
- Integration, `tests/integration/requests/` (43): `request-service.test.ts`
  (30, `:memory:` store with a manual clock) and `request-handlers.test.ts`
  (13, the real root). One more scenario in
  `tests/integration/budget/pipeline-consistency.test.ts` (credits vs audit)
  and the `listEvents` options in `tests/integration/store/sessions.test.ts`.
- Browser, `tests/e2e/v5/exhaust-and-claim.spec.ts` (1).

Scenarios in [integration-tests](../tests/integration-tests.md) and
[e2e-tests](../tests/e2e-tests.md).

## References

- Spec [vaubaan-gateway](../spec/vaubaan-gateway.md) §0, §2.3, §3.4, §3.5,
  §4.2, §6, §7.6.
- ADRs [claim-resolutions-as-counter-credits](../decisions/claim-resolutions-as-counter-credits.md),
  [atomic-budget-accounting](../decisions/atomic-budget-accounting.md).
- Neighbours: [budget-and-sessions](budget-and-sessions.md), [store](store.md),
  [authentication](authentication.md), [missions](missions.md),
  [configuration](configuration.md), [gateway-core](gateway-core.md).
