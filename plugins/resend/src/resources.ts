/**
 * Resend resources — one `Resource` per sending domain and one per segment.
 *
 * Spec : docs/spec/vaubaan-gateway.md §0 "Resource", §3.1 (resource selection
 *        per mission) ; docs/spec/gateway-risk-model.md §4.4 (env qualification).
 *
 * A Resend API key authenticates one account. Inside it, two kinds of things
 * are worth selecting per mission and labelling per environment :
 *
 *   - **domains** — the verified sending domains (`notifications.acme.com`).
 *     `ref` is the domain name ; `env` is the owner's label. A send is rooted
 *     at the domain of its `from` address, so `resend[prod].send-email-*`
 *     resolves through the default `resourceEnvResolver` (first ident = ref).
 *     The recipient-zone configuration (`internal_domains`,
 *     `allowlist_domains`, `allowlist_addresses`) lives in the domain
 *     resource's `metadata` : the owner edits it, the classifier reads it.
 *
 *   - **segments** — the contact lists broadcasts target (Resend renamed
 *     Audiences to Segments in November 2025 ; the Audiences API is
 *     deprecated). `ref` is the segment id ; every broadcast operation names
 *     its segment, so `resend[prod].broadcast-send` resolves the same way.
 *
 * Contacts are account-level in the current API (a contact belongs to zero or
 * more segments) and are not resources ; sent emails are not resources either.
 */

import type { Resource } from '@vaubaan/plugin-sdk';

export const RESEND_PROVIDER = 'resend';

/**
 * An identifier of the provider (the id of an email, a contact, a broadcast,
 * a segment or a domain — UUIDs upstream) : one path segment, no dot, no
 * separator, no escape. Every one of them lands in a slice **and** in the
 * request path, so one grammar serves both. A wider class is not safe for a
 * URL : `encodeURIComponent` leaves `.` and `..` untouched and every URL
 * parser then removes them, so `/emails/..` would be sent as `/`. Anything
 * outside the grammar is refused, never escaped.
 */
export const PATH_IDENT = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The value as a path-safe identifier, or `null`. The one check `classify`
 * and `execute` share : what is classified is what is sent.
 */
export function pathIdent(value: unknown): string | null {
  return typeof value === 'string' && PATH_IDENT.test(value) ? value : null;
}

/** One label of a host name : letters, digits and inner hyphens, 63 characters at most. */
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';

/**
 * A sending domain as the `domain` argument names it : dotted labels, 253
 * characters at most. It is matched against the mission's domain refs and
 * never reaches a request — the path carries the resource's `domain_id`.
 */
// nosemgrep: detect-redos -- linear: labels are joined by a literal separator the label class excludes (measured: 20 000 chars in < 1 ms)
export const DOMAIN_NAME = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})+$`, 'i');

/** The value as a domain ref (lower-cased), or `null`. Shared by `classify` and `execute`. */
export function domainName(value: unknown): string | null {
  return typeof value === 'string' && DOMAIN_NAME.test(value) ? domainRef(value) : null;
}

/**
 * An email address that names a contact in the request path : a bare
 * `local@domain` (no display name, no surrounding space) whose local part
 * holds letters, digits and `. _ + ' -` only — no separator, no
 * percent-escape, no query or fragment delimiter.
 */
// nosemgrep: detect-redos -- linear: labels are joined by a literal separator the label class excludes (measured: 20 000 chars in < 1 ms)
export const CONTACT_EMAIL = new RegExp(
  `^(?=.{3,254}$)[A-Za-z0-9._+'-]{1,64}@${LABEL}(?:\\.${LABEL})+$`,
  'i',
);

/** How a contact selector is sent (`segment`) and how the classifier names it (`ident`). */
export interface ContactSelector {
  /** The path segment, ready to interpolate. */
  readonly segment: string;
  /** The slice ident : the id itself, or the glob for a contact named by address. */
  readonly ident: string;
}

/**
 * A contact selector — a contact id or an email address — or `null`. Shared
 * by `classify` and `execute`. An id is interpolated as it is. An address is
 * percent-encoded into one segment : its `@` becomes `%40`, so the segment is
 * never a dot segment, and the grammar leaves no character that could end it.
 * An address is an unknown member for the classifier : the glob.
 */
export function contactSelector(value: unknown): ContactSelector | null {
  const id = pathIdent(value);
  if (id !== null) return { segment: id, ident: id };
  if (typeof value === 'string' && CONTACT_EMAIL.test(value)) {
    return { segment: encodeURIComponent(value), ident: '*' };
  }
  return null;
}

export const RESOURCE_KINDS = ['domain', 'segment'] as const;
export type ResendResourceKind = (typeof RESOURCE_KINDS)[number];

/** Recipient zones of a sending domain (metadata keys on the domain resource). */
export interface ZoneConfig {
  readonly internal_domains: readonly string[];
  readonly allowlist_domains: readonly string[];
  readonly allowlist_addresses: readonly string[];
}

export const EMPTY_ZONE_CONFIG: ZoneConfig = {
  internal_domains: [],
  allowlist_domains: [],
  allowlist_addresses: [],
};

/** The kind a resource carries ; `null` for a resource of another provider or without the marker. */
export function kindOf(resource: Resource): ResendResourceKind | null {
  if (resource.provider !== RESEND_PROVIDER) return null;
  const kind = resource.metadata?.kind;
  return kind === 'domain' || kind === 'segment' ? kind : null;
}

export function domainResources(resources: readonly Resource[]): Resource[] {
  return resources.filter((r) => kindOf(r) === 'domain');
}

export function segmentResources(resources: readonly Resource[]): Resource[] {
  return resources.filter((r) => kindOf(r) === 'segment');
}

/** `Notifications.Acme.com` → `notifications.acme.com` : refs are lower-case domain names. */
export function domainRef(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The zone configuration of a domain resource. Lists are lower-cased ; any
 * malformed or absent list is empty, so a freshly discovered domain classifies
 * every recipient as `external-unbounded` until the owner fills the lists.
 */
export function zoneConfigOf(resource: Resource): ZoneConfig {
  const raw = resource.metadata ?? {};
  return {
    internal_domains: stringList(raw.internal_domains),
    allowlist_domains: stringList(raw.allowlist_domains),
    allowlist_addresses: stringList(raw.allowlist_addresses),
  };
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

export type Resolved = { readonly resource: Resource } | { readonly denied: string };

/**
 * The sending-domain resource a `from` domain names. Exact match on the
 * verified domain or subdomain (Resend refuses a `from` on any other domain) ;
 * a domain outside the mission is refused, never widened.
 */
export function resolveDomain(fromDomain: string, resources: readonly Resource[]): Resolved {
  const ref = domainRef(fromDomain);
  const found = domainResources(resources).find((r) => r.ref === ref);
  return found
    ? { resource: found }
    : { denied: `from: '${ref}' is not a sending domain of this mission` };
}

/** The domain resource an explicit `domain` argument names (domain tools). */
export function resolveDomainArg(value: unknown, resources: readonly Resource[]): Resolved {
  const ref = domainName(value);
  if (ref === null) return { denied: 'domain: missing or malformed ref' };
  const found = domainResources(resources).find((r) => r.ref === ref);
  return found
    ? { resource: found }
    : { denied: `domain: '${ref}' is not a sending domain of this mission` };
}

/**
 * The segment resource an explicit `segment_id` argument names (segment,
 * contact and broadcast tools). The resolved ref is always a `pathIdent` : it
 * is a segment of the request path.
 */
export function resolveSegmentArg(value: unknown, resources: readonly Resource[]): Resolved {
  const ref = pathIdent(value);
  if (ref === null) return { denied: 'segment_id: missing or malformed ref' };
  const found = segmentResources(resources).find((r) => r.ref === ref);
  return found
    ? { resource: found }
    : { denied: `segment_id: '${ref}' is not a segment of this mission` };
}

export type ResolvedDomainId = { readonly id: string } | { readonly denied: string };

/**
 * The Resend id of a domain resource, from the metadata discovery wrote. It
 * is the domain segment of the request path, so it must be a `pathIdent` :
 * metadata is not an argument, but it is not trusted to be a path segment.
 */
export function domainIdOf(resource: Resource): ResolvedDomainId {
  const raw = resource.metadata?.domain_id;
  if (typeof raw !== 'string' || raw.length === 0) {
    return {
      denied: `resource '${resource.ref}' carries no domain_id — refresh the connection's resources`,
    };
  }
  const id = pathIdent(raw);
  return id === null
    ? { denied: `resource '${resource.ref}' carries a malformed domain_id` }
    : { id };
}
