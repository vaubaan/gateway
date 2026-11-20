# `@vaubaan/plugin-asana`

Asana for Vaubaan Gateway: the projects an Asana account can see, their sections, tasks, subtasks
and comments, on Asana's REST API (`https://app.asana.com/api/1.0`), with a personal access token.
Agents read projects and tasks, create, change, comment on and delete tasks. No project
administration, no access rights, no attachments.

- **What it lets an agent do, permission by permission**: its page,
  [vaubaan.com/plugins/asana](https://vaubaan.com/plugins/asana) — the data model, every
  permission and its five facts, the macro-actions and what each trust level does with them,
  the tools, and how to connect an account. Generated from this folder; nothing here repeats it.
- **How it is modelled, and why**: handbook
  [`docs/handbook/services/asana.md`](../../docs/handbook/services/asana.md).
- **Writing or changing a plugin**: the
  [author's guide](https://vaubaan.com/docs/plugins-guide); for the plugins of this repository,
  [`plugins/README.md`](../README.md).

## Tests

```bash
npx vitest run plugins/asana
```

No test calls the service, and none needs a credential.
