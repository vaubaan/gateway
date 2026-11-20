# `@vaubaan/plugin-stripe`

Stripe billing operations for a SaaS operator, as a Vaubaan Gateway plugin. Catalog, customers,
subscriptions, invoices, refunds, payouts and webhooks over the Stripe REST API v1 — with the **test
and live modes as two separate resources**, so a mission can touch the sandbox freely and the live
account under budget and approval.

- **What it lets an agent do, permission by permission**: its page,
  [vaubaan.com/plugins/stripe](https://vaubaan.com/plugins/stripe) — the data model, every
  permission and its five facts, the macro-actions and what each trust level does with them,
  the tools, and how to connect an account. Generated from this folder; nothing here repeats it.
- **How it is modelled, and why**: handbook
  [`docs/handbook/services/stripe.md`](../../docs/handbook/services/stripe.md).
- **Writing or changing a plugin**: the
  [author's guide](https://vaubaan.com/docs/plugins-guide); for the plugins of this repository,
  [`plugins/README.md`](../README.md).

## Tests

```bash
npx vitest run plugins/stripe
```

No test calls the service, and none needs a credential.
