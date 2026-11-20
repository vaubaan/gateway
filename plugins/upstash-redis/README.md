# `@vaubaan/plugin-upstash-redis`

Upstash Redis plugin for Vaubaan Gateway: databases through the Upstash Management API, key-value
data through each database's REST endpoint.

- **What it lets an agent do, permission by permission**: its page,
  [vaubaan.com/plugins/upstash-redis](https://vaubaan.com/plugins/upstash-redis) — the data model, every
  permission and its five facts, the macro-actions and what each trust level does with them,
  the tools, and how to connect an account. Generated from this folder; nothing here repeats it.
- **How it is modelled, and why**: handbook
  [`docs/handbook/services/upstash-redis.md`](../../docs/handbook/services/upstash-redis.md).
- **Writing or changing a plugin**: the
  [author's guide](https://vaubaan.com/docs/plugins-guide); for the plugins of this repository,
  [`plugins/README.md`](../README.md).

## Tests

```bash
npx vitest run plugins/upstash-redis
```

No test calls the service, and none needs a credential.
