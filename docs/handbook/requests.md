---
title: Requests — claims and approval requests, the request URL, the creator's decision, the inbox
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
  - apps/gateway/src/server/store/repositories/approvals.ts
  - apps/gateway/migrations/0005_approval_bound_to_tool.sql
  - apps/gateway/src/server/budget/consistency.ts
  - apps/gateway/src/server/budget/gates.ts
  - apps/gateway/tests/integration/requests/
  - apps/gateway/tests/integration/authority/share-and-orphan.test.ts
  - apps/gateway/tests/integration/execution/approval-door.test.ts
  - apps/gateway/tests/integration/store/approval-decisions.test.ts
  - apps/gateway/tests/e2e/v5/exhaust-and-claim.spec.ts
  - apps/gateway/tests/e2e/v5/approve-action.spec.ts
  - apps/gateway/tests/e2e/v5/agent.ts
  - apps/gateway/src/server/store/repositories/sessions.ts
  - apps/gateway/src/components/shell/AppShell.tsx
  - apps/gateway/src/server/compose/root.ts
---

# Requests — claims and approval requests, the request URL, the creator's decision, the inbox

What happens to a request once a refusal dropped it into the creator's inbox:
the URL the refusal carries, who may open it, what the creator sees and
decides, the events, the expiry. Two kinds share everything but their
decision: a **claim** (a quota at zero, §3.4) and an **approval request** (a
risk gated `approval`, §3.5; section [Approvals](#approvals)). Spec:
[vaubaan-gateway](../spec/vaubaan-gateway.md) §0 (Request, Claim, Approval
request, Approval), §2.3 (Request states), §3.4, §3.5, §4.2 "Request inbox",
§6 ("requests are granted only in a human session", "surface rate limits … on
the request page per IP"), §7.6, §7.7. Decisions:
[claim-resolutions-as-counter-credits](../decisions/claim-resolutions-as-counter-credits.md),
[atomic-budget-accounting](../decisions/atomic-budget-accounting.md) (amendment
"The approval gate").

The request row itself is **not** created here: the budget's
`SessionService.recordCall` inserts it inside the refusal transaction — an
approval request with the call's arguments sealed — and reuses the open one
on a replay ([budget-and-sessions](budget-and-sessions.md)). This module
starts from that row.

## Layout

```
apps/gateway/src/server/requests/        host-agnostic, never imports `next`
  url.ts              REQUEST_PATH_PREFIX (/r), INBOX_PATH (/requests), requestPath(), inboxRequestPath(), requestUrl(), requestUrlBuilder()
  state.ts            nextState(), effectiveState(), isDecidable(), isTerminal()                    (pure)
  claim.ts            ClaimDecision, ClaimSituation, claimOptions(), checkClaimDecision(),
                      parseClaimDecision(), formatUtc(), orphanedProblem()                          (pure, browser-safe)
  approval.ts         ApprovalDecision, ApprovalSituation, approvalOptions(), checkApprovalDecision(),
                      parseApprovalDecision(), formatDelay()                                        (pure, browser-safe)
  events.ts           describeEvent(), eventLineOf() — one line per session event                   (pure)
  client-ip.ts        clientIpResolver(trustedProxies) — the key of the per-IP limit
  request-service.ts  RequestService: inbox / openCount / view / decide / decideClaim / decideApproval / sweep
  handlers.ts         Request → Response handlers: open (GET /r/:id), inbox, decide
  sweeper.ts          startRequestSweeper() — the in-process expiry timer
  index.ts            createRequestsModule(deps) → root.requests; server-only barrel
apps/gateway/src/app/
  r/[id]/route.ts                        GET  /r/<id>            → handlers.open
  api/requests/route.ts                  GET  /api/requests      → handlers.inbox
  api/requests/[id]/decide/route.ts      POST /api/requests/<id>/decide → handlers.decide
  (app)/requests/page.tsx                /requests       — the inbox
  (app)/requests/[id]/page.tsx           /requests/<id>  — the creator's view and its actions (four for a claim, three for an approval request)
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
`requestUrl: requests.requestUrl`,
`requestExpirySeconds: config.requests.expirySeconds` and
`approvalValiditySeconds: config.approvals.expirySeconds`, and hands it to the
execution door as `budget`.

## Access rule

A request is addressed to the creator of its mission
(`missions.creator_user_id`). `RequestService.own(user, id)` is the only
check, used by every read and every decision: unknown id, another user, a
**member of the mission** (spec §0 "Mission member": they read the mission
and its session, never its requests), a beneficiary of a share on the same
connection, a co-owner of the connection through its owner group, an
operator — all get `forbidden`, the same answer whether the request exists
or not. The inbox (`listOpenForCreator`) and the badge are keyed on the
creator the same way, so a member's inbox stays empty whichever holder's
token caused the request. The bootstrap operator is not a user and is
refused before the service is asked.

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
with a forged header, and the instance says so in one warning at boot
([configuration](configuration.md), "Boot sequence"). Only `/r/*` is limited; the inbox and the decision
endpoint are not, so a flood on the forwarded URL never keeps a signed-in
creator from answering.

**Bearers.** Step 2 applies to the three routes, even when a valid session
cookie comes with the header: an executor that also holds its human's cookie
still cannot claim for itself through its HTTP client. `presented` and
`expected` are `BearerKind`s (`@vaubaan/gateway-core`), the vocabulary of the
two MCP doors. Nothing is verified or looked up, so the kind is read from the
shape (`bearerKindByShape`): `mission-token` for a value of the `vbn_live_`
shape, `delegated-token` for one of the `vbn_dat_` shape
(`isAccessTokenShaped`, `oauth-as/secrets.ts`). A value of neither shape has
no kind: `presented` is left out rather than invented, and the answer is the
same 403.

## The service

```ts
const requests = new RequestService({
  store,
  registry,
  grounds, // root.authority.grounds — derives `orphaned` on every mission read (required)
  publicUrl,
  approvalValiditySeconds, // config.approvals.expirySeconds
  clock,
  logger,
  // budget — optional: Pick<SessionService, 'usageOf'>; defaults to missionUsageReader(store.sessions)
});

await requests.inbox(user); // RequestSummary[] — open, unexpired, oldest first
await requests.openCount(user); // the badge
await requests.view(user, id); // { outcome: 'ok', view } | { outcome: 'forbidden' }
await requests.decide(user, id, raw); // untrusted body; dispatches on the request's kind
await requests.decideClaim(user, id, decision);
await requests.decideApproval(user, id, decision);
await requests.sweep(); // expires overdue open requests; returns how many
```

`RequestSummary` = `{ id, kind, state, risk_id, risk_label, created_at,
expires_at, decided_at, decision, url, mission: { id, name }, tool }`. `tool`
is the tool of an approval request's call (`null` for a claim); the summary
never carries arguments. `state` is always `effectiveState(request, now)`. `risk_label` comes from the plugin's
catalog through the registry (`enumerateCatalog`), the id itself when the
plugin or the entry is gone.

`view()` for a claim returns a `ClaimView`: the summary, `mission { id, name,
state, expires_at }` (the budget's `usageOf` read, which derives the state
with `deriveMissionState`), the current `period`, `risk`
(`{ risk_id, label, quota, consumed, remaining }`, `null` when the risk left
the policy), `other_risks`, `events` (the last `SESSION_EVENTS_SHOWN` = 20
session events, most recent first, each with a one-line `summary` from
`describeEvent`) and `options` (empty once the request is not open). For an
approval request it returns an `ApprovalView` ([Approvals](#approvals)).

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
the current period, and the request's own expiry (`request_expires_at`, for
the sentence of an orphaned mission).

| Resolution      | Effect                                                                                            | Refused when                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `reset-period`  | the counter of the **claimed risk** in the mission's current period → 0; no other risk is touched | mission revoked / orphaned (`mission-closed`), expired (`mission-expired`), risk left the policy    |
| `extend-quota`  | `amount` actions given back on the claimed risk, current period only                              | same, plus `nothing-consumed`; `amount` not an integer in `1 … consumed` (`invalid-amount`)         |
| `extend-expiry` | `missions.expires_at` moved; a mission stored `expired` becomes `active` again                    | `mission-closed`; no expiry (`no-expiry`); date not later than max(now, current) (`invalid-expiry`) |
| `refuse`        | nothing; the risk stays exhausted until the next period, the other risks keep running             | never                                                                                               |

`orphaned` is derived, never stored ([authority](authority.md)): `own()`
reads the mission through `grounds.derive` (`RequestServiceDeps.grounds`,
required) on every view and every decision. A request of an orphaned mission
therefore shows its options unavailable (`mission-closed`), takes a refusal
only, and is decidable again — the same request, if it has not expired — as
soon as the creator's authority returns. The same holds for an approval
request.

#### A request on an orphaned mission still expires

The sweeper expires the open requests of an orphaned mission on the normal
`requests.expiry` delay, like any other. This is a decision, not an oversight
(ADR
[request-expiry-on-orphaned-missions](../decisions/request-expiry-on-orphaned-missions.md)):

- **The sealed arguments live as long as the request and no longer** (spec
  §3.5). Pausing the request's clock while the mission is orphaned would hold
  the arguments of an approval request for an unbounded time — and for ever on
  a revoked connection, whose missions never come back.
- **A status filter in the sweep's SQL would be the one reader that bypasses
  the derived `orphaned`.** The store holds `active` for an orphaned mission;
  `sweepExpired` reads no mission at all.
- **Nothing is lost.** Once the authority is back, the executor's next refused
  call opens a new request (`request-not-open` on the old one).

What the creator reads says so. `orphanedProblem(request_expires_at)`
(`claim.ts`, used by both kinds) is the sentence of every unavailable option:
"The mission is orphaned: the authority behind it is missing, so every call is
refused whatever you decide. The request can be granted once that authority is
back, until it expires (`<request expiry, UTC>`); after that, the executor's
next refused call opens a new one." A revoked mission gets no such promise.

Left as it is: the session event of the expiry. The sweep writes `request`
`{ request_id, request_kind, state: 'expired' }` for every request, and the
timeline renders it "The claim expired unanswered" (`events.ts`), which for a
request on an orphaned mission reads as if the creator had not answered while
they could only refuse. Saying otherwise needs a field on
`RequestClosedEventDetails` (`@vaubaan/shared`) that the sweep would set from
the verdict `MissionGrounds` derives for each expiring request; the sweep's
SQL would still not filter on a status. It is not a change of the request
service alone: the event is written by `RequestsRepo.sweepExpired()` inside
its own synchronous transaction, which also selects the overdue requests, so
the verdicts would have to be derived before that transaction, for requests
it has not selected yet, and passed into the repository.

The executor is told the same thing as the creator. The `mission-inactive`
refusal of an orphaned mission (`INACTIVE_MISSION_NEXT_STEP.orphaned`,
`@vaubaan/gateway-core`), the bootstrap kit (`REFUSAL_GUIDANCE`) and
`/agent-bootstrap.md` end on: "A request opened before the mission was
orphaned can be granted only until it expires; after that, your next refused
call opens a new one."

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
   there and the answer is `not-open`; `apply` reads the counters and the
   mission's stored status and expiry (`ctx.mission`) **inside** the
   transaction, re-checks the decision (`ClaimProblemError` rolls
   everything back), applies the effect and records the event; then the
   conditional `UPDATE … WHERE state = 'open'` stores state, `decided_at`,
   `decided_by_user_id` and `decision_json`.
3. After commit: an admin audit entry (object `{ type: 'request', id }`) and
   a log line.

**What the decision is checked against.** `own()` runs before the transaction
(it derives `orphaned` through asynchronous repositories, which the
synchronous `apply` cannot call). The mission fields a rule reads are
therefore taken again inside it: `decidedMissionOf(mission, ctx.mission)`
keeps the policy and the `orphaned` verdict `own()` read and replaces the
status and the expiry by the row's, as of the transaction. Two
`extend-expiry` decisions on two claims of one mission are each checked
against the stored expiry, so the second cannot move it backwards
(`invalid-expiry`); a mission revoked between the read and the write takes no
reset, no extension and no approval (`mission-closed`). The `orphaned` verdict
itself stays a read of the instant before the transaction, and the policy
(quota, gate) is the one `own()` read.

| Resolution      | Request state | Session event                                                                                                       | Audit act         |
| --------------- | ------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `reset-period`  | `granted`     | `reset` `{ request_id, period_start, period_end, credits: { <claimed risk>: n } }` (`{}` when nothing was consumed) | `period-reset`    |
| `extend-quota`  | `granted`     | `extension` `{ request_id, dimension: 'quota', amount, period_start, period_end, credits }`                         | `budget-extended` |
| `extend-expiry` | `granted`     | `extension` `{ request_id, dimension: 'expiry', expires_at_before, expires_at }`                                    | `expiry-extended` |
| `refuse`        | `refused`     | `request` `{ request_id, request_kind, state: 'refused' }`                                                          | `request-refused` |

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

**Token holders.** A request is the mission's, not a holder's: the row, the
summary and the `request` event of the drop name no holder, and the two
pages show none. Who caused it is on the refused call's own event
(`call-refused`: `token_id`, `token_kind`, `holder`, with the `request_id`),
which the mission's session page shows per holder ([audit](audit.md)); the
one-line `describeEvent` of a call names the tool, the refusal code and the
agent label only. A `rotation` event reads "A mission token was issued" for
a holder's first token and "A mission token was rotated" otherwise; a
`revocation` event reads "One token of the mission was revoked" when it
names a token, "The mission was revoked" otherwise.

`DecideResult`: `{ ok: true, request }` or `{ ok: false, reason: 'forbidden' |
'not-open' (+ state) | 'unsupported-kind' (+ kind) | 'invalid' (+ problem) }`.
`decide()` parses the body with the parser of the request's kind, so a claim
resolution posted to an approval request (or the reverse) is `invalid` /
`invalid-decision`; `unsupported-kind` is what `decideClaim` answers for an
approval request and `decideApproval` for a claim.

### A claim is about one risk, and so is its answer

"Reset the period" puts the counter of the **claimed risk** back to zero and
leaves every other risk of the mission as it is (spec §3.4; product owner's
decision of 2026-10-13, ADR
[claim-reset-is-the-claimed-risk-only](../decisions/claim-reset-is-the-claimed-risk-only.md)).
Until then it zeroed every counter of the period: answering a claim on
"read code" also reopened "merge to a protected branch" if that one was
exhausted too, without the creator being shown it. A second exhausted risk
has its own claim, and its own answer.

The quota extension keeps its cap: at most what the period consumed on the
claimed risk. With both rules, the most a creator can grant on a claim is
"this risk starts its period again" — a reset — and anything larger is a
change of the mission. The two resolutions now differ by the amount only
(all of it, or the number chosen) and by the event they leave (`reset`,
`extension`).

A `reset` event written before this rule lists every risk that had been
consumed in `credits`; the counters-vs-audit check reads both shapes.

### Credits and the counters-vs-audit check

A granted `reset-period` or quota `extension` lowers `session_counters`
without touching the audit. Its event records how many actions it gave back
per risk (`details.credits`, for the period `details.period_start`), and
`countersAgreeWithAudit` (`budget/consistency.ts`) compares
`counted + credited == audited` per risk, reading the `reset` / `extension`
events of the period (`CREDIT_EVENT_KINDS`). Each report line is
`{ risk_id, counted, credited, audited }`.

## HTTP surface

| Route                           | Handler  | Answers                                                                                                                                                                                                              |
| ------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /r/:id`                    | `open`   | see the gate above                                                                                                                                                                                                   |
| `GET /api/requests`             | `inbox`  | 200 `{ requests }` · 401 · 403 (bearer, bootstrap)                                                                                                                                                                   |
| `POST /api/requests/:id/decide` | `decide` | 200 `{ request }` · 400 not a body · 401 · 403 `origin-mismatch` / `forbidden` / `wrong-credential-kind` · 409 `request-not-open` (+ `state`) / `unsupported-kind` · 422 `<ClaimProblemCode \| ApprovalProblemCode>` |

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
  (kind — with the tool for an approval request —, mission, risk label and
  id, asked, expires). Reachable from the
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
  outcome is shown. No client component, no script. For an approval request
  the same page shows another body ([Approvals](#approvals), "The page").

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
on its mission's session, all in one transaction. For an approval request
that is the erasure "on expiry": between the expiry instant and the pass
(at most one interval) the blob is still in the row, and nothing opens it
(`getArguments` and `view()` both check the expiry). The delay is the
configuration's `requests.expiry` (`VAUBAAN_REQUEST_EXPIRY`, default `24h`),
stamped as `expires_at` by the budget when it drops the request. The flip is
idempotent, so several replicas may each run their own sweeper against a
shared store.

## What the store gained

Additive, in `store/repositories/requests.ts` and `sessions.ts`:

- `RequestsRepo.decideClaim(id, decidedByUserId, apply)` →
  `{ status: 'decided', request, outcome } | { status: 'not-open', request }`.
  `apply(ctx)` is synchronous and gets a `ClaimDecisionContext`: `request`,
  `mission` (`StoredMissionFacts { status, expiresAt }`, the mission row read
  inside the transaction; the status is the stored one, never `orphaned`),
  `session`, `now`, `counters(periodStart)`, `resetCounter(periodStart,
riskId)` (sets that one counter to zero and returns what it held; no other
  risk is touched), `creditCounter(periodStart, riskId,
amount)` (one conditional `UPDATE … WHERE consumed >= amount`; `false` and
  nothing written otherwise — a counter never goes below zero),
  `setMissionExpiry(iso)`, `recordEvent(event)`. Not a claim →
  `InvariantError`; unknown id → `NotFoundError`.
- `RequestsRepo.decideApproval(id, decidedByUserId, apply)` → the same result
  shape. `apply(ctx)` gets an `ApprovalDecisionContext`: `request`, `mission`
  (the same `StoredMissionFacts`), `session`,
  `now`, `createApproval(expiresAt)` (bound to the request's own mission,
  risk, tool and fingerprint), `riskEvents(query)`, `recordEvent(event)`. Not
  an approval request → `InvariantError`. Both primitives share one frame
  (`decideOpenSync`): open and unexpired check, `apply`, conditional update
  that erases the blob.
- `RequestsRepo.getArguments(id)` answers `null` unless the request is open
  and unexpired.
- `OpenRequestLookup.tool`: an approval request is looked up by risk, tool
  and fingerprint (both mandatory for that kind, `InvariantError` otherwise).
- `ApprovalsRepo`: the key is `ApprovalKey { riskId, tool, fingerprint }`
  (`create`; `DecideContext.findApproval` / `consumeApproval`, which run
  `findApprovalSync` / `consumeApprovalSync` inside the decision transaction);
  `getByRequest(requestId)`. Migration `0005_approval_bound_to_tool.sql` adds
  `approvals.tool` (`NOT NULL DEFAULT ''`: a row older than the migration
  matches no call) and recreates `approvals_lookup` on `(mission_id, risk_id,
tool, fingerprint)`.
- `DecideContext.riskEvents({ kinds, riskIds, since })` and the same method on
  `SessionPrimitives`: the session's events about some risks, oldest first.
- `AuditRepo.latestCall({ missionId, tool, argumentsHash, refusalCode? })`.
- `RequestsRepo.sweepExpired()` → the expired `RequestRecord[]`, one `request`
  event (`state: 'expired'`) recorded per request.
- `SessionsRepo.listEvents(sessionId, { kinds?, order?: 'asc' | 'desc', since?, limit? })`.

## Approvals

A call touching a risk gated `approval` is refused `approval-required`, whole,
and an **approval request** is dropped (spec §3.5, §7.7). The gateway executes
nothing and holds nothing: the creator answers, the executor replays.

### What is bound to what

| Thing                | Bound to                                                              | Lives                                                                   |
| -------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| the approval request | mission, risk, **tool**, fingerprint of the arguments                 | `requests.expiry` (default 24 h), then `expired`                        |
| the sealed arguments | the request id (associated data `request:<id>` of the AEAD blob)      | while the request is open; `args_blob` is `NULL` on decision or expiry  |
| the approval         | mission, risk, **tool**, fingerprint (`ApprovalKey`, migration 0005)  | `approvals.expiry` (`VAUBAAN_APPROVAL_EXPIRY`, default `10m`), one use  |
| a gate opening       | the risk and the period current at the decision (`gate-opened` event) | until that period ends, or until the gate is edited on the mission page |

The fingerprint is `fingerprintArguments(args)`, the canonical SHA-256 also
stored as the audit's `arguments_hash` (budget handbook). The tool is part of
both keys: the same arguments on another tool that touches the same risk are
another call — another request, and an approval they do not consume. That
closes the Phase 1 security finding (approvals were keyed without the tool).
A call whose arguments carry a number JSON has no text for (`1e999`, which
canonical JSON would write `null`) never opens a request: the pipeline
rejects it before any stage, so what the approver reads in the sealed copy is
what the fingerprint binds and what the plugin receives
([gateway-core](gateway-core.md), "Order of a call"; ADR
[execution-door-json-faithful-arguments-and-shared-throttle](../decisions/execution-door-json-faithful-arguments-and-shared-throttle.md)).

A call touching several risks of which one is gated is refused as a whole; the
one approval lets the whole call through, and every risk it touches is then
counted (quota and rate). A call touching **two** gated risks asks for each in
its turn (one request per gated risk, the first refusal naming the first one);
the approvals are looked up without being consumed, so the first is still
there when the second is granted, and the replay consumes both.

### The refusal (`refuse.approvalRequired`, gateway-core)

`{ code: 'approval-required', risk_id, fingerprint, approval_url, expires_at,
approval_valid_seconds, hint }`: `approval_url` is `<public_url>/r/<id>`,
`expires_at` is the request's expiry, `approval_valid_seconds` is how long a
granted approval stays usable, and the hint tells the agent to hand the URL to
its human and to replay the same tool with exactly the same arguments within
that delay. A replay before the decision gets the same request back.

### The creator's view (`ApprovalView`)

`view()` returns, for the creator only:

| Field      | Content                                                                                                                                                                                                                                                                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request`  | the summary (with `tool`)                                                                                                                                                                                                                                                                                                                                       |
| `mission`  | `{ id, name, state, expires_at }`                                                                                                                                                                                                                                                                                                                               |
| `period`   | the current period                                                                                                                                                                                                                                                                                                                                              |
| `call`     | `tool`, `fingerprint`, `arguments` (**in clear**, while the request is open; `null` + `arguments_erased: true` afterwards), `slices` (wire form, `serializeSlice`), `risks` (every risk the call touches: label, quota, consumed, remaining, and `gate` as it applies now: `effectiveGate` of `budget/gates.ts`, the function the budget decides the call with) |
| `gate`     | `{ policy, open_until }`: the risk's gate in the mission's policy (`null` when the risk left it) and the end of the period it is open for                                                                                                                                                                                                                       |
| `approval` | once granted: `{ id, expires_at, consumed_at, state: 'usable' \| 'consumed' \| 'expired' }`                                                                                                                                                                                                                                                                     |
| `events`   | the last session events                                                                                                                                                                                                                                                                                                                                         |
| `options`  | the three actions with their consequence; empty once the request is not open                                                                                                                                                                                                                                                                                    |

The slices and the touched risks come from the audit: the pipeline wrote the
entry of the refused call, and `AuditRepo.latestCall({ missionId, tool,
argumentsHash, refusalCode: 'approval-required' })` finds it by the same
fingerprint. With no entry (purged, or a request created below the pipeline)
`slices` is `null` — the page says "not recorded" — and `risks` holds the
gated risk alone.

**Who reads the arguments.** `approvalView()` is the only caller of
`RequestsRepo.getArguments`, and it runs after `own()`: the creator, nobody
else — not an operator, not a co-owner of the connection through its owner
group, not the bootstrap operator (who is not a user), not the executor (a
bearer is refused by kind on the three routes). The store adds its own guard:
`getArguments` answers `null` for a request that is not `open`, or that is
past its expiry even when the sweeper has not erased the blob yet. The
arguments are in no summary, no event, no audit entry, no log line and no
`decision_json`; the tool and the fingerprint are.

### The three resolutions (`approval.ts`)

`ApprovalDecision` is `{ resolution: 'grant' | 'open-gate' | 'refuse' }` and
nothing else (`parseApprovalDecision` refuses any other key: there is no way
to widen what is granted). `approvalOptions(situation)` returns the three,
each with a one-line `consequence` and `unavailable`;
`checkApprovalDecision` applies the same rules to a decision.

| Resolution  | Effect                                                                                                    | Refused when                                                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grant`     | one approval for the request's `(mission, risk, tool, fingerprint)`, valid `approvals.expiry`, single-use | mission revoked / orphaned (`mission-closed`), expired (`mission-expired`), risk left the policy (`risk-not-in-policy`)                                                       |
| `open-gate` | the risk reads `auto` for every call until the current period ends, this call included                    | same, plus the gate is `auto` on the mission or already open (`gate-not-closed`), or the mission has a single period that never ends (`no-period-end`: edit the gate instead) |
| `refuse`    | nothing; a replay is refused again and drops a new request                                                | never                                                                                                                                                                         |

No resolution edits `mission_policy`, and none bypasses the budget: the
replay goes through `decide()` again, quota and rate first.

### `decideApproval` — one transaction

1. `own()`; the request must be an approval request (`unsupported-kind`
   otherwise).
2. `store.requests.decideApproval(id, userId, apply)` runs in one
   `BEGIN IMMEDIATE` transaction: the request must still be open and unexpired
   (an overdue one is flipped to `expired` there, its blob erased, and the
   answer is `not-open`); `apply` reads the session's gate events and the
   mission's stored status and expiry (`ctx.mission`, as for a claim) **inside**
   the transaction, re-checks the decision (`ApprovalProblemError` rolls
   everything back and leaves the arguments sealed), writes the approval or
   the event; then the conditional `UPDATE … WHERE state = 'open'` stores the
   state and the decision **and sets `args_blob` and `key_version` to NULL**.
3. After commit: an admin audit entry (object `{ type: 'request', id }`,
   `after` with `mission_id`, `risk_id`, `tool`, `fingerprint`) and a log line.

| Resolution  | Request state | Session event                                                           | Audit act          | `decision_json`                                    |
| ----------- | ------------- | ----------------------------------------------------------------------- | ------------------ | -------------------------------------------------- |
| `grant`     | `granted`     | `approval` `{ request_id, approval_id, tool, fingerprint, expires_at }` | `approval-granted` | `{ resolution, approval_id, approval_expires_at }` |
| `open-gate` | `granted`     | `gate-opened` `{ request_id, period_start, period_end }`                | `gate-opened`      | `{ resolution, period_start, period_end }`         |
| `refuse`    | `refused`     | `request` `{ request_id, request_kind: 'approval', state: 'refused' }`  | `request-refused`  | `{ resolution }`                                   |

### The replay

`SessionService.recordCall` (budget handbook) looks the approval up by
`ApprovalKey` inside the decision transaction and consumes it only when the
whole call is allowed: `consumed_at` is set, the counters of every touched
risk gain one, the rate windows record the action, and the audit entry of the
call carries `approval_id`. The second identical call finds no approval and
is refused with a new request. An approval that expired asks again the same
way.

### The gate opened for the rest of the period

`open-gate` writes no approval. The `gate-opened` event carries the period it
was granted in; `openedGatesOf` (`budget/gates.ts`) derives, from the
session's `gate-opened` and `gate-changed` events of the period, the set
`decide()` receives as `opened_gates`. After the rollover no stored opening
matches the new period's start: the gate reads `approval` again with nothing
to run. An edit of the gate on the mission page (`gate-changed`,
[missions](missions.md) "Editing a gate") ends an opening granted before it —
on an equal timestamp the edit wins. So does `approval` asked again through
`POST /api/missions/<id>/gate` on a risk that is gated and open for the
period: the stored gate does not move, and the `gate-changed` event is
recorded all the same. Both hold on an **expired** mission, whose gates stay
editable: the edit looks for the opening in the period that runs now, whatever
the mission's state, so an `extend-expiry` granted later in that period brings
the mission back with the gate asking again, not with the opening the creator
closed ([missions](missions.md) "Editing a gate"; ADR
[one-membership-rule-checked-in-the-token-insert](../decisions/one-membership-rule-checked-in-the-token-insert.md),
D5). The request page and the mission page
show `open until <period end>` from the same derivation.

### The page

For an approval request `/requests/<id>` shows, top to bottom: _What is
asked_ (mission and its state, tool, **arguments** as pretty-printed JSON —
or "erased when the request was decided; only their fingerprint remains",
"closed" in place of "decided" for an expired request —,
fingerprint, slices touched, gated risk, gate, period end, asked, expiry or
outcome with what became of the approval), _Your decision_ (one plain
`method="post"` form per option with its consequence line), _What this call
counts against, this period_ (one row per touched risk: gate, quota,
consumed, left), _Last session events_. No client component, no script.

A form post answers 303 to `/requests/<id>?decided=1` or `?problem=<code>`.
The document the browser then loads is a fresh one: the arguments are not in
it once the request is decided.

## How to debug

- **The claim URL answers 403 to the right person** — they are not
  `missions.creator_user_id` (an owner of the connection is not enough), or
  they are signed in with the bootstrap token.
- **429 on `/r/…` for everybody** — no `trusted_proxies`: all callers share
  one key (the boot log has `trusted_proxies is empty: …` at `warn`). Set it
  to the address or CIDR of the TLS terminator.
- **`request-not-open`** — already decided, or past `expires_at`
  (`requests.state`, `decided_at`, `decision_json`). The executor's next
  refused call opens a new claim. A request whose mission was orphaned for
  longer than `requests.expiry` is in that case: it expired while only a
  refusal could be recorded ("A request on an orphaned mission still
  expires").
- **`invalid-expiry` on a date later than the one the page showed** — another
  decision extended the expiry further in the meantime: the check reads the
  stored expiry inside the transaction.
- **`invalid-amount` on a quota extension** — the amount exceeds what the
  risk consumed in the _current_ period (`session_counters`); after a
  rollover that is 0 and the option is unavailable.
- **The risk is still refused after `extend-expiry`** — by design: the expiry
  moved, the counters did not.
- **`countersAgreeWithAudit` reports a mismatch after a grant** — look for the
  `reset` / `extension` event of the period and its `details.credits`.
- **The replay is still `approval-required` after a grant** — the arguments
  differ (compare the refusal's `fingerprint` with `approvals.fingerprint`),
  the tool differs, the approval expired (`approvals.expires_at`, ten minutes
  by default) or was already consumed (`consumed_at`), or the call touches a
  second gated risk (the refusal names another `risk_id`).
- **The page shows "erased" arguments on an open-looking request** — it is
  past `expires_at`: its state reads `expired` before the sweeper's pass.
- **A gate reads `approval` but calls pass** — it is open for the period:
  `events` of kind `gate-opened` with `details.period_start` equal to the
  current period's start and no later `gate-changed` on that risk.
- **`no-period-end` on "open the gate"** — a one-off mission: set the gate to
  `auto` on the mission page.

## Tests

- Unit, beside the code: `state.test.ts` (9, with the URL builder),
  `claim.test.ts` (38), `approval.test.ts` (28: the three options, their
  rules per mission state and gate, the sentence of an orphaned mission, the
  parser, `formatDelay`),
  `client-ip.test.ts` (2: the page uses the shared client-address rule,
  itself tested in `src/server/http/client-ip.test.ts`, 11), `events.test.ts`
  (7), `sweeper.test.ts` (4). The gate openings are
  `tests/unit/server/budget/gates.test.ts` (9).
- Integration, `tests/integration/requests/`: `request-service.test.ts`
  (34, `:memory:` store with a manual clock; the mission checked as the store
  holds it at the decision: two extensions of the expiry, a mission revoked
  since it was read), `request-handlers.test.ts`
  (14, the real root; a delegated token named `delegated-token`, a bearer of
  no known shape with no `presented`), `approval.test.ts` (42, `:memory:` store with a manual
  clock: refusal → grant → identical replay → second replay refused; one byte
  or another tool asks again; single use; expiry; whole refusal; erasure read
  from the row on decision and on expiry; the gate opened and bounded to the
  period; one audit entry per decision) and `approval-access.test.ts` (29,
  the real root: an operator, a group co-owner, another user, the bootstrap
  operator and the executor get nothing of the request). One more scenario in
  `tests/integration/budget/pipeline-consistency.test.ts` (credits vs audit)
  and the `listEvents` options in `tests/integration/store/sessions.test.ts`.
- The store primitives: `tests/integration/store/approval-decisions.test.ts`
  (17) and `requests-approvals.test.ts`.
- Through the real door: `tests/integration/execution/approval-door.test.ts`
  (7: the GitHub plugin's `developer` preset as shipped, a workflow file
  write approved over `/mcp`).
- A request on an orphaned mission, on the real root:
  `tests/integration/authority/share-and-orphan.test.ts` — a claim and an
  approval request: orphaned, past `requests.expiry`, swept, `expired`, the
  sealed arguments erased, the authority back, `not-open`, and the replay
  opens a new request that is granted.
- Browser, `tests/e2e/v5/exhaust-and-claim.spec.ts` (1) and
  `approve-action.spec.ts` (1).

Scenarios in [integration-tests](../tests/integration-tests.md) and
[e2e-tests](../tests/e2e-tests.md).

## References

- Spec [vaubaan-gateway](../spec/vaubaan-gateway.md) §0, §2.3, §3.4, §3.5,
  §4.1, §4.2, §6, §7.6, §7.7, §10.
- ADRs [claim-resolutions-as-counter-credits](../decisions/claim-resolutions-as-counter-credits.md),
  [atomic-budget-accounting](../decisions/atomic-budget-accounting.md).
- Neighbours: [budget-and-sessions](budget-and-sessions.md), [store](store.md),
  [authentication](authentication.md), [missions](missions.md),
  [configuration](configuration.md), [gateway-core](gateway-core.md).
