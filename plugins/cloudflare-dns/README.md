# `@vaubaan/plugin-cloudflare-dns`

Cloudflare DNS as a Vaubaan Gateway plugin. Zones, records, BIND import / export, zone settings,
DNSSEC and cache purge over the Cloudflare REST API v4 — with **one resource per zone**, so a
mission touches exactly the domains it was given, and with apex / MX / NS changes and deletions as
risks of their own.

- **What it lets an agent do, permission by permission**: its page,
  [vaubaan.com/plugins/cloudflare-dns](https://vaubaan.com/plugins/cloudflare-dns) — the data model, every
  permission and its five facts, the macro-actions and what each trust level does with them,
  the tools, and how to connect an account. Generated from this folder; nothing here repeats it.
- **How it is modelled, and why**: handbook
  [`docs/handbook/services/cloudflare-dns.md`](../../docs/handbook/services/cloudflare-dns.md).
- **Writing or changing a plugin**: the
  [author's guide](https://vaubaan.com/docs/plugins-guide); for the plugins of this repository,
  [`plugins/README.md`](../README.md).

## Tests

```bash
npx vitest run plugins/cloudflare-dns
```

No test calls the service, and none needs a credential.
