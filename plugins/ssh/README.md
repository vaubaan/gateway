# `@vaubaan/plugin-ssh`

Bash over SSH as a Vaubaan Gateway plugin. One tool,
`ssh__exec`, runs a shell command line on a host the account reaches with its own ed25519 key pair
and a **pinned host key**. Inspection commands on a read allow-list are low-risk; everything else is
a write, and the classes that hurt (recursive deletes, package changes, service control, sudo) carry
their own risk so a trust level can gate them with `approval`. A line the classifier cannot see
through carries every class: the classifier fails closed.

- **What it lets an agent do, permission by permission**: its page,
  [vaubaan.com/plugins/ssh](https://vaubaan.com/plugins/ssh) — the data model, every
  permission and its five facts, the macro-actions and what each trust level does with them,
  the tools, and how to connect an account. Generated from this folder; nothing here repeats it.
- **How it is modelled, and why**: handbook
  [`docs/handbook/services/ssh.md`](../../docs/handbook/services/ssh.md).
- **Writing or changing a plugin**: the
  [author's guide](https://vaubaan.com/docs/plugins-guide); for the plugins of this repository,
  [`plugins/README.md`](../README.md).

## Tests

```bash
npx vitest run plugins/ssh
```

No test calls the service, and none needs a credential.
