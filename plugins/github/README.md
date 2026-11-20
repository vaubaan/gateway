# `@vaubaan/plugin-github`

GitHub plugin for Vaubaan Gateway. One account is **one repository** (`owner/repo`, named on the
connect form) and a **fine-grained personal access token** made for it; that repository is the
account's one resource, and another repository is another account. A mission picks repositories and
macro-actions at a trust level, which write the risks it accepts. An account made before the form
named its repository keeps the former listing (`GET /user/repos`) until it is reconnected (handbook,
"Repositories outside the grant").

- **What it lets an agent do, permission by permission**: its page,
  [vaubaan.com/plugins/github](https://vaubaan.com/plugins/github) — the data model, every
  permission and its five facts, the macro-actions and what each trust level does with them,
  the tools, and how to connect an account. Generated from this folder; nothing here repeats it.
- **How it is modelled, and why**: handbook
  [`docs/handbook/services/github.md`](../../docs/handbook/services/github.md).
- **Writing or changing a plugin**: the
  [author's guide](https://vaubaan.com/docs/plugins-guide); for the plugins of this repository,
  [`plugins/README.md`](../README.md).

## Tests

```bash
npx vitest run plugins/github
```

No test calls the service, and none needs a credential.
