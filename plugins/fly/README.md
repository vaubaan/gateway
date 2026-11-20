# `@vaubaan/plugin-fly`

Fly.io for Vaubaan Gateway: the apps of one Fly organization, their machines and images, volumes and
snapshots, secrets, IP addresses and certificates, through the Machines REST API
(`https://api.machines.dev/v1`), and the app logs `fly logs` reads. Usable for any Fly organization,
gateway instances included.

- **What it lets an agent do, permission by permission**: its page,
  [vaubaan.com/plugins/fly](https://vaubaan.com/plugins/fly) — the data model, every
  permission and its five facts, the macro-actions and what each trust level does with them,
  the tools, and how to connect an account. Generated from this folder; nothing here repeats it.
- **How it is modelled, and why**: handbook
  [`docs/handbook/services/fly.md`](../../docs/handbook/services/fly.md).
- **Writing or changing a plugin**: the
  [author's guide](https://vaubaan.com/docs/plugins-guide); for the plugins of this repository,
  [`plugins/README.md`](../README.md).

## Tests

```bash
npx vitest run plugins/fly
```

No test calls the service, and none needs a credential.
