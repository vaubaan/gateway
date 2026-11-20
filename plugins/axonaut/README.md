# `@vaubaan/plugin-axonaut`

[Axonaut](https://axonaut.com) — the French CRM and invoicing software for small companies — under a
mission: companies and their contacts, the sales pipeline, quotations, invoices and the payments
received on them, projects, tasks, support tickets and the product catalog of one Axonaut account.

- **What it lets an agent do, permission by permission**: its page,
  [vaubaan.com/plugins/axonaut](https://vaubaan.com/plugins/axonaut) — the data model, every
  permission and its five facts, the macro-actions and what each trust level does with them,
  the tools, and how to connect an account. Generated from this folder; nothing here repeats it.
- **How it is modelled, and why**: handbook
  [`docs/handbook/services/axonaut.md`](../../docs/handbook/services/axonaut.md).
- **Writing or changing a plugin**: the
  [author's guide](https://vaubaan.com/docs/plugins-guide); for the plugins of this repository,
  [`plugins/README.md`](../README.md).

## Tests

```bash
npx vitest run plugins/axonaut
```

No test calls the service, and none needs a credential.
