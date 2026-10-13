/**
 * Recipient zoning — pure helpers shared by the classifier and `describe_zones`.
 *
 * Spec : docs/spec/resend.md §4 (identity-zoning on the recipient axis).
 *
 * A send is classified by *who the email goes to* : every recipient of
 * `to` + `cc` + `bcc` falls into one zone, and the call takes the worst zone
 * across all of them (one external recipient among twenty internal ones makes
 * the call `external-unbounded`). Zones come from the sending domain's
 * resource metadata :
 *
 *   internal            recipient domain ∈ internal_domains
 *   allowlist           recipient address ∈ allowlist_addresses, or domain ∈ allowlist_domains
 *   external-unbounded  anything else — the cardinal exfiltration vector
 *
 * Addresses are parsed, not string-sliced : `"Alice <alice@acme.com>"` is
 * `alice@acme.com`. An address that does not parse is reported as malformed
 * so the classifier refuses the call instead of guessing a zone.
 */

import type { ZoneConfig } from './resources.ts';

export const TO_ZONES = ['internal', 'allowlist', 'external-unbounded'] as const;
export type ToZone = (typeof TO_ZONES)[number];

export const RECIPIENT_COUNTS = ['single', 'multi', 'batch'] as const;
export type RecipientCount = (typeof RECIPIENT_COUNTS)[number];

/** Worst case wins : the higher the rank, the more permissive the zone. */
const ZONE_RANK: Readonly<Record<ToZone, number>> = {
  internal: 0,
  allowlist: 1,
  'external-unbounded': 2,
};

export interface EmailAddress {
  /** Lower-cased `local@domain`. */
  readonly address: string;
  /** Lower-cased domain part. */
  readonly domain: string;
}

// RFC 5322 is far wider ; this accepts what Resend accepts in practice and
// rejects anything with whitespace, brackets or a missing domain label.
const ADDRESS =
  /^[^\s<>@"]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
const ANGLE_FORM = /^[^<>]*<([^<>]+)>$/;

/** `"Acme <noreply@acme.com>"` or `noreply@acme.com` → the address ; `null` when malformed. */
export function parseAddress(value: unknown): EmailAddress | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const angle = ANGLE_FORM.exec(trimmed);
  const bare = (angle ? angle[1]! : trimmed).trim();
  if (!ADDRESS.test(bare)) return null;
  const address = bare.toLowerCase();
  return { address, domain: address.slice(address.lastIndexOf('@') + 1) };
}

export type RecipientsOutcome =
  | { readonly recipients: readonly EmailAddress[] }
  | { readonly denied: string };

/**
 * The union of `to`, `cc` and `bcc` (each a string or a list of strings).
 * Refuses a field of another shape or an address that does not parse.
 */
export function collectRecipients(args: Readonly<Record<string, unknown>>): RecipientsOutcome {
  const out: EmailAddress[] = [];
  for (const field of ['to', 'cc', 'bcc'] as const) {
    const value = args[field];
    if (value === undefined || value === null) continue;
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      const parsed = parseAddress(item);
      if (!parsed) return { denied: `${field}: malformed address '${String(item)}'` };
      out.push(parsed);
    }
  }
  return { recipients: out };
}

export function zoneOfAddress(recipient: EmailAddress, config: ZoneConfig): ToZone {
  if (config.internal_domains.includes(recipient.domain)) return 'internal';
  if (config.allowlist_addresses.includes(recipient.address)) return 'allowlist';
  if (config.allowlist_domains.includes(recipient.domain)) return 'allowlist';
  return 'external-unbounded';
}

/** Worst zone across the recipients ; `internal` for an empty list (callers refuse empty sends). */
export function worstZone(recipients: readonly EmailAddress[], config: ZoneConfig): ToZone {
  let worst: ToZone = 'internal';
  for (const recipient of recipients) {
    const zone = zoneOfAddress(recipient, config);
    if (ZONE_RANK[zone] > ZONE_RANK[worst]) worst = zone;
    if (worst === 'external-unbounded') break;
  }
  return worst;
}

export function recipientCountOf(recipients: readonly EmailAddress[]): RecipientCount {
  return recipients.length === 1 ? 'single' : 'multi';
}
