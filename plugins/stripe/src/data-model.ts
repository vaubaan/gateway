/**
 * Data model of the `stripe` provider — the `billing` plane.
 *
 * Spec : docs/spec/gateway-risk-model.md §2.
 *
 * One plane : Stripe Connect / Terminal / Identity / Issuing are out of
 * scope. The distinctive feature is the **`mode` (test/live) layer** marked
 * `envScopable` : a Stripe API key speaks to exactly one mode, the two
 * namespaces are disjoint upstream (`cus_*`, `prod_*`, `ch_*` never cross),
 * and the connection exposes one resource per mode (`acct_123/test`,
 * `acct_123/live`) whose `env` is that mode. The runtime qualifies
 * env-scoped risks as `stripe[live].refund-create` vs `stripe[test].refund-create`.
 *
 * Two synthetic entities encode features Stripe does not expose as
 * queryable resources but the catalog gates distinctly :
 *
 *   - `webhook-endpoint.secret` : the `whsec_*` signing secret returned only
 *     at endpoint creation (rotation = delete + recreate) ;
 *   - `customer.pii` : an overlay on the customer carrying the GDPR/CCPA
 *     fields (email, name, address, phone, shipping). The same REST call
 *     returns both payloads ; the classifier emits two slices so identity
 *     reads are accepted distinctly from anonymised business stats.
 *
 * Verb leaves (`cancel`, `finalize`, `void`, `delete`) are not entities :
 * they are name segments the classifier appends so the catalog can tell an
 * irreversible verb from an update on the same entity.
 */

import type { DataModel } from '@vaubaan/plugin-sdk';

export const stripeDataModel: DataModel = {
  provider: 'stripe',
  planes: [
    {
      slug: 'billing',
      description:
        'The only Stripe plane Vaubaan exposes — the authenticated Stripe ' +
        'account (one API key = one account) and all the billing artifacts under it ' +
        '(catalog, customers, subscriptions, invoices, payments, monitoring, webhook ' +
        'integration). Stripe Connect / Terminal / Identity / Issuing are out of scope.',
      entities: [
        {
          name: 'account',
          parent: null,
          cardinalities: ['one'],
          description:
            'The Stripe merchant account. The ref of a resource is `<account id>/<mode>` ; ' +
            'a connection holds one account and up to two modes.',
        },
        {
          name: 'mode',
          parent: 'account',
          cardinalities: ['bounded'],
          envScopable: true,
          description:
            'Test / live namespace, bounded pair. One resource per mode, pinned by the ' +
            'key prefix (`sk_test_*` / `sk_live_*`). Cardinal envScopable axis : Stripe ids ' +
            '(cus_*, prod_*, ch_*) are disjoint between modes ; no cross-mode addressing is ' +
            'possible upstream. The runtime qualifies env-scoped risks as ' +
            '`stripe[live].refund-create` etc.',
        },
        // ─── Catalog cluster ──────────────────────────────────────────────────
        {
          name: 'product',
          parent: 'mode',
          cardinalities: ['unbounded'],
          description:
            'A sellable item in the merchant catalog. Unbounded — multi-tenant SaaS may ' +
            'expose thousands of SKUs.',
        },
        {
          name: 'price',
          parent: 'product',
          cardinalities: ['bounded'],
          description:
            'A price point attached to a product (monthly/yearly/tiered). Bounded per ' +
            'product — typically a few prices each.',
        },
        {
          name: 'coupon',
          parent: 'mode',
          cardinalities: ['bounded'],
          description:
            'An amount-off / percent-off discount template. Bounded — dozens at most ' +
            'per account in practice.',
        },
        {
          name: 'promotion-code',
          parent: 'coupon',
          cardinalities: ['bounded'],
          description:
            'A customer-facing redemption code attached to a coupon. Bounded per coupon.',
        },
        // ─── Customer cluster ─────────────────────────────────────────────────
        {
          name: 'customer',
          parent: 'mode',
          cardinalities: ['unbounded'],
          description:
            'The billing identity of an end-user. Unbounded — a SaaS customer base can ' +
            'grow to millions. Carries business fields (currency, balance, default ' +
            'payment method, metadata) AT THIS LEVEL ; PII fields are split into the ' +
            '`pii` synthetic overlay .',
        },
        {
          name: 'pii',
          parent: 'customer',
          cardinalities: ['one'],
          description:
            'Synthetic overlay on customer carrying the GDPR/CCPA-sensitive fields ' +
            '(email, name, address, phone, shipping). The same REST call returns both ' +
            'the customer business payload AND this PII payload ; the classifier emits ' +
            'two slices so the operator can gate identity reads distinctly from ' +
            'anonymised business stats . NOT a real Stripe resource ' +
            '— marker for slice-matching.',
        },
        {
          name: 'payment-method',
          parent: 'customer',
          cardinalities: ['bounded'],
          description:
            'A card / SEPA / bank-account / wallet payment method attached to a ' +
            'customer. Bounded per customer (a handful at most).',
        },
        // ─── Subscriptions cluster ────────────────────────────────────────────
        {
          name: 'subscription',
          parent: 'customer',
          cardinalities: ['bounded'],
          description:
            'A recurring billing engagement between a customer and one or more prices. ' +
            'Bounded per customer (most have 1 active sub).',
        },
        {
          name: 'subscription-item',
          parent: 'subscription',
          cardinalities: ['bounded'],
          description:
            'A (price, quantity) tuple inside a subscription. Bounded per sub — usually ' +
            '1, sometimes a few for multi-line plans.',
        },
        // ─── Invoices cluster ─────────────────────────────────────────────────
        {
          name: 'invoice',
          parent: 'customer',
          cardinalities: ['unbounded'],
          description:
            'A billing document (draft/open/paid/uncollectible/void). Unbounded history ' +
            '— recurring SaaS produces one per period per sub for years.',
        },
        {
          name: 'invoice-item',
          parent: 'invoice',
          cardinalities: ['bounded'],
          description:
            'A line item attached to an invoice (typically a (price, quantity) row plus ' +
            'optional one-shot proration entries). Bounded per invoice.',
        },
        // ─── Payments cluster (chained PI → charge → refund) ──────────────────
        {
          name: 'payment-intent',
          parent: 'mode',
          cardinalities: ['unbounded'],
          description:
            'A payment intention (requires_action / processing / succeeded / canceled). ' +
            'Unbounded history of attempted payments. Stripe-cardinal entity — every ' +
            'money movement starts as a payment-intent.',
        },
        {
          name: 'charge',
          parent: 'payment-intent',
          cardinalities: ['bounded'],
          description:
            'An actual money-movement attempt against a payment-intent. Bounded per PI ' +
            '(typically 1 ; retries produce multiple).',
        },
        {
          name: 'refund',
          parent: 'charge',
          cardinalities: ['bounded'],
          description:
            'A reversal of a charge (full or partial). Bounded per charge (a handful at ' +
            'most). Cardinal cost-unbounded irreversible action of the provider — the ' +
            'classifier emits a long containment path so a future cap on "refund per ' +
            'charge of amount ≥ X" stays expressible.',
        },
        {
          name: 'payout',
          parent: 'mode',
          cardinalities: ['unbounded'],
          description:
            'A transfer from the Stripe balance to the merchant bank account or card. ' +
            'Unbounded history. Real money out in live mode ; cancellable only while pending.',
        },
        // ─── Monitoring cluster ───────────────────────────────────────────────
        {
          name: 'balance',
          parent: 'mode',
          cardinalities: ['one'],
          description:
            'Singleton snapshot of the merchant cash position (available + pending). ' +
            'Read-only — Stripe computes from the balance-transactions ledger.',
        },
        {
          name: 'balance-transaction',
          parent: 'mode',
          cardinalities: ['unbounded'],
          description:
            'Append-only ledger entry — every charge, refund, payout, application fee ' +
            'produces one. Unbounded history.',
        },
        {
          name: 'event',
          parent: 'mode',
          cardinalities: ['unbounded'],
          description:
            'Append-only audit feed mirroring every state change in the account. Stripe ' +
            'retains 30 days by default. Unbounded over time.',
        },
        // ─── Webhook integration ──────────────────────────────────────────────
        {
          name: 'webhook-endpoint',
          parent: 'mode',
          cardinalities: ['bounded'],
          description:
            'A registered HTTPS URL Stripe POSTs events to. Bounded — dozens max per ' +
            'account. Posture-shift surface : a misconfigured endpoint routes events to ' +
            'an attacker (data exfil) or leaks customer data in payloads.',
        },
        {
          name: 'secret',
          parent: 'webhook-endpoint',
          cardinalities: ['one'],
          description:
            'Synthetic singleton overlay on a webhook endpoint carrying the `whsec_*` ' +
            'signing secret. The secret is returned ONLY at endpoint creation ' +
            ' ; rotation = delete + recreate. NOT a queryable Stripe ' +
            'resource — marker so the catalog can gate the credential mint distinctly ' +
            'from the endpoint config update (aligns with vercel.bypass-token).',
        },
      ],
    },
  ],
};
