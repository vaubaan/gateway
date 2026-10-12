/**
 * Cloudflare DNS — risk catalog (TS export, 1:1 with `risk-catalog.yaml`).
 *
 * Source of truth : `.vaubaan/research/providers/cloudflare-dns.md` §3.
 * Spec           : `docs/spec/gateway-risk-model.md` §4.
 *
 * The YAML sibling is the canonical reviewable form ; this TS module is what
 * the runtime imports (no YAML dep at runtime — Vercel does not bundle
 * `.yaml` files in the Lambda). Keep both in sync — a CI test in
 * `tests/unit/risk-catalog-sync.test.ts` diffs the two structures.
 *
 * 10 named risks + 1 fallback = 11 total. RiskId format follows
 * `<provider>.<name>` (cf. shared/src/risk.ts RISK_ID_REGEX).
 *
 * No envScopable — DNS has no test/live mode. No caps, no infra_limits,
 * no acceptable_in_envs, no vector_overrides at MVP.
 *
 * Slice patterns use the DSL declared in policy-engine/src/slice-dsl.ts.
 */

import type { RiskCatalog } from '@vaubaan/shared';

export const cloudflareDnsRiskCatalog: RiskCatalog = {
  provider: 'cloudflare-dns',
  risks: [
    // ─── READS ─────────────────────────────────────────────────────────────
    {
      id: 'cloudflare-dns.read-zone-metadata',
      label: 'Read zone and account metadata',
      reason:
        'Inventory of zones, status, nameservers, plan. Metadata only, no ' +
        'secrets, no detailed DNS config.',
      matches: [
        'cloudflare-dns.account[**].zone[**].R',
        'cloudflare-dns.account[**].zone[**].zone-settings.R',
        'cloudflare-dns.account[**].zone[**].dnssec.R',
      ],
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'metadata',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
    },
    {
      id: 'cloudflare-dns.read-records',
      label: 'Read DNS records (IPs, CNAMEs, MX, TXT values)',
      reason:
        'Exposes full network topology (server IPs, MX relays, SPF/DKIM/DMARC ' +
        'config, ACME challenges). Reconnaissance surface for an attacker.',
      matches: 'cloudflare-dns.account[**].zone[**].record[**].R',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
    },
    {
      id: 'cloudflare-dns.export-zone-file',
      label: 'Export full zone as BIND file (all records in one dump)',
      reason:
        'Atomic export of ALL records in BIND format — complete DNS topology ' +
        'in a single request. Distinct from read-records (paginated) because ' +
        'export is a single bulk exfiltration vector.',
      matches: 'cloudflare-dns.account[**].zone[**].zone-export.R',
      vector: {
        reversibility: 'reversible',
        blast: 'account',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
    },

    // ─── WRITES — DNS RECORDS ──────────────────────────────────────────────
    {
      id: 'cloudflare-dns.record-write',
      label: 'Create / update / delete a DNS record',
      reason:
        'Posture-shift on a single DNS record. A modified A/CNAME redirects ' +
        'traffic; a modified TXT invalidates SPF/DKIM (email) or ACME (SSL). ' +
        'Costly because rollback requires knowing the previous value (no DNS ' +
        'versioning). Public by nature (DNS resolution is public).',
      matches: 'cloudflare-dns.account[**].zone[**].record[**].W',
      vector: {
        reversibility: 'costly',
        blast: 'env',
        data: 'metadata',
        cost: 'free',
        visibility: 'public',
        persistence: 'posture',
      },
    },
    {
      id: 'cloudflare-dns.import-records',
      label: 'Bulk import DNS records from BIND zone file',
      reason:
        'BIND import creates/updates potentially hundreds of records in one ' +
        'call. Higher blast than single record-write. Non-atomic (partial ' +
        'import on error). Rate-limited upstream at 3 req/min.',
      matches: 'cloudflare-dns.account[**].zone[**].zone-import.W',
      vector: {
        reversibility: 'costly',
        blast: 'bulk',
        data: 'metadata',
        cost: 'free',
        visibility: 'public',
        persistence: 'posture',
      },
    },

    // ─── WRITES — ZONE SETTINGS ────────────────────────────────────────────
    {
      id: 'cloudflare-dns.zone-settings-write',
      label: 'Edit zone settings (SSL, TLS version, cache level, etc.)',
      reason:
        'Modifies zone security posture. Lowering min_tls to 1.0 re-enables ' +
        'known vulnerabilities; changing SSL mode from Full(Strict) to ' +
        'Flexible opens to MITM.',
      matches: 'cloudflare-dns.account[**].zone[**].zone-settings.W',
      vector: {
        reversibility: 'costly',
        blast: 'account',
        data: 'metadata',
        cost: 'free',
        visibility: 'public',
        persistence: 'posture',
      },
    },
    {
      id: 'cloudflare-dns.dnssec-write',
      label: 'Enable / disable DNSSEC on a zone',
      reason:
        'Toggling DNSSEC without matching DS records at the registrar breaks ' +
        'resolution (SERVFAIL for validating resolvers). Zone-wide security ' +
        'posture shift.',
      matches: 'cloudflare-dns.account[**].zone[**].dnssec.W',
      vector: {
        reversibility: 'costly',
        blast: 'account',
        data: 'metadata',
        cost: 'free',
        visibility: 'public',
        persistence: 'posture',
      },
    },

    // ─── WRITES — CACHE PURGE ──────────────────────────────────────────────
    {
      id: 'cloudflare-dns.cache-purge',
      label: 'Purge CDN cache (all, by URL, by tag, by host, by prefix)',
      reason:
        'A purge_everything forces all requests to hit origin — potential ' +
        'self-inflicted DDoS on high-traffic sites. Reversible (cache ' +
        'rebuilds) but immediate performance cost.',
      matches: 'cloudflare-dns.account[**].zone[**].cache.W',
      vector: {
        reversibility: 'reversible',
        blast: 'account',
        data: 'metadata',
        cost: 'moderate',
        visibility: 'public',
        persistence: 'session',
      },
    },

    // ─── WRITES — ZONE DELETE ──────────────────────────────────────────────
    {
      id: 'cloudflare-dns.zone-delete',
      label: 'Delete an entire DNS zone (domain stops resolving)',
      reason:
        'Deletes the entire DNS zone. Domain immediately stops resolving. ' +
        'All records, settings, DNSSEC config lost. Irreversible in practice ' +
        '— requires recreating zone and reimporting all records.',
      matches: 'cloudflare-dns.account[**].zone[**].W',
      vector: {
        reversibility: 'irreversible',
        blast: 'account',
        data: 'data',
        cost: 'moderate',
        visibility: 'public',
        persistence: 'posture',
      },
    },

    // ─── FALLBACK (required) ───────────────────────────────────────────────
    {
      id: 'cloudflare-dns.uncategorized-write',
      label: 'Uncategorized Cloudflare DNS write',
      reason:
        'Catch-all for uncategorized writes. Future tools (create_zone, ' +
        'batch_records, delete_dnssec) fall here until a dedicated risk is ' +
        'added — fail-loud by design.',
      matches: 'cloudflare-dns.[**].W',
      vector: {
        reversibility: 'costly',
        blast: 'account',
        data: 'data',
        cost: 'moderate',
        visibility: 'public',
        persistence: 'posture',
      },
    },
  ],
};
