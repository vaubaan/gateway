---
title: Stripe provider — modelling and runtime (v5 plugin)
status: current
date: 2026-10-13
last_synced: 2026-10-13
tracks:
  - plugins/stripe/src/index.ts
  - plugins/stripe/src/resources.ts
  - plugins/stripe/src/classify.ts
  - plugins/stripe/src/execute.ts
  - plugins/stripe/src/tools.ts
  - plugins/stripe/src/data-model.ts
  - plugins/stripe/src/risk-catalog.yaml
  - plugins/stripe/tests/unit/
---

# Stripe provider — modelling and runtime

`@vaubaan/plugin-stripe` on the v5 Plugin SDK (feature P1.2e). Contract :
ADR [[plugin-contract-and-credential-spec]] ; spec
[`vaubaan-gateway.md`](../../spec/vaubaan-gateway.md) §3.2, §5 and
[`gateway-risk-model.md`](../../spec/gateway-risk-model.md) §2, §4, §7.
Contributor-facing details (fields, tools list, preset table) :
[`plugins/stripe/README.md`](../../../plugins/stripe/README.md).

## What changed from v4

| v4                                                                              | v5                                                                                            |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| One raw key per project in `stripe_bindings`, self-contained path in `build.ts` | One `api-key` credential with two optional secrets (`test_key`, `live_key`), run by the host  |
| `ProviderBinding` with `environment: 'test' \| 'live'`                          | One `Resource` per mode : `acct_1/test`, `acct_1/live`, `env` = mode                          |
| `classifyStripeV4(tool, args, bindings)`                                        | `classifyStripe(tool, args, resources)` ; optional `account` argument names the resource      |
| `risk-catalog.ts` twin + sync test                                              | YAML loaded by `loadCatalogFile` at boot ; twin and sync test deleted                         |
| No `acceptable_in_envs` → `stripe[live].*` never resolved                       | Every risk env-scoped on `[test, live]` ; presets reference `stripe[live].refund-create` etc. |
| 25 tools                                                                        | 27 : `create_payout` and `delete_customer` added, each behind its own irreversible risk       |
| No presets                                                                      | `read-only`, `test-mode-developer`, `finance-operator`                                        |

The v4 surface (the adapter, the binding-based classifier wrapper, the
25-tool list and the deprecated aliases of `index.ts`) is deleted ; the
plugin exports only the v5 surface below. The v4 classifier and dispatcher
suites were ported to `classifyStripe` and `stripePlugin.execute`
(`tests/unit/classify.test.ts`, `tests/unit/execute.test.ts`).

## Layout

```
plugins/stripe/src/
  resources.ts        STRIPE_MODES, stripeResourceRef, modeOf, resolveStripeResource, keyMatchesMode
  tools.ts            27 McpToolDeclaration (+ `account` arg), declaredArgsOf
  classify.ts         classifyStripe — pure, (tool, args, resources) → slices | denied
  execute.ts          executeStripe, discoverStripeResources, STRIPE_API_BASE
  data-model.ts       plane `billing`, 22 entities, `mode` envScopable
  risk-catalog.yaml   16 risks + fallback, 3 presets, catalog_version 4
  index.ts            definePlugin(...) → stripePlugin (default export)
```

## Resources and the mode

```mermaid
flowchart LR
  cred["api-key credential<br/>test_key? live_key?"] -->|GET /v1/account per key| disc["discoverResources"]
  disc --> t["Resource acct_1/test<br/>env: test"]
  disc --> l["Resource acct_1/live<br/>env: live"]
  t & l --> mission["mission selects one or both"]
  mission -->|"args.account or single resource"| cls["classifyStripe"]
  cls -->|"mode unreadable, or label ≠ mode"| refused["denied"]
  cls --> slice["stripe.account[acct_1/live].mode[live].…"]
  slice -->|"resourceEnvResolver: first ident = ref"| env["env = live → stripe[live].refund-create"]
  mission --> exe["executeStripe"]
  exe -->|"modeOf(resource) → live_key"| api["api.stripe.com/v1"]
```

- `modeOf(resource)` reads, in order : the ref suffix (`/test`, `/live`),
  then `metadata.mode` — both written by discovery from the key itself. The
  `env` label is never a source of the mode. The classifier and `execute`
  both refuse a resource whose mode cannot be determined
  (`account: cannot determine the test/live mode of '<ref>'`).
- **The label must equal the mode.** Every Stripe risk is env-scoped on
  `[test, live]` and the engine qualifies it from the resource's `env`
  label, while `execute` picks the key from the mode. The classifier
  refuses a resource whose label is not its mode (absent, `production`, or
  the other mode), so a live call can never be judged as
  `stripe[test].refund-create`. The plugin declares no `envOf` hook : the
  label discovery wrote is the environment, and this check keeps it honest.
  Should a slice reach the engine on an unlabelled resource anyway, the
  engine refuses it (an env-scoped risk touched outside its
  `acceptable_in_envs` refuses the call — `policy.test.ts` pins both
  layers).
- `resolveStripeResource` : explicit `account` ref must be one of the
  mission's Stripe resources ; absent, the mission's single Stripe resource
  ; otherwise `denied` (ambiguous, none, unknown, malformed).
- The host keeps a plugin-set label read-only. If the label of a Stripe
  resource were changed anyway, the key `execute` uses would not move and
  every call on that resource would be refused. The mode is a fact of the
  key, not an owner's label.

## Classifier conventions

All slices are rooted at `account[<ref>].mode[<mode>]`. Identifiers from the
arguments must match `SAFE_IDENT` (`[a-zA-Z0-9_./~-]+`) and not be made of
dots only (`.` and `..` would collapse the URL path onto another endpoint) ;
a malformed one is `denied`, an absent optional one is the glob `*`.

**Only declared arguments.** The properties of a tool's `inputSchema` are
its whole argument surface (`declaredArgsOf` in `tools.ts`). The classifier
refuses a call carrying any other key
(`expand: not an argument of 'stripe__list_invoices' — nothing classifies it`)
and `execute` forwards the declared ones only, so a Stripe parameter nobody
classified — `expand`, `collection_method`, an undeclared filter — neither
passes nor is silently dropped. Declaring a new property means deciding, in
`classify.ts`, what it costs.

| Tool                                  | Slice(s)                                                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `list_customers`, `retrieve_customer` | `customer[C].R` **and** `customer[C].pii.R`                                                                     |
| `list_invoices`                       | `customer[C\|*].invoice[*].R` **and** `customer[C\|*].pii.R`                                                    |
| `list_charges`                        | `payment-intent[PI\|*].charge[*].R` **and** `customer[C\|*].pii.R`                                              |
| `list_payment_intents`                | `payment-intent[*].R` **and** `customer[C\|*].pii.R`                                                            |
| `list_subscriptions`                  | `customer[C\|*].subscription[*].R` (a subscription names its customer by id only)                               |
| `list_events`                         | `event[*].R`, `balance-transaction[*].R` **and** `customer[*].pii.R` unless `type` is a family without customer |
| `create_subscription`                 | `customer[C].subscription.W` **and** `payment-intent.W`                                                         |
| `update_subscription`                 | `customer[*].subscription[S].W` ; with `cancel_at_period_end` or `cancel_at` set, **also** `….cancel.W`         |
| `pause_subscription`                  | `customer[*].subscription[S].W` (same risk as update ; declares no cancellation field)                          |
| `cancel_subscription`                 | `customer[*].subscription[S].cancel.W`                                                                          |
| `create_invoice`                      | `customer[C].invoice.W` ; with `auto_advance` set, **also** `customer[C].invoice[*].finalize.W`                 |
| `finalize_invoice` / `void_invoice`   | `customer[*].invoice[I].finalize.W` / `….void.W`                                                                |
| `create_refund`                       | `payment-intent[PI\|*].charge[CH\|*].refund.W`                                                                  |
| `create_payout`                       | `payout.W`                                                                                                      |
| `delete_customer`                     | `customer[C].delete.W` (`id` required)                                                                          |
| `create_webhook_endpoint`             | `webhook-endpoint.W` **and** `webhook-endpoint[*].secret.W`                                                     |

The other tools map one-to-one on their entity (see `classify.ts`).

**Customer PII overlay.** `read-billing-history` is meant to be acceptable
without identities, so every read whose answer carries customer fields also
emits `customer[C].pii.R` : invoices (`customer_email`, `customer_name`,
`customer_address`), charges (`billing_details`, `receipt_email`), payment
intents (`receipt_email`, `shipping`) and events, which embed the whole
object they are about. `list_events` drops the overlay only when `type` is a
string naming a family without customer payload (`balance.`, `payout.`,
`product.`, `price.`, `plan.`, `coupon.`, `promotion_code.`) ; any other
value, a wildcard or no filter keeps it. The answer of a write (an invoice
returned by `create_invoice`) is not modelled as a read.

**Arguments that change the nature of a call.** "Absent or an explicit no"
is the only reading that does not add the stronger slice :
`cancel_at_period_end` other than `false`, or a non-empty `cancel_at`, makes
`update_subscription` a cancellation ; `auto_advance` other than `false`
makes `create_invoice` a finalization (Stripe finalizes and collects on its
own). `execute` sends `auto_advance=false` when the call does not set it, so
a draft is a draft whatever default the account's API version applies.

A slice may touch more than the entry named after it : a trailing `[**]`
matches zero identifiers and deeper paths alike, so `subscription.W`
(creation) touches `subscription-create` **and** `subscription-update`,
`subscription[S].cancel.W` touches `subscription-update` **and**
`subscription-cancel`, `customer[C].pii.R` touches `read-billing-history`
**and** `read-customer-pii`, and `webhook-endpoint[*].secret.W` touches
`webhook-endpoint-write` **and** `mint-webhook-secret`
(`risk-catalog.test.ts` pins the exact sets).

## Catalog and presets

16 named risks + `stripe.uncategorized-write`, all with
`acceptable_in_envs: [test, live]` (the fallback too, so a test-mode preset
never accepts a live write). `refund-create` and `payout-create` (the two
money-out actions) carry the rate ceiling `infra_limits.calls_per_minute_max: 30`, the one
catalog limit the gateway enforces; no entry declares `caps` (the door has no cap stage,
see [the ADR](../../decisions/scope-caps-not-enforced-in-v5-0.md)): a mission bounds them
with its quota and rate limit. `subscription-create`
matches both slices of `create_subscription` (`customer[C].subscription.W`
and the bare `payment-intent.W` of the immediate charge) since catalog v3 :
the second used to reach only the fallback. The fallback pattern
`stripe.[**].W` (`fallback: true`) counts only when no dedicated entry
matched a write (ADR [[fallback-risk-only-when-uncategorized]]) : no preset
includes it (P1.2-align removed `stripe[<mode>].uncategorized-write` from
`test-mode-developer` and `finance-operator`), and its appearance in an audit
log means a catalog entry is missing.

Presets : `read-only` (no PII : catalog, subscriptions, balance and the
events of a family without customer payload — no customer, invoice, charge
or payment-intent read, since their answers carry customer fields),
`test-mode-developer` (everything on `[test]`, `auto`), `finance-operator`
(`[live]` ; `approval` on refund, payout, customer deletion, subscription
cancel, invoice void ; no catalog or webhook write). Values are a starting
point — ADR `mission-presets-default-values` is deferred.

`policy.test.ts` runs every tool through the classifier, the YAML catalog
and the engine's `evaluateCall` for each preset : what the preset describes
is allowed on the mode it names and refused on the other, and no allowed
call touches the fallback.

## Execute

Stripe takes form-urlencoded bodies with bracket notation
(`items[0][price]=…`) and query parameters on GET ; `ROUTES` in
`execute.ts` maps each tool to method + path, with the id in the path and
removed from the body. 401/403 → `UpstreamAuthError`. Only the arguments
the tool declares are forwarded ; `account` is consumed by the gateway.
A path id that is missing, not a string or made of dots throws before any
request. Unknown tool → `isError` result. Discovery refuses a
`GET /v1/account` answer without an account id.

## How to debug

- **`account: argument missing and the mission touches 2 Stripe resources — name one`**
  — the mission holds test and live ; the agent must pass `account`.
- **`this connection has no live-mode key`** — the mission selected the live
  resource of a connection whose credential has only `test_key` ; that
  resource should not exist (discovery creates one per key) : re-run
  discovery.
- **`stripe: test_key must be a test-mode key (sk_test_… or rk_test_…)`** — the owner pasted a live key in
  the test field.
- **`<arg>: not an argument of '<tool>' — nothing classifies it`** — the
  agent passed a Stripe parameter the tool does not declare (`expand`, an
  extra filter). Declare it in `tools.ts` and classify it, or drop it.
- **`account: '<ref>' is a live-mode resource but its environment label is not 'live'`**
  — the stored label of the resource no longer matches the mode of its key ;
  re-run discovery on the connection.
- **`list_invoices` refused with `stripe[live].read-customer-pii` missing**
  — invoices, charges, payment intents and unfiltered events carry customer
  fields ; the mission needs the PII risk, which `read-only` leaves out.
- **A write is refused with `stripe[test].uncategorized-write` missing** —
  the tool classifies to a slice no dedicated entry covers : add the catalog
  entry (the fallback is never part of a preset).

## Tests

`npx vitest run plugins/stripe` — 160 : `plugin.test.ts` (31 : kit,
resource resolution, execute, discovery, credential, presets),
`classify.test.ts` (48 : the security suite of `classifyStripe`),
`policy.test.ts` (30 : classifier + catalog + `evaluateCall` — stronger
risk on `cancel_at*` / `auto_advance`, PII overlay, mode resolution, the
three presets on test and live), `execute.test.ts` (23 : REST routing,
form-encoding and declared-only forwarding through `stripePlugin.execute`),
`risk-catalog.test.ts` (20 : invariants, catalog v3, exact risk sets, no
preset on the fallback), `data-model.test.ts` (8).
