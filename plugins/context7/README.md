# `@vaubaan/plugin-context7`

Context7 for Vaubaan Gateway: agents look up current library documentation through the gateway,
under a mission. The Context7 API key is a gateway account, kept encrypted by the gateway; it is
never in an environment variable or in an MCP client's configuration.

The plugin **rewraps the official Context7 MCP server** (`https://mcp.context7.com/mcp`): its two
tools, their descriptions and their answers are Context7's own. The REST API (`GET
https://context7.com/api/v2/usage`) is used around them only, to check a pasted key, for discovery
and to explain a failed call.

- **What it lets an agent do, permission by permission**: its page,
  [vaubaan.com/plugins/context7](https://vaubaan.com/plugins/context7) — the data model, every
  permission and its five facts, the macro-actions and what each trust level does with them,
  the tools, and how to connect an account. Generated from this folder; nothing here repeats it.
- **How it is modelled, and why**: handbook
  [`docs/handbook/services/context7.md`](../../docs/handbook/services/context7.md).
- **Writing or changing a plugin**: the
  [author's guide](https://vaubaan.com/docs/plugins-guide); for the plugins of this repository,
  [`plugins/README.md`](../README.md).

## Tests

```bash
npx vitest run plugins/context7
```

No test calls the service, and none needs a credential.
