/**
 * Cloudflare DNS resources — one `Resource` per zone.
 *
 * Spec : docs/spec/vaubaan-gateway.md §0 "Resource", §3.1 (resources per
 *        connection) ; docs/spec/gateway-risk-model.md §2.
 *
 * A Cloudflare API token reaches N zones, possibly across accounts. The
 * connection exposes **one resource per zone** : `ref` is the zone id (what
 * every tool takes as `zone_id`), `displayName` the zone name, and
 * `metadata` carries the non-secret facts the classifier needs :
 *   - `account_id`  → the `account[…]` segment of every slice ;
 *   - `zone_name`   → tells an apex record (`example.com`, `@`) from a
 *                     subdomain record (`www.example.com`).
 *
 * DNS has no test/live mode : no resource carries an `env` at discovery ;
 * the owner may label zones later, but no catalog risk is env-scoped.
 */

import type { Resource } from '@vaubaan/plugin-sdk';

export const CLOUDFLARE_DNS_PROVIDER = 'cloudflare-dns';

/** Identifier chars a slice segment accepts ; anything else is refused rather than escaped. */
export const SAFE_IDENT = /^[a-zA-Z0-9_./~-]+$/;

/**
 * Record types whose change affects the whole domain whatever the name :
 * mail routing (MX) and delegation (NS). Together with apex and wildcard
 * names they form the "critical record" overlay of the catalog.
 */
export const CRITICAL_RECORD_TYPES: ReadonlySet<string> = new Set(['MX', 'NS']);

export type RecordSensitivity = 'critical' | 'regular';

export type ResolvedZone = { readonly resource: Resource } | { readonly denied: string };

function metadataString(resource: Resource, key: string): string | null {
  const value = resource.metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The Cloudflare account id a zone belongs to, when discovery recorded it. */
export function accountIdOf(resource: Resource): string | null {
  const id = metadataString(resource, 'account_id');
  return id !== null && SAFE_IDENT.test(id) ? id : null;
}

/** The zone name (`example.com`), from discovery metadata or the display name. */
export function zoneNameOf(resource: Resource): string | null {
  return metadataString(resource, 'zone_name') ?? (resource.displayName || null);
}

/**
 * Which zone a call targets : the explicit `zone_id` argument (a ref listed
 * in the mission), else the mission's single Cloudflare DNS zone. Anything
 * else is refused — never mapped to a broad slice.
 */
export function resolveZoneResource(
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ResolvedZone {
  const own = resources.filter((r) => r.provider === CLOUDFLARE_DNS_PROVIDER);
  const explicit = args.zone_id;
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    if (typeof explicit !== 'string' || !SAFE_IDENT.test(explicit)) {
      return { denied: 'zone_id: malformed zone id' };
    }
    const found = own.find((r) => r.ref === explicit);
    return found
      ? { resource: found }
      : { denied: `zone_id: '${explicit}' is not a Cloudflare DNS zone of this mission` };
  }
  if (own.length === 1) return { resource: own[0]! };
  return {
    denied:
      own.length === 0
        ? 'zone_id: argument missing and the mission touches no Cloudflare DNS zone'
        : `zone_id: argument missing and the mission touches ${own.length} Cloudflare DNS zones — name one`,
  };
}

function normalizeDnsName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Is a record "critical" — apex (`example.com`, `@`), wildcard at the apex
 * (`*.example.com`, `*`), or of a critical type (MX, NS) ? Conservative :
 * when the zone name is unknown, when the name is empty, or when it carries
 * non-ASCII characters (punycode is not normalised here), the record is
 * treated as critical.
 */
export function isCriticalRecord(type: string, name: string, zoneName: string | null): boolean {
  if (CRITICAL_RECORD_TYPES.has(type.trim().toUpperCase())) return true;
  const n = normalizeDnsName(name);
  if (n === '' || n === '@' || n === '*') return true;
  if (/[^\x20-\x7e]/.test(n)) return true;
  if (zoneName === null) return true;
  const z = normalizeDnsName(zoneName);
  return n === z || n === `*.${z}`;
}

/**
 * The sensitivity a record write declares through its arguments. `type`
 * and `name` must both be strings for the write to count as regular ;
 * anything else is classified critical, so an under-specified update can
 * never slip past the critical-record risk.
 */
export function recordSensitivity(
  args: Readonly<Record<string, unknown>>,
  zoneName: string | null,
): RecordSensitivity {
  const { type, name } = args;
  if (typeof type !== 'string' || typeof name !== 'string') return 'critical';
  return isCriticalRecord(type, name, zoneName) ? 'critical' : 'regular';
}
