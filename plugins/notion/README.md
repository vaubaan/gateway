# `@vaubaan/plugin-notion`

Notion as a Vaubaan Gateway plugin. Pages, page content (blocks), databases (data sources and their
entries) and comments, over Notion's REST API with `Notion-Version: 2026-03-11` — with **one
resource per top-level page or database shared with the account**, and every id a call names proven
to be under that resource before anything is read or written.

- **What it lets an agent do, permission by permission**: its page,
  [vaubaan.com/plugins/notion](https://vaubaan.com/plugins/notion) — the data model, every
  permission and its five facts, the macro-actions and what each trust level does with them,
  the tools, and how to connect an account. Generated from this folder; nothing here repeats it.
- **How it is modelled, and why**: handbook
  [`docs/handbook/services/notion.md`](../../docs/handbook/services/notion.md).
- **Writing or changing a plugin**: the
  [author's guide](https://vaubaan.com/docs/plugins-guide); for the plugins of this repository,
  [`plugins/README.md`](../README.md).

## Tests

```bash
npx vitest run plugins/notion
```

No test calls the service, and none needs a credential.
