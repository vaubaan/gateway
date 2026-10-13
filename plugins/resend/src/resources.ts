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

/** Identifier chars a slice segment accepts ; anything else is refused rather than escaped. */
export const SAFE_IDENT = /^[a-zA-Z0-9_./~-]+$/;

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
  if (typeof value !== 'string' || !SAFE_IDENT.test(value)) {
    return { denied: 'domain: missing or malformed ref' };
  }
  const ref = domainRef(value);
  const found = domainResources(resources).find((r) => r.ref === ref);
  return found
    ? { resource: found }
    : { denied: `domain: '${ref}' is not a sending domain of this mission` };
}

/** The segment resource an explicit `segment_id` argument names (segment, contact and broadcast tools). */
export function resolveSegmentArg(value: unknown, resources: readonly Resource[]): Resolved {
  if (typeof value !== 'string' || !SAFE_IDENT.test(value)) {
    return { denied: 'segment_id: missing or malformed ref' };
  }
  const found = segmentResources(resources).find((r) => r.ref === value);
  return found
    ? { resource: found }
    : { denied: `segment_id: '${value}' is not a segment of this mission` };
}
