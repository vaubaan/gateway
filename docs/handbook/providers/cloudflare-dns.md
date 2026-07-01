---
title: Cloudflare DNS provider — v4 risk-based modelling + runtime
status: current
date: 2026-06-23
last_reviewed: 2026-07-01
tracks:
  - packages/providers/cloudflare-dns/src/data-model.ts
  - packages/providers/cloudflare-dns/src/risk-catalog.ts
  - packages/providers/cloudflare-dns/src/risk-catalog.yaml
  - packages/providers/cloudflare-dns/src/risk-classifier.ts
  - packages/providers/cloudflare-dns/src/tools.ts
  - packages/providers/cloudflare-dns/src/execute.ts
  - packages/providers/cloudflare-dns/src/cloudflare-dns-adapter.ts
  - packages/providers/cloudflare-dns/src/index.ts
  - packages/web/src/lib/gateway/build.ts
---

# Cloudflare DNS provider — v4 risk-based modelling + runtime

Tenth Vaubaan provider. Covers DNS zone and record management for a
single Cloudflare account. Simpler than Stripe or Gmail : 8 entities,
no `envScopable` (DNS has no test/live mode), no synthetic overlays,
no caps, no `infra_limits`.

Spec : `docs/spec/gateway-risk-model.md`.
Research : `.vaubaan/research/providers/cloudflare-dns.md`.

---

## Vue d'ensemble

The package lives in `packages/providers/cloudflare-dns/`. It contains
the v4 risk-based modelling artifacts (data-model, risk catalog,
classifier) and the full runtime (adapter, dispatcher, 15 MCP tools).

Exports from `src/index.ts`:

- `CloudflareDnsAdapter` -- paste-token adapter class.
- `cloudflareDnsAvailableTools` -- 15 `McpToolDeclaration[]` (7 reads + 8 writes).
- `cloudflareDnsExecuteCall` -- REST dispatcher function.
- `cloudflareDnsDataModel` -- entity graph for the `dns` plane.
- `cloudflareDnsRiskCatalog` -- TS mirror of `risk-catalog.yaml` (10 entries).
- `classifyCloudflareDnsV4` -- maps `(tool, args, bindings)` to slices.
- `CloudflareDnsClassifyV4Result` -- type alias for the classify return.

Auth model : API Token (Bearer) or Global API Key (`email|key` format,
detected by `|` separator). The operator creates a token from the
Cloudflare dashboard and pastes it into the binding form. No OAuth.

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
single plane, no envScopable, account root, 8 entities).

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

### 4. Tools (`src/tools.ts`)

15 `McpToolDeclaration` entries (7 reads + 8 writes), prefixed
`cloudflare_dns__`. Each tool declares its `inputSchema` with the
required and optional parameters matching the Cloudflare REST API.

Exports :

- `availableTools` -- the full array of 15 tool declarations.
- `WRITE_TOOL_NAMES` -- `Set<string>` of the 8 write tool names.

Key input patterns :

- Most tools require `zone_id`.
- `get_record`, `update_record`, `delete_record` also require `record_id`.
- `create_record` requires `type`, `name`, `content` ; optionally `ttl`,
  `proxied`, `priority`.
- `list_records` accepts optional filters : `type`, `name`, `content`,
  `page`, `per_page`.
- `edit_zone_settings` takes an `items` array of `{id, value}` pairs.
- `purge_cache` takes optional `purge_everything`, `files`, `tags`,
  `hosts`, `prefixes`.
- `edit_dnssec` takes `status` (`"active"` or `"disabled"`).
- `import_records` takes `file` (BIND zone file content as string).
- `list_zones` takes no required args (account_id injected from binding).

### 5. Execute dispatcher (`src/execute.ts`)

`executeCall(fetchImpl, token, tool, args, accountId)` routes each of
the 15 tools to its Cloudflare REST endpoint via a switch/case.

Base URL : `https://api.cloudflare.com/client/v4`.

Auth headers built by `buildAuthHeaders(token)` :

- If `token` contains `|` : split into `email|key` and use
  `X-Auth-Email` + `X-Auth-Key` headers (Global API Key format).
- Otherwise : `Authorization: Bearer <token>` (API Token format).

HTTP methods :

- **GET** : query-string params via `toQueryString()`. No body.
- **POST / PATCH** : `Content-Type: application/json`, JSON body.
- **DELETE** : no body.
- **import_records** : special case using `callCloudflareMultipart()` --
  `multipart/form-data` with a `file` field containing the BIND content
  as a `Blob`.

`list_zones` injects `account.id=<accountId>` into the query string to
scope results to the binding's Cloudflare account.

### 6. Adapter (`src/cloudflare-dns-adapter.ts`)

Class `CloudflareDnsAdapter` -- paste-token mode, same pattern as
`ResendAdapter`.

`mintUpstreamToken(admin)` : decodes `admin.access_token_encrypted` via
`TextDecoder` and returns the raw token string with a far-future expiry
(1 year). Cloudflare API Tokens do not expire on their own.

`validateBinding(admin, resourceRef)` : calls
`GET /zones?account.id=<resourceRef>` with the decoded token. If the
response is OK, returns `{ ok: true, displayName }` where `displayName`
is the first zone's name (or the `resourceRef` as fallback). Supports
both Bearer and Global API Key auth detection.

`executeCall(admin, binding, tool, args)` : decodes the token, extracts
`accountId` from `binding.resource_ref`, and delegates to `execute.ts`.

`classifyV4(tool, args, bindings)` : delegates to
`classifyCloudflareDnsV4`.

Constructor accepts an optional `CloudflareDnsAdapterConfig` with
`fetchImpl` for test injection.

---

## Gateway wiring

### `build.ts` (l. 377-386)

```typescript
const cloudflareDnsAdapter = new CloudflareDnsAdapter();
upstreamByProvider['cloudflare-dns'] = {
  provider: 'cloudflare-dns',
  availableTools: cloudflareDnsAvailableTools,
  classifyV4: (tool, args, bindings) => cloudflareDnsAdapter.classifyV4(tool, args, bindings),
  executeCall: (admin, binding, tool, args) =>
    cloudflareDnsAdapter.executeCall(admin, binding, tool, args),
  loadProviderAdmin,
};
```

Same pattern as Resend/Upstash Redis : paste-token via
`provider_admins`, no `selfContained` flag (unlike Stripe).

### `catalog/route.ts`

`{ slug: 'cloudflare-dns', displayName: 'Cloudflare DNS', tools: cloudflareDnsAvailableTools }`
added to the `PROVIDERS` array exposed by `GET /api/v1/catalog`.

### `risk-catalog/loader.ts`

`cloudflareDnsRiskCatalog` imported from `@vaubaan/providers-cloudflare-dns`
and registered in `PROVIDER_CATALOGS['cloudflare-dns']`.

### `provider-info.ts`

Already registered with `kind: 'cloud'`, 1 plane `dns`, data model, and
catalog path.

### Zod enums (preview + mint)

`'cloudflare-dns'` already present in the `z.enum()` schemas in
`risk-preview.ts`, `tokens/preview/route.ts`, and `tokens/mint/route.ts`.

---

## Comment l'utiliser

### Setup d'un binding Cloudflare DNS

1. Create a Cloudflare API Token with `Zone:DNS:Edit` + `Zone:Zone:Read`
   permissions, scoped to the target account.
2. Add the API Token in `provider_admins` (via the UI or the API).
3. Create a binding with `provider: 'cloudflare-dns'` and
   `resource_ref` set to the Cloudflare **account_id**.

```json
{
  "provider": "cloudflare-dns",
  "resource_ref": "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
  "environment": "production"
}
```

### Mint d'un token

```bash
POST /api/v1/tokens/mint
{
  "projectSlug": "my-project",
  "bindings": [
    { "provider": "cloudflare-dns", "resource_ref": "1a2b3c4d...", "env": "production" }
  ],
  "accepted_risks": [
    "cloudflare-dns.read-zone-metadata",
    "cloudflare-dns.read-records",
    "cloudflare-dns.record-write"
  ]
}
```

### Appel d'un tool

```bash
POST /api/v1/tools/call
Authorization: Bearer vbn_live_...
{
  "tool": "cloudflare_dns__list_records",
  "args": {
    "zone_id": "abc123def456"
  }
}
```

---

## Comment debug

- **Symptome : "no cloudflare-dns binding is attached"** -- the token
  does not carry a binding `provider: 'cloudflare-dns'`. Check
  `provider_bindings` for the project and the token.

- **Symptome : "Cloudflare DNS ProviderAdmin has no access_token_encrypted"** --
  the `provider_admins` row for `cloudflare-dns` has a null
  `access_token_encrypted`. Re-paste the API Token.

- **Symptome : "Cloudflare API GET /zones 403"** -- the API Token lacks
  permissions or is revoked. Check the token in the Cloudflare dashboard.
  If using Global API Key format (`email|key`), verify the `|` separator
  and that both parts are correct.

- **Symptome : "Cloudflare validation failed (403)"** -- the
  `validateBinding` call failed. The `resource_ref` (account_id) may not
  match the token's account scope, or the token is invalid.

- **Symptome : multipart import fails** -- the `import_records` tool
  sends the BIND file as `multipart/form-data`. Check that the `file`
  arg contains valid BIND zone file syntax.

- **Logs de classification** -- the gateway audit trail records
  `slices_executed` and `risks_touched` for each call. Compare with the
  YAML patterns to understand which risk matched.

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

## Extension

### Ajouter un tool Cloudflare DNS

1. Add the `McpToolDeclaration` in `tools.ts` (section READ or WRITE).
2. Add the `case` in the switch of `execute.ts` with the REST endpoint.
3. Add the `case` in the switch of `risk-classifier.ts` with the slices.
4. Verify slices are covered by an existing risk or add a new risk in
   the YAML + TS.
5. Add unit tests in the 4 suites (tools count, classifier, execute,
   catalog coverage).

### Global API Key support

The `|` separator in the token string triggers Global API Key mode.
Format : `user@example.com|globalapikeyhere`. The adapter and execute
dispatcher both detect this and switch from `Authorization: Bearer` to
`X-Auth-Email` + `X-Auth-Key` headers.

---

## Reste a faire

- **Web UI binding form** -- Cloudflare API Token input.
- **Web UI token mint** -- risk list for Cloudflare DNS.
- **Adapter unit tests** -- test coverage for `CloudflareDnsAdapter`
  (mintUpstreamToken, validateBinding, executeCall delegation).
- **Execute unit tests** -- test coverage for the 15 tool dispatchers.

---

## References

- Spec : `docs/spec/gateway-risk-model.md`
- Research : `.vaubaan/research/providers/cloudflare-dns.md`
- Risk catalog YAML :
  [`packages/providers/cloudflare-dns/src/risk-catalog.yaml`](../../../packages/providers/cloudflare-dns/src/risk-catalog.yaml)
- Risk catalog TS :
  [`packages/providers/cloudflare-dns/src/risk-catalog.ts`](../../../packages/providers/cloudflare-dns/src/risk-catalog.ts)
- Resend handbook (runtime pattern reference) :
  [`./resend.md`](./resend.md)
