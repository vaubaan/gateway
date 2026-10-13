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
environment in the UI cannot switch keys. A key pasted in the wrong field
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

## Catalog

`src/risk-catalog.yaml`, version 2: 16 named risks and the
`stripe.uncategorized-write` fallback. Every risk is env-scoped on the mode
(`acceptable_in_envs: [test, live]`), so the runtime qualifies
`stripe[live].refund-create` vs `stripe[test].refund-create` from the
resource the call targets.

| Risk                            | Action | Notes                                                               |
| ------------------------------- | ------ | ------------------------------------------------------------------- |
| `stripe.read-catalog`           | R      | Products, prices, coupons, promotion codes.                         |
| `stripe.read-billing-history`   | R      | Customers (business payload), subscriptions, invoices, PI, charges. |
| `stripe.read-customer-pii`      | R      | Co-emitted with every customer read.                                |
| `stripe.read-balance`           | R      | Balance, ledger, events.                                            |
| `stripe.catalog-write`          | W      | Reversible.                                                         |
| `stripe.subscription-create`    | W      | Co-emits `payment-intent.W` (immediate proration).                  |
| `stripe.subscription-update`    | W      | Also `pause_subscription`.                                          |
| `stripe.subscription-cancel`    | W      | Irreversible.                                                       |
| `stripe.invoice-create-draft`   | W      | Reversible.                                                         |
| `stripe.invoice-finalize`       | W      | Notifies the customer, attempts collection.                         |
| `stripe.invoice-void`           | W      | Irreversible.                                                       |
| `stripe.refund-create`          | W      | Irreversible, `cost: unbounded`; caps 1/call, 3/min, 20/session.    |
| `stripe.payout-create`          | W      | Irreversible, `cost: unbounded`; caps 1/call, 2/min, 5/session.     |
| `stripe.customer-delete`        | W      | Irreversible, cancels subscriptions, erases PII.                    |
| `stripe.webhook-endpoint-write` | W      | Posture shift.                                                      |
| `stripe.mint-webhook-secret`    | W      | Co-emitted with `create_webhook_endpoint`.                          |
| `stripe.uncategorized-write`    | W      | Fallback; matches every write and is never dropped by the engine.   |

## Presets

| Preset                | Scope                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `read-only`           | Catalog, billing history, balance of the selected mode. No PII (so no customer reads), no write.                         |
| `test-mode-developer` | Every risk qualified `stripe[test].*`, generous quotas, all `auto`. Nothing on live.                                     |
| `finance-operator`    | Live reads including PII, subscriptions and invoices `auto`; refund, payout, customer deletion, cancel, void `approval`. |

Presets are UI sugar: the persisted policy is the explicit enumeration.
Because the engine keeps the fallback in `risks_touched` for every write,
the two write presets also carry `stripe[<mode>].uncategorized-write`.

## Tests

`npx vitest run plugins/stripe` — 110 tests: the SDK kit
(`assertPluginWellFormed`, `assertCatalogCoverage`, `assertNoWildcard`,
`assertPresetsValid`), the classifier's tool-by-tool security suite
(`classify.test.ts`), the request shapes sent to Stripe (`execute.test.ts`),
`execute` and `discoverResources` against `mockFetch`, the credential spec
and presets, and catalog invariants. No test ever calls Stripe.
