# `@vaubaan/plugin-vercel`

Vercel plugin for Vaubaan Gateway: projects, deployments, logs, environment variables, custom
domains, firewall (WAF) and toolbar comments.

- **What it lets an agent do, permission by permission**: its page,
  [vaubaan.com/plugins/vercel](https://vaubaan.com/plugins/vercel) — the data model, every
  permission and its five facts, the macro-actions and what each trust level does with them,
  the tools, and how to connect an account. Generated from this folder; nothing here repeats it.
- **How it is modelled, and why**: handbook
  [`docs/handbook/services/vercel.md`](../../docs/handbook/services/vercel.md).
- **Writing or changing a plugin**: the
  [author's guide](https://vaubaan.com/docs/plugins-guide); for the plugins of this repository,
  [`plugins/README.md`](../README.md).

## Tests

```bash
npx vitest run plugins/vercel
```

No test calls the service, and none needs a credential.
