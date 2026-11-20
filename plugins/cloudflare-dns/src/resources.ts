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

import { PATH_IDENT, pathIdent } from '@vaubaan/plugin-sdk';
import type { Resource } from '@vaubaan/plugin-sdk';

import { SERVICE_ID, TOOL } from './identity.ts';

/** The SDK's path identifier grammar, re-exported for this plugin's modules. */
export { PATH_IDENT, pathIdent };

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
 * Which zone a call targets : the explicit `zone_id` argument, else the
 * mission's single Cloudflare DNS zone. Anything else is refused — never
 * mapped to a broad slice — and the refusal names the mission's zones.
 *
 * `zone_id` names one of the mission's zones by its id (the resource's ref,
 * matched as given) or by its DNS name (`zoneNameOf`, the name Cloudflare
 * listed at discovery). A DNS name is case-insensitive : both sides are read
 * by `dnsName` (lower case, no trailing dot) and must then be equal, so
 * `Example.COM.` names `example.com` and nothing else. A name that two zones
 * of the mission carry (the same domain in two accounts) is refused, asking
 * for the id. Whichever branch found it, the answer is the resource, whose
 * ref is path-safe (`pathIdent`) : it is the zone segment of the request
 * path and of the slice — the name given never reaches either.
 */
export function resolveZoneResource(
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ResolvedZone {
  const own = resources.filter((r) => r.service === SERVICE_ID);
  const explicit = args.zone_id;
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    const byRef = own.find((r) => r.ref === explicit);
    if (byRef !== undefined) return pathSafe(byRef);
    const name = dnsName(explicit);
    const byName = name === null ? [] : own.filter((r) => dnsName(zoneNameOf(r)) === name);
    if (byName.length === 1) return pathSafe(byName[0]!);
    if (byName.length > 1) {
      return {
        denied: `zone_id: ${byName.length} Cloudflare DNS zones of this mission are named '${name}' — name one by its id. ${missionZonesHint(own)}`,
      };
    }
    const zoneId = pathIdent(explicit);
    if (zoneId === null && name === null) return { denied: MALFORMED_ZONE_ID };
    return {
      denied: `zone_id: '${zoneId ?? name}' is not a Cloudflare DNS zone of this mission. ${missionZonesHint(own)}`,
    };
  }
  if (own.length === 1) return pathSafe(own[0]!);
  return {
    denied:
      own.length === 0
        ? 'zone_id: argument missing and the mission touches no Cloudflare DNS zone'
        : `zone_id: argument missing and the mission touches ${own.length} Cloudflare DNS zones — name one by its id or its name. ${missionZonesHint(own)}`,
  };
}

/** The resource, when its ref may be a path segment. */
function pathSafe(resource: Resource): ResolvedZone {
  return pathIdent(resource.ref) === null ? { denied: MALFORMED_ZONE_ID } : { resource };
}

/** Most zones a refusal names ; `list_zones` lists them all. */
const HINT_MAX_ZONES = 10;

/** The mission's zones, as a refusal names them : `name (id)`. */
function missionZonesHint(own: readonly Resource[]): string {
  if (own.length === 0) return 'The mission holds no Cloudflare DNS zone of this account.';
  const shown = own.slice(0, HINT_MAX_ZONES).map((r) => `${zoneNameOf(r) ?? '?'} (${r.ref})`);
  const more = own.length > HINT_MAX_ZONES ? `, and ${own.length - HINT_MAX_ZONES} more` : '';
  return `Zones of this mission: ${shown.join(', ')}${more} — ${TOOL.listZones} lists them.`;
}

/**
 * Is a record "critical" — apex (`example.com`, `@`), wildcard at the apex
 * (`*.example.com`, `*`), or of a critical type (MX, NS) ? Conservative :
 * a record is ordinary only when its type is a type name (`recordType`),
 * its name and the zone name are both DNS names (`dnsName`) and the two
 * differ. Anything the grammars do not read — `@`, a bare `*`, an empty
 * name, whitespace, a control or non-ASCII character (punycode is not
 * normalised here, so the two could never be compared), a separator, an
 * escape, an unknown zone name — is critical : the service may read as the
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
