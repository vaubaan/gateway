---
title: Cloudflare DNS provider — v4 risk-based modelling
status: current
date: 2026-06-23
last_reviewed: 2026-06-23
tracks:
  - packages/providers/cloudflare-dns/src/data-model.ts
  - packages/providers/cloudflare-dns/src/risk-catalog.ts
  - packages/providers/cloudflare-dns/src/risk-catalog.yaml
  - packages/providers/cloudflare-dns/src/risk-classifier.ts
  - packages/providers/cloudflare-dns/src/index.ts
---

# Cloudflare DNS provider — v4 risk-based modelling

Tenth Vaubaan provider. Covers DNS zone and record management for a
single Cloudflare account. Simpler than Stripe or Gmail : 8 entities,
no `envScopable` (DNS has no test/live mode), no synthetic overlays,
no caps, no `infra_limits`.

Spec : `docs/spec/gateway-risk-model.md`.
Research : `.vaubaan/research/providers/cloudflare-dns.md`.

---

## Vue d'ensemble

The package lives in `packages/providers/cloudflare-dns/`. At this
stage it contains only the v4 risk-based modelling artifacts (Phases
B/C/D). Runtime artifacts (adapter, execute, tools) will be added
when the Cloudflare DNS runtime is implemented.

Exports from `src/index.ts`:

- `cloudflareDnsDataModel` -- entity graph for the `dns` plane.
- `cloudflareDnsRiskCatalog` -- TS mirror of `risk-catalog.yaml` (10 entries).
- `classifyCloudflareDnsV4` -- maps `(tool, args, bindings)` to slices.
- `CloudflareDnsClassifyV4Result` -- type alias for the classify return.

Auth model : API Token (Bearer) only at MVP. The operator creates a
scoped token from the Cloudflare dashboard and pastes it into the
binding form. No OAuth, no Global API Key.

---

## Comment ca marche

### 1. Data model (`src/data-model.ts`)

Single plane `dns` with 8 entities rooted at `account` :

```
account (one, root)
  zone (bounded)
    record (unbounded)
    zone-settings (one)
    dnssec (one)
    cache (one)
    zone-import (one, synthetic)
    zone-export (one, synthetic)
```

No entity has `envScopable: true`. The binding's `resource_ref` is the
Cloudflare **account_id** (one API Token may cover N zones under that
account).

`zone-import` and `zone-export` are synthetic singleton entities : they
represent BIND zone file operations (bulk import POST, atomic export
GET), not queryable REST resources.

Validated by `tests/unit/data-model.test.ts` (referential integrity,
single plane, no envScopable, 8 entities).

### 2. Risk catalog (`src/risk-catalog.yaml` + `src/risk-catalog.ts`)

9 named risks + 1 fallback = 10 total.

| RiskId                               | Label                                   | Reversibility    |
| ------------------------------------ | --------------------------------------- | ---------------- |
| `cloudflare-dns.read-zone-metadata`  | Read zone and account metadata          | reversible       |
| `cloudflare-dns.read-records`        | Read DNS records (IPs, CNAMEs, MX, TXT) | reversible       |
| `cloudflare-dns.export-zone-file`    | Export full zone as BIND file           | reversible       |
| `cloudflare-dns.record-write`        | Create / update / delete a DNS record   | costly           |
| `cloudflare-dns.import-records`      | Bulk import DNS records from BIND file  | costly           |
| `cloudflare-dns.zone-settings-write` | Edit zone settings (SSL, TLS, cache)    | costly           |
| `cloudflare-dns.dnssec-write`        | Enable / disable DNSSEC                 | costly           |
| `cloudflare-dns.cache-purge`         | Purge CDN cache                         | reversible       |
| `cloudflare-dns.zone-delete`         | Delete entire DNS zone                  | **irreversible** |
| `cloudflare-dns.uncategorized-write` | Fallback catch-all                      | costly           |

Key properties :

- **No caps, no `infra_limits`** -- upstream rate-limit (1200 req/5min)
  suffices at MVP.
- **No `acceptable_in_envs`** -- no env scoping (DNS has no test/live).
- **`zone-delete` is the only irreversible risk** -- domain stops
  resolving immediately ; recreation requires zone + full record reimport.

The YAML is the canonical reviewable form. The TS module
(`risk-catalog.ts`) is a 1:1 structural mirror for runtime import
(Vercel does not bundle YAML). Sync enforced by
`tests/unit/risk-catalog-sync.test.ts`.

### 3. Classifier (`src/risk-classifier.ts`)

`classifyCloudflareDnsV4(tool, args, bindings)` maps 15 tools (7 reads

- 8 writes) to slices.

Binding helpers :

- `pickCloudflareDnsBinding(bindings)` -- finds the binding with
  `provider === 'cloudflare-dns'`.
- `accountSeg(binding)` -- resolves `resource_ref` to the account ident
  segment. Falls back to `*` when empty.
- No mode segment (no `envScopable`).

Root prefix : `[name('account'), acct]`.

Tool mapping :

| Tool                                 | Slice                                | Risk matched                       |
| ------------------------------------ | ------------------------------------ | ---------------------------------- |
| `cloudflare_dns__list_zones`         | `account[A].zone[*].R`               | read-zone-metadata                 |
| `cloudflare_dns__get_zone`           | `account[A].zone[Z].R`               | read-zone-metadata                 |
| `cloudflare_dns__list_records`       | `account[A].zone[Z].record[*].R`     | read-records (+read-zone-metadata) |
| `cloudflare_dns__get_record`         | `account[A].zone[Z].record[R].R`     | read-records (+read-zone-metadata) |
| `cloudflare_dns__export_records`     | `account[A].zone[Z].zone-export.R`   | export-zone-file                   |
| `cloudflare_dns__get_zone_settings`  | `account[A].zone[Z].zone-settings.R` | read-zone-metadata                 |
| `cloudflare_dns__get_dnssec`         | `account[A].zone[Z].dnssec.R`        | read-zone-metadata                 |
| `cloudflare_dns__create_record`      | `account[A].zone[Z].record.W`        | record-write                       |
| `cloudflare_dns__update_record`      | `account[A].zone[Z].record[R].W`     | record-write                       |
| `cloudflare_dns__delete_record`      | `account[A].zone[Z].record[R].W`     | record-write                       |
| `cloudflare_dns__import_records`     | `account[A].zone[Z].zone-import.W`   | import-records                     |
| `cloudflare_dns__edit_zone_settings` | `account[A].zone[Z].zone-settings.W` | zone-settings-write                |
| `cloudflare_dns__purge_cache`        | `account[A].zone[Z].cache.W`         | cache-purge                        |
| `cloudflare_dns__edit_dnssec`        | `account[A].zone[Z].dnssec.W`        | dnssec-write                       |
| `cloudflare_dns__delete_zone`        | `account[A].zone[Z].W`               | zone-delete                        |

Note : record reads also match `read-zone-metadata` because the catalog
pattern `zone[**].R` is recursive. This means reading records requires
the operator to accept both `read-zone-metadata` and `read-records`.

Unknown tools return `{ denied: 'unknown cloudflare-dns tool ...' }`.
Missing binding returns `{ denied: 'no cloudflare-dns binding ...' }`.

---

## Tests

4 test files in `tests/unit/` :

- **`data-model.test.ts`** -- referential integrity, single plane, no
  envScopable, account root, 8 entities.
- **`risk-catalog.test.ts`** -- YAML structural validation (10 entries),
  RISK_ID_REGEX, unique ids, 6D vector axes, fallback exists, zone-delete
  is the only irreversible, no caps, no infra_limits, no
  acceptable_in_envs, coverage lint (every tool matched by at least one
  non-fallback risk), `risksTouchedBy` sanity checks.
- **`risk-catalog-sync.test.ts`** -- YAML-to-TS structural sync (same
  ids, labels, reasons, matches, vectors in both files).
- **`risk-classifier.test.ts`** -- all 15 tools with representative args,
  account propagation from binding, no mode segment, denials (unknown
  tool, missing binding, non-matching provider), future tools rejected.

---

## Extension -- adding the runtime

When the Cloudflare DNS runtime is implemented, add :

1. `src/tools.ts` -- `McpToolDeclaration[]` for the 15 tools.
2. `src/execute.ts` -- REST dispatcher to `api.cloudflare.com/client/v4/`.
3. `src/cloudflare-dns-adapter.ts` -- paste-token adapter following the
   Stripe/Upstash pattern.
4. Gateway wiring in `packages/mcp-gateway/src/gateway.ts`,
   `packages/web/src/lib/gateway/build.ts`, and
   `packages/web/src/components/providers/provider-info.ts`.
5. Update this handbook's `tracks:` to include the new files.

---

## Reste a faire

- **Runtime** (adapter, execute, tools, gateway wiring) -- not yet
  implemented.
- **Web UI binding form** -- Cloudflare API Token input.
- **Web UI token mint** -- risk list for Cloudflare DNS.

---

## References

- Spec : `docs/spec/gateway-risk-model.md`
- Research : `.vaubaan/research/providers/cloudflare-dns.md`
- Risk catalog YAML :
  [`packages/providers/cloudflare-dns/src/risk-catalog.yaml`](../../../packages/providers/cloudflare-dns/src/risk-catalog.yaml)
- Risk catalog TS :
  [`packages/providers/cloudflare-dns/src/risk-catalog.ts`](../../../packages/providers/cloudflare-dns/src/risk-catalog.ts)
