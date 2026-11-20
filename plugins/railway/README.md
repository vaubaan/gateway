# `@vaubaan/plugin-railway`

Vaubaan Gateway plugin for [Railway](https://railway.com). It rewraps the official Railway MCP
server (`https://mcp.railway.com/`, 10 tools) and adds four GraphQL-backed environment-variable
tools, under the `railway__` prefix.

- **What it lets an agent do, permission by permission**: its page,
  [vaubaan.com/plugins/railway](https://vaubaan.com/plugins/railway) — the data model, every
  permission and its five facts, the macro-actions and what each trust level does with them,
  the tools, and how to connect an account. Generated from this folder; nothing here repeats it.
- **How it is modelled, and why**: handbook
  [`docs/handbook/services/railway.md`](../../docs/handbook/services/railway.md).
- **Writing or changing a plugin**: the
  [author's guide](https://vaubaan.com/docs/plugins-guide); for the plugins of this repository,
  [`plugins/README.md`](../README.md).

## Tests

```bash
npx vitest run plugins/railway
```

No test calls the service, and none needs a credential.
