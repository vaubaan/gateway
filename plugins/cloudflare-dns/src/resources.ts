/**
 * Cloudflare DNS resources — one `Resource` per zone.
 *
 * Spec : docs/spec/vaubaan-gateway.md §0 "Resource", §3.1 (resources per
 *        account) ; docs/spec/gateway-risk-model.md §2.
 *
 * A Cloudflare API token reaches N zones, possibly across accounts. The
 * account exposes **one resource per zone** : `ref` is the zone id (what
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

import { PROVIDER_ID } from './identity.ts';

/**
 * An identifier of the provider : exactly one path segment, no dot, no
 * separator, no escape. Cloudflare zone, record and account ids are 32 hex
 * characters. It is the grammar of every identifier of this plugin, whether
 * it is interpolated into a URL path (zone id, record id) or only embedded
 * in a slice (account id). `encodeURIComponent` leaves `.` and `..`
 * untouched and every URL parser then removes them, so `/dns_records/..`
 * would be sent as the zone endpoint itself.
 */
export const PATH_IDENT = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The value as a path-safe identifier, or `null`. The one check `classify`
 * and `execute` share for every identifier that reaches the request path
 * (zone id, record id) : what is classified is what is sent.
 */
export function pathIdent(value: unknown): string | null {
  return typeof value === 'string' && PATH_IDENT.test(value) ? value : null;
}

/** One label of a DNS name : letters, digits, `_` and inner hyphens, 63 characters at most. */
const DNS_LABEL = '[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?';

/**
 * A DNS name as a record or a zone carries it, once lower-cased and without
 * its trailing dots : dotted labels, an optional leading wildcard label
 * (`*.dev.example.com`), 253 characters at most. Service labels
 * (`_dmarc`, `_sip._tcp`) and punycode (`xn--…`) are names ; `@`, a bare
 * `*`, an inner wildcard, an empty label, whitespace, a control or non-ASCII
 * character, a separator or an escape are not.
 */
// nosemgrep: detect-redos -- linear: labels are joined by a literal separator the label class excludes (measured: 20 000 chars in < 1 ms)
export const DNS_NAME = new RegExp(`^(?=.{1,253}$)(?:\\*\\.)?${DNS_LABEL}(?:\\.${DNS_LABEL})*$`);

/**
 * The value as a normalised DNS name (lower case, no trailing dot), or
 * `null`. The one reading of a record name and of a zone name : two names
 * are compared only when both are names. A record name never reaches a URL
 * path — it travels in the JSON body, or percent-encoded in a query string.
 */
export function dnsName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.toLowerCase().replace(/\.+$/, '');
  return DNS_NAME.test(name) ? name : null;
}

/** A record type name (`A`, `AAAA`, `CNAME`, `HTTPS`…) : ASCII letters and digits only. */
export const RECORD_TYPE = /^[A-Za-z][A-Za-z0-9]{0,15}$/;

/** The value as an upper-cased record type, or `null`. ASCII only : no case folding from another script. */
export function recordType(value: unknown): string | null {
  return typeof value === 'string' && RECORD_TYPE.test(value) ? value.toUpperCase() : null;
}

/**
 * Record types whose change affects the whole domain whatever the name :
 * mail routing (MX) and delegation (NS). Together with apex and wildcard
 * names they form the "critical record" overlay of the catalog.
 */
export const CRITICAL_RECORD_TYPES: ReadonlySet<string> = new Set(['MX', 'NS']);

export type RecordSensitivity = 'critical' | 'regular';

export type ResolvedZone = { readonly resource: Resource } | { readonly denied: string };

const MALFORMED_ZONE_ID = 'zone_id: malformed zone id';

function metadataString(resource: Resource, key: string): string | null {
  const value = resource.metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The Cloudflare account id a zone belongs to, when discovery recorded one
 * that is an identifier (`pathIdent`) ; `null` otherwise, which the
 * classifier turns into the glob.
 */
export function accountIdOf(resource: Resource): string | null {
  return pathIdent(metadataString(resource, 'account_id'));
}

/** The zone name (`example.com`), from discovery metadata or the display name. */
export function zoneNameOf(resource: Resource): string | null {
  return metadataString(resource, 'zone_name') ?? (resource.displayName || null);
}

/**
 * Which zone a call targets : the explicit `zone_id` argument (a ref listed
 * in the mission), else the mission's single Cloudflare DNS zone. Anything
 * else is refused — never mapped to a broad slice. The resolved ref is
 * always path-safe (`pathIdent`), whichever branch found it : it is the
 * zone segment of the request path.
 */
export function resolveZoneResource(
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ResolvedZone {
  const own = resources.filter((r) => r.provider === PROVIDER_ID);
  const explicit = args.zone_id;
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    const zoneId = pathIdent(explicit);
    if (zoneId === null) return { denied: MALFORMED_ZONE_ID };
    const found = own.find((r) => r.ref === zoneId);
    return found
      ? { resource: found }
      : { denied: `zone_id: '${zoneId}' is not a Cloudflare DNS zone of this mission` };
  }
  if (own.length === 1) {
    const only = own[0]!;
    return pathIdent(only.ref) === null ? { denied: MALFORMED_ZONE_ID } : { resource: only };
  }
  return {
    denied:
      own.length === 0
        ? 'zone_id: argument missing and the mission touches no Cloudflare DNS zone'
        : `zone_id: argument missing and the mission touches ${own.length} Cloudflare DNS zones — name one`,
  };
}

/**
 * Is a record "critical" — apex (`example.com`, `@`), wildcard at the apex
 * (`*.example.com`, `*`), or of a critical type (MX, NS) ? Conservative :
 * a record is ordinary only when its type is a type name (`recordType`),
 * its name and the zone name are both DNS names (`dnsName`) and the two
 * differ. Anything the grammars do not read — `@`, a bare `*`, an empty
 * name, whitespace, a control or non-ASCII character (punycode is not
 * normalised here, so the two could never be compared), a separator, an
 * escape, an unknown zone name — is critical : the provider may read as the
 * apex a name this function cannot compare with it.
 */
export function isCriticalRecord(type: string, name: string, zoneName: string | null): boolean {
  const t = recordType(type);
  if (t === null || CRITICAL_RECORD_TYPES.has(t)) return true;
  const n = dnsName(name);
  if (n === null) return true;
  const z = dnsName(zoneName);
  if (z === null) return true;
  return n === z || n === `*.${z}`;
}

/**
 * The sensitivity a record write declares through its arguments. `type`
 * and `name` must both be strings for the write to count as regular ;
 * anything else is classified critical, so an under-specified update or
 * deletion can never slip past the critical-record risk.
 */
export function recordSensitivity(
  args: Readonly<Record<string, unknown>>,
  zoneName: string | null,
): RecordSensitivity {
  const { type, name } = args;
  if (typeof type !== 'string' || typeof name !== 'string') return 'critical';
  return isCriticalRecord(type, name, zoneName) ? 'critical' : 'regular';
}
