# `@vaubaan/plugin-supabase`

Plugin for [Supabase](https://supabase.com): Postgres, Storage, Auth (GoTrue) and Edge Functions of
the company's projects, reached through the Supabase **Management API** with a personal access token
pasted once.

- **What it lets an agent do, permission by permission**: its page,
  [vaubaan.com/plugins/supabase](https://vaubaan.com/plugins/supabase) — the data model, every
  permission and its five facts, the macro-actions and what each trust level does with them,
  the tools, and how to connect an account. Generated from this folder; nothing here repeats it.
- **How it is modelled, and why**: handbook
  [`docs/handbook/services/supabase.md`](../../docs/handbook/services/supabase.md).
- **Writing or changing a plugin**: the
  [author's guide](https://vaubaan.com/docs/plugins-guide); for the plugins of this repository,
  [`plugins/README.md`](../README.md).

## Tests

```bash
npx vitest run plugins/supabase
```

No test calls the service, and none needs a credential.
