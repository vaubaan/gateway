---
title: Provider plugin handbooks — index
status: current
date: 2026-10-13
last_synced: 2026-10-13
tracks:
  - plugins/*/src/risk-catalog.yaml
  - plugins/*/src/index.ts
---

# Provider plugin handbooks

One handbook per provider plugin (`plugins/<id>`). Every shipped plugin is on
the v5 plugin SDK since P1.2 (2026-10-13) and was brought to one consistent
surface by P1.2-align: catalog loaded with `catalogPathNextTo`, fallback
entry flagged `fallback: true`, no preset on the fallback, standard `oauth2`
refresh performed by the host. Each handbook follows the same structure
(spec [`gateway-risk-model.md`](../../spec/gateway-risk-model.md),
[`vaubaan-gateway.md`](../../spec/vaubaan-gateway.md) §5):

1. **Data model** — the entities of each plane, cardinalities, the
   `envScopable` entity.
2. **Tool → slice mapping** — the slice(s) each MCP tool emits.
3. **Catalog and presets** — the YAML risks (6-axis vector,
   `acceptable_in_envs` where relevant) and the shipped presets.
4. **Coverage** — every tool covered by at least one non-fallback risk.
5. **Edge cases** — the non-obvious classification decisions, argued.
6. **Credential, discovery, execution, tests** — how the plugin runs today.

These handbooks are the human source of truth for a provider's model. The
code under `plugins/<id>/src/` materialises them; the `tracks:` frontmatter
lets the drift detector compare the two.

## Index

| Plugin         | Handbook                                   | Plane(s)                             | Risks                              | Presets                                                        | Credential    | Notes                                                                                                                                                                           |
| -------------- | ------------------------------------------ | ------------------------------------ | ---------------------------------- | -------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare DNS | [`cloudflare-dns.md`](./cloudflare-dns.md) | `dns`                                | 11 + fallback                      | `read-only`, `dns-operator`, `zone-admin`                      | `api-key`     | Zone-scoped token; record-write overlays.                                                                                                                                       |
| GitHub         | [`github.md`](./github.md)                 | `repo`                               | 14 + fallback                      | `read-only`, `developer`, `release-manager`                    | `app-install` | Per-call installation token. No env-scoped risk.                                                                                                                                |
| Gmail          | [`gmail.md`](./gmail.md)                   | `mailbox`                            | 14 + fallback (+ 1 deprecated id)  | `read-only`, `developer`                                       | `oauth2`      | **Experimental**: classifier-only, no tool exposed.                                                                                                                             |
| Railway        | [`railway.md`](./railway.md)               | `runtime`                            | 9 + fallback                       | `read-only`, `developer`, `operator`                           | `oauth2`      | Resource indicator on every token request.                                                                                                                                      |
| Resend         | [`resend.md`](./resend.md)                 | `email`                              | 15 + fallback (+ 2 deprecated ids) | `read-only`, `developer`, `marketing-operator`, `domain-admin` | `api-key`     | Recipient zones from the domain resource metadata.                                                                                                                              |
| SSH            | [`ssh.md`](./ssh.md)                       | `host`                               | 7 + fallback                       | `read-only`, `developer`, `operator`                           | `ssh-key`     | Pinned host key; command classes.                                                                                                                                               |
| Stripe         | [`stripe.md`](./stripe.md)                 | `billing`                            | 16 + fallback                      | `read-only`, `test-mode-developer`, `finance-operator`         | `api-key`     | One resource per mode (test / live); catalog v4. `read-only` covers catalog, subscriptions and balance: invoices, charges, payment intents and events need `read-customer-pii`. |
| Supabase       | [`supabase.md`](./supabase.md)             | `db`, `storage`, `auth`, `functions` | 24 + fallback                      | `read-only-analyst`, `staging-developer`, `migration-operator` | `oauth2`      | Management API; `execute_sql` read-only. Prod migrations are limited to plain DDL and RLS.                                                                                      |
| Upstash Redis  | [`upstash-redis.md`](./upstash-redis.md)   | `cache`                              | 10 + fallback                      | `read-only`, `developer`, `operator`                           | `api-key`     | Env from the owner's database label.                                                                                                                                            |
| Vercel         | [`vercel.md`](./vercel.md)                 | `runtime`                            | 16 + fallback                      | `read-only`, `developer`, `operator`                           | `api-key`     | Declares `envOf` (the `env[<label>]` segment).                                                                                                                                  |

Risk counts are the live named entries of each `risk-catalog.yaml`; every
catalog adds exactly one `<id>.uncategorized-write` fallback. Deprecated ids
are counted apart. Preset values are a
starting point — ADR `mission-presets-default-values` is deferred.

An env-scoped risk is acceptable in the environments its catalog entry
lists, and the environment of a call is the label of the resource it
touches (or what the plugin's `envOf` derives). **An unlabelled resource
cannot run env-scoped operations**: the call is refused with
`risk-not-accepted`, whatever the mission accepted, until the owner labels
the resource on the connection page.

The v4 modelling notes of Railway and SSH (French) are archived as legacy in
[`railway-ssh.md`](../legacy/railway-ssh.md); both plugins have their own
handbook above.

## Updating

When a `risk-catalog.yaml`, a classifier or a preset changes, update the
corresponding handbook in the same pull request and bump `catalog_version`
(and the plugin `version` per the semver rule of ADR
[[plugin-contract-and-credential-spec]] D9, spelled out for `0.x` plugins in
[`plugins/README.md`](../../../plugins/README.md), "Shipping a plugin"). The
`tracks:` frontmatter lists the files to watch.

Versions shipped today (`version` in `src/index.ts`, equal to the plugin's
`package.json`; what telemetry reports as `plugin_version`): `2.0.0` for
cloudflare-dns, github, railway, ssh, supabase, upstash-redis and vercel;
`0.3.0` for stripe; `0.2.0` for gmail and resend. Each is one breaking step
above the Phase 1 value: the classifiers that fail closed (root
`CHANGELOG.md`, "Plugin classifiers fail closed") refuse calls the previous
version allowed, and `execute` now throws every provider failure
([plugin-sdk](../plugin-sdk.md), "Errors of `execute`").

To draft a new provider, start from
[`plugins/README.md`](../../../plugins/README.md) and copy the structure of an
existing handbook.
