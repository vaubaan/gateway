# `@vaubaan/plugin-miro`

Miro boards for Vaubaan Gateway, through **Miro's official MCP server** (`https://mcp.miro.com/`):
read and draw on boards, tables, comments, prototypes — one resource per board.

A person connects Miro from Accounts → Connect: they sign in at Miro, choose a team and allow the
gateway. There is **no Miro app to create and nothing to paste**: the gateway registers its own
OAuth client at Miro the first time someone connects (RFC 7591). On a Miro Enterprise plan, an
administrator first enables Miro's MCP server for the organisation.

- **What it lets an agent do, permission by permission**: its page,
  [vaubaan.com/plugins/miro](https://vaubaan.com/plugins/miro) — the data model, every
  permission and its five facts, the macro-actions and what each trust level does with them,
  the tools, and how to connect an account. Generated from this folder; nothing here repeats it.
- **How it is modelled, and why**: handbook
  [`docs/handbook/services/miro.md`](../../docs/handbook/services/miro.md).
- **Writing or changing a plugin**: the
  [author's guide](https://vaubaan.com/docs/plugins-guide); for the plugins of this repository,
  [`plugins/README.md`](../README.md).

## Tests

```bash
npx vitest run plugins/miro
```

No test calls the service, and none needs a credential.
