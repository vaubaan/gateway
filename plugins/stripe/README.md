# `@vaubaan/plugin-stripe`

Stripe billing operations for a SaaS operator, as a Vaubaan Gateway provider
plugin on the v5 SDK (`@vaubaan/plugin-sdk`). Catalog, customers,
subscriptions, invoices, refunds, payouts and webhooks over the Stripe REST
API v1 — with the **test and live modes as two separate resources**, so a
mission can touch the sandbox freely and the live account under budget and
approval.

Contract: [`plugin-contract-and-credential-spec`](../../docs/decisions/plugin-contract-and-credential-spec.md).
Modelling handbook: [`docs/handbook/providers/stripe.md`](../../docs/handbook/providers/stripe.md).
Contributor guide: [`plugins/README.md`](../README.md).

## Data model

One plane, `billing`, rooted at `account` → `mode`:

```
account[<ref>].mode[test|live]
  ├─ product[*] ─ price[*]
  ├─ coupon[*] ─ promotion-code[*]
  ├─ customer[*] ─ pii (synthetic) · payment-method[*] · subscription[*] ─ subscription-item[*] · invoice[*] ─ invoice-item[*]
  ├─ payment-intent[*] ─ charge[*] ─ refund[*]
  ├─ payout[*]
  ├─ balance · balance-transaction[*] · event[*]
  └─ webhook-endpoint[*] ─ secret (synthetic)
```

`mode` is the `envScopable` entity: a Stripe API key is pinned to one mode
and the two namespaces are disjoint upstream. Two synthetic entities exist
for classification only: `customer.pii` (the GDPR fields returned with
every customer read) and `webhook-endpoint.secret` (the `whsec_*` returned
once at creation). Verb leaves (`cancel`, `finalize`, `void`, `delete`) let
the catalog tell an irreversible verb from an update of the same entity.

## Credential and resources

Kind `api-key`, two optional secret fields; at least one must be filled:

| Field      | Pattern                        | Purpose                                |
| ---------- | ------------------------------ | -------------------------------------- |
| `test_key` | `^(sk\|rk)_test_[A-Za-z0-9]+$` | Sandbox key (`sk_test_…`, `rk_test_…`) |
| `live_key` | `^(sk\|rk)_live_[A-Za-z0-9]+$` | Live key (`sk_live_…`, `rk_live_…`)    |

There is no company-registered app for Stripe: the owner creates the keys
in the Stripe dashboard (`https://dashboard.stripe.com/apikeys`) and pastes
them. A restricted key (`rk_…`) limited to the objects the agent should
touch is preferable to the full secret key.

`discoverResources` calls `GET /v1/account` once per key present and
returns **one resource per mode**:

```ts
{ provider: 'stripe', ref: 'acct_1A2B/live', env: 'live', displayName: 'Acme (live)',
  metadata: { account_id: 'acct_1A2B', mode: 'live' } }
```

The mode is in the ref, in `metadata.mode` and in `env`. `execute` picks the
key from the ref / metadata, never from the env label, so relabelling the
environment cannot switch keys — and the classifier refuses a resource whose
label is not its mode, or whose mode cannot be read, so a live call is never
judged under a `stripe[test].*` risk. A key pasted in the wrong field
(`sk_live_…` as `test_key`) is refused before any call; a credential with
no key at all fails discovery.

## Tools

27 tools named `stripe__<verb>_<noun>`, each accepting an optional
`account` argument — the ref of the Stripe resource the call targets. It is
optional when the mission touches a single Stripe resource; with two (test
and live) the classifier refuses a call that does not name one. The
argument is consumed by the gateway and never forwarded to Stripe.

Reads (10): `list_products`, `list_prices`, `list_customers`,
`retrieve_customer`, `list_subscriptions`, `list_invoices`, `list_charges`,
`list_payment_intents`, `get_balance`, `list_events`.

Writes (17): `create_product`, `update_product`, `create_price`,
`update_price`, `create_coupon`, `create_promotion_code`,
`create_subscription`, `update_subscription`, `cancel_subscription`,
`pause_subscription`, `create_invoice`, `finalize_invoice`, `void_invoice`,
`create_refund`, `create_payout`, `delete_customer`,
`create_webhook_endpoint`.

`create_payout` and `delete_customer` are both irreversible and gated `approval` on live in the shipped preset.

The properties a tool declares are its whole argument surface: the
classifier refuses a call carrying any other key (`expand`, an undeclared
Stripe parameter) and `execute` forwards the declared ones only. Two
declared arguments change what a call costs:

- `update_subscription` with `cancel_at_period_end` or `cancel_at` set also
  needs `subscription-cancel`;
- `create_invoice` with `auto_advance` set also needs `invoice-finalize`
  (without it, `execute` sends `auto_advance=false`).

Identifier arguments (`id`, `product`, `customer`, `coupon`, `charge`,
`payment_intent`) go through one grammar, `stripeId` in `src/resources.ts`:
`^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$` — the ids Stripe issues and the custom
ids of products and coupons. `id` is a segment of the request path, the
others travel in the query string or the form body; `.`, `..`, a `/`, a
percent-escape or any other character is refused by `classify` and by
`execute` (`readIdArgs`, the same function), never escaped. `account` is
`<account id>` or `<account id>/<mode>` (`stripeAccountRef`) and never
reaches the request.

Reads whose answer carries customer fields — `list_invoices`,
`list_charges`, `list_payment_intents`, and `list_events` unless `type`
names a family without customer payload (`payout.*`, `balance.*`,
`product.*`, `price.*`, `plan.*`, `coupon.*`, `promotion_code.*`) — also
need `read-customer-pii`.

## Catalog

`src/risk-catalog.yaml`, version 3: 16 named risks and the
`stripe.uncategorized-write` fallback. Every risk is env-scoped on the mode
(`acceptable_in_envs: [test, live]`), so the runtime qualifies
`stripe[live].refund-create` vs `stripe[test].refund-create` from the
resource the call targets.

| Risk                            | Action | Notes                                                                |
| ------------------------------- | ------ | -------------------------------------------------------------------- |
| `stripe.read-catalog`           | R      | Products, prices, coupons, promotion codes.                          |
| `stripe.read-billing-history`   | R      | Customers (business payload), subscriptions, invoices, PI, charges.  |
| `stripe.read-customer-pii`      | R      | Co-emitted with every read returning customer fields (see Tools).    |
| `stripe.read-balance`           | R      | Balance, ledger, events.                                             |
| `stripe.catalog-write`          | W      | Reversible.                                                          |
| `stripe.subscription-create`    | W      | Co-emits `payment-intent.W` (immediate proration).                   |
| `stripe.subscription-update`    | W      | Also `pause_subscription`.                                           |
| `stripe.subscription-cancel`    | W      | Irreversible. Also `update_subscription` scheduling a cancellation.  |
| `stripe.invoice-create-draft`   | W      | Reversible.                                                          |
| `stripe.invoice-finalize`       | W      | Notifies, attempts collection. Also `create_invoice` + auto_advance. |
| `stripe.invoice-void`           | W      | Irreversible.                                                        |
| `stripe.refund-create`          | W      | Irreversible, `cost: unbounded`; rate ceiling 30/min.                |
| `stripe.payout-create`          | W      | Irreversible, `cost: unbounded`; rate ceiling 30/min.                |
| `stripe.customer-delete`        | W      | Irreversible, cancels subscriptions, erases PII.                     |
| `stripe.webhook-endpoint-write` | W      | Posture shift.                                                       |
| `stripe.mint-webhook-secret`    | W      | Co-emitted with `create_webhook_endpoint`.                           |
| `stripe.uncategorized-write`    | W      | Fallback; counts only when no dedicated entry matched. In no preset. |

## Presets

| Preset                | Scope                                                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read-only`           | Catalog, subscriptions, balance and customer-free events of the selected mode. No PII (so no customer, invoice, charge or payment-intent read), no write. |
| `test-mode-developer` | Every risk qualified `stripe[test].*`, generous quotas, all `auto`. Nothing on live.                                                                      |
| `finance-operator`    | Live reads including PII, subscriptions and invoices `auto`; refund, payout, customer deletion, cancel, void `approval`.                                  |

Presets are UI sugar: the persisted policy is the explicit enumeration.
No preset carries the fallback: the engine counts it only when no dedicated
entry matched a write.

## Tests

`npx vitest run plugins/stripe` — 160 tests: the SDK kit
(`assertPluginWellFormed`, `assertCatalogCoverage`, `assertNoWildcard`,
`assertPresetsValid`), the classifier's tool-by-tool security suite
(`classify.test.ts`), the decision path through the real catalog and the
engine — stronger risk on `cancel_at*` / `auto_advance`, PII overlay, mode
resolution, each preset on test and live (`policy.test.ts`), the request
shapes sent to Stripe (`execute.test.ts`), `execute` and `discoverResources`
against `mockFetch`, the credential spec and presets, and catalog
invariants. No test ever calls Stripe.
