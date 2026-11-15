/**
 * Zones of the `outlook` classifier — Gmail's rules (`plugins/gmail/src/classify.ts`),
 * read from the mailbox resource's owner-edited metadata. Pure.
 *
 * Handbook : docs/handbook/services/outlook.md ("Zones").
 *
 *   from-zone  automated | internal | known-external | unknown   (who sent what is read)
 *   to-zone    self | internal | allowlist                       (who a draft is for)
 *   send-zone  self | internal | allowlist | external-unbounded  (who a send reaches)
 *   guests     internal | external                               (who an event invites)
 */

import type { Resource } from '@vaubaan/plugin-sdk';

import type { EmailAddress } from './address.ts';

export type FromZone = 'automated' | 'internal' | 'known-external' | 'unknown';
export type ToZone = 'self' | 'internal' | 'allowlist' | 'external-unbounded';
export type GuestZone = 'internal' | 'external';

/** The facts the classifier reads from `Resource.metadata` (lists the owner edits). */
export interface MailboxMetadata {
  readonly internal_domains: readonly string[];
  readonly allowlist_domains: readonly string[];
  readonly allowlist_addresses: readonly string[];
  /** The account's own address; drives `self`. */
  readonly account_email: string | null;
}

/** Keys of `Resource.metadata` the classifier reads. */
export const MAILBOX_METADATA_KEYS = [
  'account_email',
  'internal_domains',
  'allowlist_domains',
  'allowlist_addresses',
] as const;

/**
 * Local parts that make a sender `automated` — only on an internal or
 * allowlisted domain (or an allowlisted address): on any other domain the
 * local part is the sender's choice and decides nothing.
 */
const AUTOMATED_LOCAL_PARTS: ReadonlySet<string> = new Set([
  'no-reply',
  'noreply',
  'do-not-reply',
  'donotreply',
  'notifications',
  'alerts',
  'support',
]);

function strings(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase())
    : [];
}

/** The zoning lists of a mailbox resource; missing or ill-typed lists are empty. */
export function readMailboxMetadata(resource: Resource): MailboxMetadata {
  const raw: Readonly<Record<string, unknown>> = resource.metadata ?? {};
  return {
    internal_domains: strings(raw.internal_domains),
    allowlist_domains: strings(raw.allowlist_domains),
    allowlist_addresses: strings(raw.allowlist_addresses),
    account_email:
      typeof raw.account_email === 'string' && raw.account_email.includes('@')
        ? raw.account_email.toLowerCase()
        : null,
  };
}

export function fromZoneOf(sender: EmailAddress, md: MailboxMetadata): FromZone {
  const internal = md.internal_domains.includes(sender.domain);
  const known =
    md.allowlist_domains.includes(sender.domain) || md.allowlist_addresses.includes(sender.address);
  if ((internal || known) && AUTOMATED_LOCAL_PARTS.has(sender.local)) return 'automated';
  if (internal) return 'internal';
  if (known) return 'known-external';
  return 'unknown';
}

const TO_ZONE_RANK: Readonly<Record<ToZone, number>> = {
  self: 0,
  internal: 1,
  allowlist: 2,
  'external-unbounded': 3,
};

function toZoneOf(recipient: EmailAddress, md: MailboxMetadata): ToZone {
  if (md.account_email !== null && recipient.address === md.account_email) return 'self';
  if (md.internal_domains.includes(recipient.domain)) return 'internal';
  if (md.allowlist_addresses.includes(recipient.address)) return 'allowlist';
  if (md.allowlist_domains.includes(recipient.domain)) return 'allowlist';
  return 'external-unbounded';
}

/** The worst zone of a recipient set; `self` when it is empty. */
export function worstToZone(recipients: readonly EmailAddress[], md: MailboxMetadata): ToZone {
  let worst: ToZone = 'self';
  for (const recipient of recipients) {
    const zone = toZoneOf(recipient, md);
    if (TO_ZONE_RANK[zone] > TO_ZONE_RANK[worst]) worst = zone;
  }
  return worst;
}

/**
 * The zone of one person invited to an event: `null` for the account itself
 * (it reaches nobody), `internal` on an internal domain of the mailbox
 * (meeting rooms of the tenant included), `external` otherwise.
 */
export function guestZoneOf(person: EmailAddress, md: MailboxMetadata): GuestZone | null {
  if (md.account_email !== null && person.address === md.account_email) return null;
  return md.internal_domains.includes(person.domain) ? 'internal' : 'external';
}
