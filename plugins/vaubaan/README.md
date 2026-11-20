# `@vaubaan/plugin-vaubaan`

The gateway's own management tools, as a service: an agent prepares missions for other agents, in a
person's name, with a mission key on the execution door (`/mcp`). A person connects their **Vaubaan
account** in one click — it holds no secret, belongs to them alone and is never shared — issues a
mission on it (the account page offers the platform management mission, every macro-action at
Careful) and hands its key to the agent.

The plugin is bundled with the gateway only: its `execute` is bound by the host to the mission
service (`apps/gateway/src/server/compose/vaubaan.ts`), and a pin declaring a `host` account is
refused at boot.

- **What it lets an agent do, permission by permission**: its page,
  [vaubaan.com/plugins/vaubaan](https://vaubaan.com/plugins/vaubaan) — the data model, every
  permission and its five facts, the macro-actions and what each trust level does with them,
  the tools, and how to connect an account. Generated from this folder; nothing here repeats it.
- **How it is modelled, and why**: handbook
  [`docs/handbook/services/vaubaan.md`](../../docs/handbook/services/vaubaan.md).
- **Writing or changing a plugin**: the
  [author's guide](https://vaubaan.com/docs/plugins-guide); for the plugins of this repository,
  [`plugins/README.md`](../README.md).

## Tests

```bash
npx vitest run plugins/vaubaan
```

No test calls the service, and none needs a credential.
