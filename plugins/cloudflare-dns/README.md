# `@vaubaan/plugin-cloudflare-dns`

Cloudflare DNS as a Vaubaan Gateway provider plugin on the v5 SDK
(`@vaubaan/plugin-sdk`). Zones, records, BIND import / export, zone
settings, DNSSEC and cache purge over the Cloudflare REST API v4 — with
**one resource per zone**, so a mission touches exactly the domains it was
given, and with apex / MX / NS changes and deletions as risks of their own.

Contract: [`plugin-contract-and-credential-spec`](../../docs/decisions/plugin-contract-and-credential-spec.md).
Modelling handbook: [`docs/handbook/providers/cloudflare-dns.md`](../../docs/handbook/providers/cloudflare-dns.md).
Contributor guide: [`plugins/README.md`](../README.md).

## Data model

One plane, `dns`, rooted at `account` → `zone`:

```
account[<account id>].zone[<zone id>]
  ├─ record[*] ─ critical (synthetic) · delete (synthetic verb)
  ├─ zone-settings · dnssec · cache
  └─ zone-import (synthetic) · zone-export (synthetic)
```

No entity is `envScopable`: DNS has no test/live mode and no catalog risk is
env-scoped. `record.critical` is an overlay emitted next to a record write
— create, update or deletion — when the record is the apex (`example.com`,
`@`), a wildcard at the apex (`*.example.com`), or of type MX or NS.
`record.delete` is the verb leaf of a deletion. `zone-import` / `zone-export` stand for the BIND bulk endpoints.

## Credential and resources

Kind `api-key`, one required secret field:

| Field       | Pattern                | Purpose                                                             |
| ----------- | ---------------------- | ------------------------------------------------------------------- |
| `api_token` | `^[A-Za-z0-9_-]{20,}$` | A Cloudflare API token. A Global API Key (`email\|key`) is refused. |

There is no company-registered app for Cloudflare DNS: the owner creates the
token at `https://dash.cloudflare.com/profile/api-tokens` and pastes it.
Scope it to the zones the agent may touch, with **Zone:Read** and
**DNS:Edit**, plus **Zone Settings:Edit**, **Cache Purge:Purge** and
**Zone:Edit** only when the corresponding tools are wanted.

`discoverResources` pages through `GET /zones` (50 per page, at most 500
zones, no account filter) and returns **one resource per zone**:

```ts
{ provider: 'cloudflare-dns', ref: '023e105f4ecef8ad9ca31a8372d0c353', displayName: 'example.com',
  metadata: { zone_name: 'example.com', account_id: '01a7362d577a6c3019a474fd6f485823',
              account_name: 'Example Corp', status: 'active' } }
```

The `ref` is the zone id every tool takes as `zone_id`. `account_id` becomes
the `account[…]` segment of the slices; `zone_name` lets the classifier tell
an apex record from a subdomain record.

## Tools

15 tools named `cloudflare_dns__<verb>_<noun>`. Every zone-scoped tool takes
`zone_id`, which must be one of the mission's zones (it may be omitted when
the mission holds a single zone). `zone_id` and `record_id` are consumed by
the gateway and never forwarded.

`zone_id` and `record_id` end up in the request path, so both must be a
single path-safe segment: `^[A-Za-z0-9_-]{1,64}$` (`pathIdent` in
`src/resources.ts`, applied by `classify` and by `execute`). `.`, `..`, a
`/` or any other character is refused before classification and before any
call — `dns_records/..` would otherwise be sent as the zone endpoint. The
zone's account id goes through the same grammar before it is embedded in a
slice (the glob `*` otherwise).

A record's `type` and `name` travel in the JSON body and decide the
critical-record verdict. They are read by `recordType` and `dnsName`
(`src/resources.ts`): a type that is not a type name, or a name that is not
a DNS name (whitespace, a control or non-ASCII character, a separator, an
escape, an inner wildcard…), makes the write a critical one — never an
ordinary one.

Reads (7): `list_zones`, `get_zone`, `list_records`, `get_record`,
`export_records`, `get_zone_settings`, `get_dnssec`.

Writes (8): `create_record`, `update_record`, `delete_record`,
`import_records`, `edit_zone_settings`, `purge_cache`, `edit_dnssec`,
`delete_zone`.

Three behaviours are specific to v5:

- `list_zones` answers with the upstream list **filtered to the mission's
  zones** (`result_info` is passed through unchanged).
- `update_record` requires `type` and `name`. When they describe an ordinary
  subdomain record, `execute` reads the record first and refuses the PATCH
  if the record is in fact apex, wildcard, MX or NS — otherwise an agent
  could move an apex record away while holding `record-write` only.
- `delete_record` takes the same `type` and `name`, optional. Without them
  the deletion is classified as a critical record write
  (`critical-record-write` on top of `record-write` and `record-delete`).
  With them, a deletion declared ordinary is checked the same way: `execute`
  reads the record first and refuses the DELETE if it is apex, wildcard, MX
  or NS, or if its type and name cannot be read back. `type` and `name` are
  never sent upstream on a deletion.

## Catalog

`src/risk-catalog.yaml`, version 2: 11 named risks and the
`cloudflare-dns.uncategorized-write` fallback.

| Risk                                   | Action | Notes                                                                                  |
| -------------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| `cloudflare-dns.read-zone-metadata`    | R      | Zones, settings, DNSSEC. `zone[**].R` is recursive: record reads touch it too.         |
| `cloudflare-dns.read-records`          | R      | Record values (topology).                                                              |
| `cloudflare-dns.export-zone-file`      | R      | Whole zone in one BIND dump.                                                           |
| `cloudflare-dns.record-write`          | W      | Every record write, critical and deletions included (`record[**].W`).                  |
| `cloudflare-dns.critical-record-write` | W      | Apex, wildcard-at-apex, MX, NS, deletions included; any write without `type` + `name`. |
| `cloudflare-dns.record-delete`         | W      | `record[R].delete.W`.                                                                  |
| `cloudflare-dns.import-records`        | W      | Bulk, may overwrite apex and MX.                                                       |
| `cloudflare-dns.zone-settings-write`   | W      | SSL mode, minimum TLS…                                                                 |
| `cloudflare-dns.dnssec-write`          | W      | Can break resolution.                                                                  |
| `cloudflare-dns.cache-purge`           | W      | Reversible, load spike.                                                                |
| `cloudflare-dns.zone-delete`           | W      | Irreversible. `zone[*].W`: the zone itself, never a write under it.                    |
| `cloudflare-dns.uncategorized-write`   | W      | Fallback; in no preset.                                                                |

Record writes are layered: a mission needs `record-write` for any record
change, plus `critical-record-write` for the sensitive ones and
`record-delete` for deletions. Deleting an apex, wildcard, MX or NS record
— or any record the call does not name by `type` and `name` — needs all
three.

## Presets

| Preset         | Scope                                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `read-only`    | Zone metadata and record values. No export, no write.                                                                                                                          |
| `dns-operator` | Reads, `record-write` and `cache-purge`, all `auto`. Cannot touch apex / MX / NS records, delete records, import, or edit zone settings.                                       |
| `zone-admin`   | Reads including export, `record-write` and `cache-purge` `auto`; `critical-record-write`, `record-delete`, `import-records`, `zone-settings-write`, `dnssec-write` `approval`. |

No preset lists `zone-delete` or the fallback. Presets are UI sugar: the
persisted policy is the explicit enumeration.

## Tests

`npx vitest run plugins/cloudflare-dns` — 122 tests: the SDK kit
(`assertPluginWellFormed`, `assertCatalogCoverage`, `assertNoWildcard`,
`assertPresetsValid`), the classifier (`plugin.test.ts` and the per-tool
suite `classify.test.ts`, including the path-safe identifiers), `execute`
and `discoverResources` against `mockFetch` (the update / delete guard, no
call for an unsafe identifier), the credential spec and presets, catalog
invariants with the exact risks each tool touches, and the data model. No
test ever calls Cloudflare.
