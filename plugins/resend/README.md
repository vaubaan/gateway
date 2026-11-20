# `@vaubaan/plugin-resend`

Outbound email through [Resend](https://resend.com) as a Vaubaan Gateway plugin. Transactional sends
classified by **who the email goes to**, segments and contacts, broadcast campaigns and sending
domains — with **one resource per sending domain and one per segment**, so a mission can send from
the staging domain freely and touch the production domain or the customer segment under budget and
approval.

- **What it lets an agent do, permission by permission**: its page,
  [vaubaan.com/plugins/resend](https://vaubaan.com/plugins/resend) — the data model, every
  permission and its five facts, the macro-actions and what each trust level does with them,
  the tools, and how to connect an account. Generated from this folder; nothing here repeats it.
- **How it is modelled, and why**: handbook
  [`docs/handbook/services/resend.md`](../../docs/handbook/services/resend.md).
- **Writing or changing a plugin**: the
  [author's guide](https://vaubaan.com/docs/plugins-guide); for the plugins of this repository,
  [`plugins/README.md`](../README.md).

## Tests

```bash
npx vitest run plugins/resend
```

No test calls the service, and none needs a credential.
