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

There is no company-registered app for Stripe: the owner reveals the
**secret keys** in the Stripe dashboard (`https://dashboard.stripe.com/apikeys`)
and pastes them (`src/credential.ts`). The guide asks for the secret key, not
a restricted one: Stripe refuses tool by tool what a restricted key lacks,
while the gateway holds live refunds, payouts and prices behind their own
permissions and a mission reaches only the modes it names. The check at paste
(`verifyStripeKeys`) reads `GET /v1/account` with each key and names the
account with its modes; a key whose prefix contradicts its field, or a
restricted key that may not read its account, is refused with what to paste.

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

`create_payout` and `delete_customer` are both irreversible: no trust level runs them freely.

The properties a tool declares are its whole argument surface: the
classifier refuses a call carrying any other key (`expand`, an undeclared
Stripe parameter), and `execute` declines it with the same sentence. Two
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

What `execute` declines itself — an account outside the mission, a malformed
identifier, an undeclared argument, a mode the account holds no key for,
an unknown tool — is an `isError` result carrying the reason
(`ExecutorRefusal` under the SDK's `declining`), returned before any request:
nothing failed at Stripe and the audit records no upstream failure. What Stripe fails is thrown
(`UpstreamAuthError` on 401/403, `UpstreamHttpError` otherwise, and
`UpstreamProtocolError` for an answer that is not JSON or, at discovery, an
account without an id).

Reads whose answer carries customer fields — `list_invoices`,
`list_charges`, `list_payment_intents`, and `list_events` unless `type`
names a family without customer payload (`payout.*`, `balance.*`,
`product.*`, `price.*`, `plan.*`, `coupon.*`, `promotion_code.*`) — also
need `read-customer-pii`.

## Catalog

`src/risk-catalog.yaml`: 16 named risks and the
`stripe.uncategorized-write` fallback. Every risk is env-scoped on the mode
(`acceptable_in_envs: [test, live]`), so the runtime qualifies
`stripe[live].refund-create` vs `stripe[test].refund-create` from the
resource the call targets.

| Risk                            | Action | Notes                                                                      |
| ------------------------------- | ------ | -------------------------------------------------------------------------- |
| `stripe.read-catalog`           | R      | Products, prices, coupons, promotion codes.                                |
| `stripe.read-billing-history`   | R      | Customers (business payload), subscriptions, invoices, PI, charges.        |
| `stripe.read-customer-pii`      | R      | Co-emitted with every read returning customer fields (see Tools).          |
| `stripe.read-balance`           | R      | Balance, ledger, events.                                                   |
| `stripe.catalog-write`          | W      | Reversible.                                                                |
| `stripe.subscription-create`    | W      | Co-emits `payment-intent.W` (immediate proration).                         |
| `stripe.subscription-update`    | W      | Also `pause_subscription`.                                                 |
| `stripe.subscription-cancel`    | W      | Irreversible. Also `update_subscription` scheduling a cancellation.        |
| `stripe.invoice-create-draft`   | W      | Reversible.                                                                |
| `stripe.invoice-finalize`       | W      | Notifies, attempts collection. Also `create_invoice` + auto_advance.       |
| `stripe.invoice-void`           | W      | Irreversible.                                                              |
| `stripe.refund-create`          | W      | Irreversible, `cost: unbounded`; rate ceiling 30/min.                      |
| `stripe.payout-create`          | W      | Irreversible, `cost: unbounded`; rate ceiling 30/min.                      |
| `stripe.customer-delete`        | W      | Irreversible, cancels subscriptions, erases PII.                           |
| `stripe.webhook-endpoint-write` | W      | Posture shift.                                                             |
| `stripe.mint-webhook-secret`    | W      | Co-emitted with `create_webhook_endpoint`.                                 |
| `stripe.uncategorized-write`    | W      | Fallback; counts only when no dedicated entry matched. In no macro-action. |

## Macro-actions

| Macro-action | What it covers                                         | Risks                                                                                    |
| ------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `books`      | Catalog, billing history, balance and customers.       | `read-catalog`, `read-billing-history`, `read-balance`, `read-customer-pii`              |
| `set-up`     | Catalog and webhooks.                                  | `catalog-write`, `webhook-endpoint-write`, `mint-webhook-secret`                         |
| `bill`       | Subscriptions and invoices.                            | `subscription-create`, `subscription-update`, `invoice-create-draft`, `invoice-finalize` |
| `money-out`  | Refunds and payouts.                                   | `refund-create`, `payout-create`                                                         |
| `cancel`     | Cancel subscriptions, void invoices, delete customers. | `subscription-cancel`, `invoice-void`, `customer-delete`                                 |

A creator ticks macro-actions at a trust level (Careful / Trusting / Autonomous,
risk model §4.6); the trust level turns each risk's vector into a gate and scales its
base budget. The persisted policy is the explicit list. Each line is qualified with the mode of the
selected resource (`stripe[live].refund-create`). Money-out and cancel are
left out at Careful and ask first above. The fallback sits in "Anything
else": the engine counts it only when no dedicated entry matched a write.

## Tests

`npx vitest run plugins/stripe` — 220 tests: the SDK kit
(`assertPluginWellFormed`, `assertCatalogCoverage`, `assertNoWildcard`,
macro-action missions through `policyFromMacroActions`), the classifier's tool-by-tool security suite
(`classify.test.ts`), the decision path through the real catalog and the
engine — stronger risk on `cancel_at*` / `auto_advance`, PII overlay, mode
resolution, each mission on test and live (`policy.test.ts`), the request
shapes sent to Stripe (`execute.test.ts`), `execute` and `discoverResources`
against `mockFetch`, the credential spec and macro-actions, catalog
invariants, and hostile identifiers fed to `classify` and `execute`
(`identifiers.test.ts`). No test ever calls Stripe.
