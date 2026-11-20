# `@vaubaan/plugin-outlook`

Mail and calendar of a **Microsoft 365 or Outlook.com account** for Vaubaan Gateway, through
**Microsoft Graph v1.0** (`https://graph.microsoft.com/v1.0`), with tools of its own. The access
token comes from the **OAuth broker** the instance is enrolled with: the broker owns the Entra app
registration and keeps no token; the instance keeps the refresh token and the current access token.
Mail and calendar data never go through the broker.

- **What it lets an agent do, permission by permission**: its page,
  [vaubaan.com/plugins/outlook](https://vaubaan.com/plugins/outlook) — the data model, every
  permission and its five facts, the macro-actions and what each trust level does with them,
  the tools, and how to connect an account. Generated from this folder; nothing here repeats it.
- **How it is modelled, and why**: handbook
  [`docs/handbook/services/outlook.md`](../../docs/handbook/services/outlook.md).
- **Writing or changing a plugin**: the
  [author's guide](https://vaubaan.com/docs/plugins-guide); for the plugins of this repository,
  [`plugins/README.md`](../README.md).

## Tests

```bash
npx vitest run plugins/outlook
```

No test calls the service, and none needs a credential.
