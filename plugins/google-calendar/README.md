# `@vaubaan/plugin-google-calendar`

Google Calendar for Vaubaan Gateway, through **Google's Calendar REST API v3**
(`https://www.googleapis.com/calendar/v3`), with tools of its own. The access token comes from the
**OAuth broker** the instance is enrolled with: the broker owns the Google OAuth client and keeps no
token; the instance keeps the refresh token and the current access token, and verifies the broker's
attestation before it sends it anything. Calendar data never goes through the broker.

- **What it lets an agent do, permission by permission**: its page,
  [vaubaan.com/plugins/google-calendar](https://vaubaan.com/plugins/google-calendar) — the data model, every
  permission and its five facts, the macro-actions and what each trust level does with them,
  the tools, and how to connect an account. Generated from this folder; nothing here repeats it.
- **How it is modelled, and why**: handbook
  [`docs/handbook/services/google-calendar.md`](../../docs/handbook/services/google-calendar.md).
- **Writing or changing a plugin**: the
  [author's guide](https://vaubaan.com/docs/plugins-guide); for the plugins of this repository,
  [`plugins/README.md`](../README.md).

## Tests

```bash
npx vitest run plugins/google-calendar
```

No test calls the service, and none needs a credential.
