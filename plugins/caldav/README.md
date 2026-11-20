# `@vaubaan/plugin-caldav`

**CalDAV Calendar** — the Vaubaan Gateway plugin for calendars on any CalDAV server: iCloud,
Fastmail, Nextcloud and the other servers that speak the standard (RFC 4791). Connected with a
server URL, a username and an **app password**. Lists calendars and events, reads, creates, changes
and deletes events, under risks zoned by who the attendees are.

**Not for Google Calendar**: Google refuses app passwords over CalDAV. Use the `google-calendar`
plugin.

- **What it lets an agent do, permission by permission**: its page,
  [vaubaan.com/plugins/caldav](https://vaubaan.com/plugins/caldav) — the data model, every
  permission and its five facts, the macro-actions and what each trust level does with them,
  the tools, and how to connect an account. Generated from this folder; nothing here repeats it.
- **How it is modelled, and why**: handbook
  [`docs/handbook/services/caldav.md`](../../docs/handbook/services/caldav.md).
- **Writing or changing a plugin**: the
  [author's guide](https://vaubaan.com/docs/plugins-guide); for the plugins of this repository,
  [`plugins/README.md`](../README.md).

## Tests

```bash
npx vitest run plugins/caldav
```

No test calls the service, and none needs a credential.
