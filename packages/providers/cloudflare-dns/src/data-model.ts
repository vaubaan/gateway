/**
 * Cloudflare DNS data-model — declarative entity graph for the v4 risk-based engine.
 *
 * Spec     : docs/spec/gateway-risk-model.md §2.
 * Research : .vaubaan/research/providers/cloudflare-dns.md §1.
 *
 * Cloudflare DNS exposes a single plane (`dns`) — the authenticated
 * Cloudflare account and all the DNS resources under it (zones, records,
 * zone settings, DNSSEC, cache, import/export). The data-model is simpler
 * than Stripe or Gmail : 8 entities, no envScopable (DNS has no test/live
 * mode), no synthetic overlays.
 *
 * The binding's `resource_ref` is the Cloudflare **account_id** — one
 * API Token may cover N zones under that account. Auth is Bearer token
 * only (no OAuth at MVP).
 *
 * Two entities encode operations that Cloudflare's REST surface exposes
 * as distinct endpoints but are conceptually singleton per zone :
 *
 *   - `zone-import` : BIND zone file bulk import (POST). Not a queryable
 *     resource — it's a one-shot operation that creates/updates records.
 *
 *   - `zone-export` : BIND zone file export (GET). Returns the full zone
 *     as a single BIND-format string. Distinct from paginated record
 *     reads because it's atomic exfiltration of ALL records.
 *
 * Cardinalities follow the research table §1.2 verbatim. No entity has
 * `envScopable: true` — DNS has no parallel test/live namespaces.
 *
 * This data-model is the canonical source for :
 *   - the mermaid diagram rendered into the handbook (handbook §1.1),
 *   - the catalog's `matches` patterns (each pattern refers to entity slugs
 *     declared here — verified by the catalog-coverage lint),
 *   - the lint that every MCP tool exposed by this provider classifies into
 *     at least one slice rooted at a declared entity.
 */

import type { DataModel } from '@vaubaan/shared';

export const dataModel: DataModel = {
  provider: 'cloudflare-dns',
  planes: [
    {
      slug: 'dns',
      description:
        'The only Cloudflare plane Vaubaan exposes at MVP — the authenticated ' +
        'Cloudflare account and all DNS management under it (zones, records, ' +
        'zone settings, DNSSEC, CDN cache, BIND import/export). WAF, Workers, ' +
        'R2, Pages, etc. are out of scope.',
      entities: [
        {
          name: 'account',
          parent: null,
          cardinalities: ['one'],
          description:
            'The Cloudflare account backing the API Token used by Vaubaan. ' +
            'Singleton per binding (one binding = one Cloudflare account_id).',
        },
        {
          name: 'zone',
          parent: 'account',
          cardinalities: ['bounded'],
          description:
            'A DNS zone = one domain (e.g. example.com). Bounded — a typical ' +
            'Cloudflare account has a few dozen zones.',
        },
        {
          name: 'record',
          parent: 'zone',
          cardinalities: ['unbounded'],
          description:
            'A DNS record (A, AAAA, CNAME, MX, TXT, SRV, etc.). Unbounded — ' +
            'large zones can have thousands of records.',
        },
        {
          name: 'zone-settings',
          parent: 'zone',
          cardinalities: ['one'],
          description:
            'Singleton bag of zone configuration (SSL mode, minimum TLS version, ' +
            'cache level, always-HTTPS, etc.). One settings object per zone.',
        },
        {
          name: 'dnssec',
          parent: 'zone',
          cardinalities: ['one'],
          description:
            'Singleton DNSSEC posture for the zone. Enable/disable toggles the ' +
            'DNSSEC signing. Requires matching DS record at the registrar.',
        },
        {
          name: 'cache',
          parent: 'zone',
          cardinalities: ['one'],
          description:
            'CDN cache layer for the zone (purge target). Purge operations hit ' +
            'this entity — purge_everything, purge by URL/tag/host/prefix.',
        },
        {
          name: 'zone-import',
          parent: 'zone',
          cardinalities: ['one'],
          description:
            'Synthetic — BIND zone file import operation. Not a queryable ' +
            'resource ; represents the bulk-import endpoint that creates/updates ' +
            'potentially hundreds of records in one call.',
        },
        {
          name: 'zone-export',
          parent: 'zone',
          cardinalities: ['one'],
          description:
            'Synthetic — BIND zone file export operation. Returns the full zone ' +
            'as a single BIND-format text dump. Atomic exfiltration vector — ' +
            'distinct from paginated record reads.',
        },
      ],
    },
  ],
};
