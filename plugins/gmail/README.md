# `@vaubaan/plugin-gmail`

Vaubaan Gateway plugin for Gmail. The plugin models the risks of reading, drafting, sending and
labelling in a mailbox, and executes its fourteen tools over **IMAP** (`imap.gmail.com:993`,
implicit TLS) — the two sends over **SMTP** (`smtp.gmail.com:465`, implicit TLS) — signed in with
the mailbox's **app password**. Written against `@vaubaan/plugin-sdk`,
[`imapflow`](https://imapflow.com) (MIT), [`nodemailer`](https://nodemailer.com) (MIT-0) and
[`html-to-text`](https://github.com/html-to-text/node-html-to-text) (MIT).

- **What it lets an agent do, permission by permission**: its page,
  [vaubaan.com/plugins/gmail](https://vaubaan.com/plugins/gmail) — the data model, every
  permission and its five facts, the macro-actions and what each trust level does with them,
  the tools, and how to connect an account. Generated from this folder; nothing here repeats it.
- **How it is modelled, and why**: handbook
  [`docs/handbook/services/gmail.md`](../../docs/handbook/services/gmail.md).
- **Writing or changing a plugin**: the
  [author's guide](https://vaubaan.com/docs/plugins-guide); for the plugins of this repository,
  [`plugins/README.md`](../README.md).

## Tests

```bash
npx vitest run plugins/gmail
```

No test calls the service, and none needs a credential.
