# `@vaubaan/plugin-github-projects`

One GitHub Projects (v2) board of an organization: its fields, views and items, over GitHub's REST
API (`/orgs/{org}/projectsV2/{number}/…`). Separate from the GitHub plugin.

- **What it lets an agent do, permission by permission**: its page,
  [vaubaan.com/plugins/github-projects](https://vaubaan.com/plugins/github-projects) — the data model, every
  permission and its five facts, the macro-actions and what each trust level does with them,
  the tools, and how to connect an account. Generated from this folder; nothing here repeats it.
- **How it is modelled, and why**: handbook
  [`docs/handbook/services/github-projects.md`](../../docs/handbook/services/github-projects.md).
- **Writing or changing a plugin**: the
  [author's guide](https://vaubaan.com/docs/plugins-guide); for the plugins of this repository,
  [`plugins/README.md`](../README.md).

## Tests

```bash
npx vitest run plugins/github-projects
```

No test calls the service, and none needs a credential.
