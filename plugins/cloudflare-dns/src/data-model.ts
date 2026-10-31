/**
 * Cloudflare DNS data model — the entities a slice path can name.
 *
 * Spec : docs/spec/gateway-risk-model.md §2.
 *
 * One plane, `dns` : the zones a token reaches and the DNS management under
 * them (records, zone settings, DNSSEC, CDN cache, BIND import / export).
 * WAF, Workers, R2, Pages are out of scope. No entity is `envScopable` :
 * DNS has no test/live namespace, the owner may label zones but no catalog
 * risk is env-scoped.
 *
 * Synthetic entities exist for classification only :
 *   - `record.critical` — overlay emitted next to a record write when the
 *     record is apex, wildcard-at-apex, MX or NS ;
 *   - `record.delete`   — verb leaf of a record deletion ;
 *   - `zone-import` / `zone-export` — the BIND bulk endpoints, which are
 *     operations rather than queryable resources.
 */

import type { DataModel } from '@vaubaan/plugin-sdk';

import { PROVIDER_ID } from './identity.ts';

export const cloudflareDnsDataModel: DataModel = {
  provider: PROVIDER_ID,
  planes: [
    {
      slug: 'dns',
      description:
        'The only Cloudflare plane Vaubaan exposes — the zones reachable by the ' +
        'API token and all DNS management under them (records, zone settings, ' +
        'DNSSEC, CDN cache, BIND import/export). WAF, Workers, R2, Pages are out of scope.',
      entities: [
        {
          name: 'account',
          parent: null,
          cardinalities: ['one'],
          description:
            'The Cloudflare account a zone belongs to. Recorded in the resource ' +
            'metadata at discovery ; one token may reach zones of several accounts.',
        },
        {
          name: 'zone',
          parent: 'account',
          cardinalities: ['bounded'],
          description:
            'A DNS zone = one domain (example.com). One mission resource per zone ; ' +
            'the ref is the zone id every tool takes as `zone_id`.',
        },
        {
          name: 'record',
          parent: 'zone',
          cardinalities: ['unbounded'],
          description:
            'A DNS record (A, AAAA, CNAME, MX, TXT, SRV…). Unbounded — large zones ' +
            'hold thousands of records.',
        },
        {
          name: 'critical',
          parent: 'record',
          cardinalities: ['one'],
          description:
            'Synthetic overlay — the record is apex (name = zone, `@`), a wildcard at ' +
            'the apex (`*.zone`), or of type MX / NS. Emitted next to the record write ' +
            'so a mission accepts changes to the whole domain, mail routing or ' +
            'delegation distinctly from ordinary subdomain records.',
        },
        {
          name: 'delete',
          parent: 'record',
          cardinalities: ['one'],
          description:
            'Synthetic verb leaf — deletion of a record. Distinct from an update ' +
            'because the previous value is lost (no DNS versioning).',
        },
        {
          name: 'zone-settings',
          parent: 'zone',
          cardinalities: ['one'],
          description:
            'Singleton bag of zone configuration (SSL mode, minimum TLS version, ' +
            'cache level, always-HTTPS…). One settings object per zone.',
        },
        {
          name: 'dnssec',
          parent: 'zone',
          cardinalities: ['one'],
          description:
            'Singleton DNSSEC posture of the zone. Enabling / disabling toggles ' +
            'signing ; requires a matching DS record at the registrar.',
        },
        {
          name: 'cache',
          parent: 'zone',
          cardinalities: ['one'],
          description:
            'CDN cache layer of the zone (purge target) — purge everything, by URL, ' +
            'tag, host or prefix.',
        },
        {
          name: 'zone-import',
          parent: 'zone',
          cardinalities: ['one'],
          description:
            'Synthetic — BIND zone file import. Not a queryable resource ; the ' +
            'bulk endpoint that creates / updates hundreds of records in one call.',
        },
        {
          name: 'zone-export',
          parent: 'zone',
          cardinalities: ['one'],
          description:
            'Synthetic — BIND zone file export. The whole zone as one text dump : ' +
            'an atomic exfiltration vector, distinct from paginated record reads.',
        },
      ],
    },
  ],
};
