/**
 * Classifier of the `gmail` provider : `(tool, args, resources) → slices`.
 *
 * Spec : docs/spec/gateway-risk-model.md §3, §7 ; docs/spec/vaubaan-gateway.md §10
 *        ("a classification error is a security hole").
 * Handbook : docs/handbook/providers/gmail.md.
 *
 * Pure : no IO, no credential, no `Date`. Gmail zones by **identity**, not by
 * containment : the risk of a read depends on the sender's domain, the risk
 * of a draft on its recipients. The classifier computes a *zone* by matching
 * addresses against the mailbox resource's `metadata` (owner-edited lists)
 * and emits synthetic marker slices (`from-zone[z]`, `to-zone[z]`,
 * `bulk-marker`, `sensitive-label[l]`) the catalog matches.
 *
 * Modelling rules (handbook §4) :
 *
 *   1. `get_thread` is classified worst-case `from-zone[unknown]` : the sender
 *      is unknown until the thread is fetched. Agents search first.
 *   2. A `search_threads` query with neither `from:` nor `to:` nor `label:`
 *      is non-discriminating → `bulk-marker.R` plus `from-zone[unknown].R`.
 *   3. A well-known no-reply local part (`no-reply@myorg.com`) is `automated`
 *      before being `internal`.
 *   4. A `label:` clause naming a sensitive label adds `sensitive-label[l].R`
 *      whatever the sender.
 *   5. The to-zone of a draft is the *worst* of its recipients ; any address
 *      outside internal domains and allowlists is `external-unbounded`.
 *   6. One mission, one mailbox : zero gmail resources is denied, two or more
 *      is denied as ambiguous (no argument selects a mailbox today).
 */

import type { ClassifyOutcome, Resource, Slice, SliceSegment } from '@vaubaan/plugin-sdk';

import { parseQ, type QParsed } from './q-parser.ts';
import { GMAIL_CLASSIFIED_TOOLS } from './tools.ts';

// ─── Zone names ────────────────────────────────────────────────────────────

export type FromZone = 'automated' | 'internal' | 'known-external' | 'unknown';
export type ToZone = 'self' | 'internal' | 'allowlist' | 'external-unbounded';

// ─── Mailbox metadata (owner-edited, on the Resource) ─────────────────────

/** The non-secret facts the classifier reads from `Resource.metadata`. */
export interface GmailMailboxMetadata {
  /** Domains considered internal — senders and recipients there are `internal`. */
  readonly internal_domains: readonly string[];
  /** Addresses considered known-external (reads) / allowlist (drafts). */
  readonly allowlist_addresses: readonly string[];
  /** Domains considered known-external (reads) / allowlist (drafts). */
  readonly allowlist_domains: readonly string[];
  /** Labels the owner declared sensitive (`FINANCIAL`, `LEGAL`, `HR`…). */
  readonly sensitive_labels: readonly string[];
  /** The authenticated mailbox address ; drives `to-zone[self]`. Defaults to the resource ref. */
  readonly account_email: string | null;
}

/** Keys of `Resource.metadata` the classifier reads. One source of truth for the UI and the tests. */
export const GMAIL_METADATA_KEYS = [
  'internal_domains',
  'allowlist_addresses',
  'allowlist_domains',
  'sensitive_labels',
  'account_email',
] as const;

/**
 * Well-known no-reply local parts — a tiebreaker that classifies a sender as
 * `automated` before any domain match. Deliberately narrow : the universe of
 * automated senders is not enumerable.
 */
const KNOWN_AUTOMATED_LOCAL_PARTS = [
  'no-reply',
  'noreply',
  'do-not-reply',
  'donotreply',
  'notifications',
  'alerts',
  'support',
] as const;

/** Read the zoning configuration of a mailbox resource. Missing or ill-typed lists are empty. */
export function readMailboxMetadata(resource: Resource): GmailMailboxMetadata {
  const raw: Readonly<Record<string, unknown>> = resource.metadata ?? {};
  const accountEmail =
    typeof raw.account_email === 'string' && raw.account_email.includes('@')
      ? raw.account_email
      : resource.ref.includes('@')
        ? resource.ref
        : null;
  return {
    internal_domains: toStringArray(raw.internal_domains).map(lower),
    allowlist_addresses: toStringArray(raw.allowlist_addresses).map(lower),
    allowlist_domains: toStringArray(raw.allowlist_domains).map(lower),
    sensitive_labels: toStringArray(raw.sensitive_labels),
    account_email: accountEmail ? lower(accountEmail) : null,
  };
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

const lower = (s: string): string => s.toLowerCase();

// ─── Address parsing & zone classification ────────────────────────────────

/** Lower-cased address out of `"Name <addr@x.com>"` or `"addr@x.com"` ; null when there is none. */
function extractAddress(raw: string): string | null {
  const m = /<([^>]+)>/.exec(raw);
  const candidate = (m ? m[1]! : raw).trim().toLowerCase();
  return candidate.includes('@') ? candidate : null;
}

function domainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  return at < 0 ? null : address.slice(at + 1);
}

/** From-zone of one sender address. */
export function classifyFromAddress(address: string, md: GmailMailboxMetadata): FromZone {
  const local = address.split('@')[0]!;
  const domain = domainOf(address);
  if (KNOWN_AUTOMATED_LOCAL_PARTS.some((p) => local.includes(p))) return 'automated';
  if (domain) {
    if (md.internal_domains.includes(domain)) return 'internal';
    if (md.allowlist_domains.includes(domain)) return 'known-external';
  }
  if (md.allowlist_addresses.includes(address)) return 'known-external';
  return 'unknown';
}

const TO_ZONE_RANK: Readonly<Record<ToZone, number>> = {
  self: 0,
  internal: 1,
  allowlist: 2,
  'external-unbounded': 3,
};

/** To-zone of a recipient set : the worst of the individual zones ; `self` when empty. */
export function classifyRecipients(addresses: readonly string[], md: GmailMailboxMetadata): ToZone {
  let worst: ToZone = 'self';
  for (const addr of addresses) {
    const z = classifyOneRecipient(addr, md);
    if (TO_ZONE_RANK[z] > TO_ZONE_RANK[worst]) worst = z;
  }
  return worst;
}

function classifyOneRecipient(address: string, md: GmailMailboxMetadata): ToZone {
  if (md.account_email !== null && address === md.account_email) return 'self';
  const domain = domainOf(address);
  if (domain && md.internal_domains.includes(domain)) return 'internal';
  if (md.allowlist_addresses.includes(address)) return 'allowlist';
  if (domain && md.allowlist_domains.includes(domain)) return 'allowlist';
  return 'external-unbounded';
}

/** Addresses of `to` / `cc` / `bcc` — each a string (comma-separated allowed) or a string list. */
function collectRecipients(args: Readonly<Record<string, unknown>>): string[] {
  const out: string[] = [];
  for (const key of ['to', 'cc', 'bcc']) {
    const v = args[key];
    const parts = typeof v === 'string' ? v.split(',') : Array.isArray(v) ? v : [];
    for (const part of parts) {
      if (typeof part !== 'string') continue;
      const addr = extractAddress(part);
      if (addr) out.push(addr);
    }
  }
  return out;
}

// ─── Slice helpers ─────────────────────────────────────────────────────────

function slice(action: 'R' | 'W', segments: readonly SliceSegment[]): Slice {
  return { provider: 'gmail', path: segments, action };
}
const name = (value: string): SliceSegment => ({ kind: 'name', value });
const ident = (value: string): SliceSegment => ({ kind: 'ident', value });
const ANY_IDENT: SliceSegment = { kind: 'ident', value: '*' };

// ─── Query helpers ─────────────────────────────────────────────────────────

/** A query with neither `from:` nor `to:` nor `label:` may match the whole mailbox. */
function isNonDiscriminatingQ(parsed: QParsed): boolean {
  return (
    parsed.fromAddresses.length === 0 &&
    parsed.toAddresses.length === 0 &&
    parsed.labels.length === 0
  );
}

/** Distinct from-zones of the `from:` clauses ; `unknown` added when the query carries operators we do not model. */
function fromZonesFromQ(parsed: QParsed, md: GmailMailboxMetadata): FromZone[] {
  const out = new Set<FromZone>();
  for (const addr of parsed.fromAddresses) out.add(classifyFromAddress(addr.toLowerCase(), md));
  if (parsed.hasUnknownOps) out.add('unknown');
  return [...out];
}

/** The `label:` clauses naming a sensitive label, as written in the query. */
function sensitiveLabelsTouched(parsed: QParsed, md: GmailMailboxMetadata): string[] {
  if (md.sensitive_labels.length === 0) return [];
  const sensitive = new Set(md.sensitive_labels.map(lower));
  return parsed.labels.filter((l) => sensitive.has(l.toLowerCase()));
}

// ─── Resource selection ────────────────────────────────────────────────────

/**
 * The single mailbox of the mission. No tool argument selects a mailbox, so
 * two or more gmail resources are ambiguous and denied (multi-account is a
 * later decision).
 */
export function selectMailbox(resources: readonly Resource[]): Resource | { denied: string } {
  const mailboxes = resources.filter((r) => r.provider === 'gmail');
  if (mailboxes.length === 0) return { denied: 'no gmail mailbox is a resource of this mission.' };
  if (mailboxes.length > 1) {
    return { denied: 'ambiguous gmail target: this mission has several mailboxes.' };
  }
  return mailboxes[0]!;
}

// ─── Classifier ────────────────────────────────────────────────────────────

/**
 * Classify a Gmail tool call into the slices it touches. `denied` for an
 * unknown tool or when the mission has no single mailbox ; otherwise one or
 * more slices the catalog matches.
 */
export function classifyGmail(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ClassifyOutcome {
  const mailbox = selectMailbox(resources);
  if ('denied' in mailbox) return mailbox;
  if (!(GMAIL_CLASSIFIED_TOOLS as readonly string[]).includes(tool)) {
    return { denied: `unknown gmail tool '${tool}'.` };
  }
  const md = readMailboxMetadata(mailbox);

  switch (tool) {
    // Synthetic Vaubaan tool — returns the zoning configuration, read-only.
    case 'gmail__describe_zones':
      return { slices: [slice('R', [name('mailbox'), name('label'), ANY_IDENT])] };

    case 'gmail__search_threads': {
      const parsed = parseQ(typeof args.q === 'string' ? args.q : '');
      const slices: Slice[] = [slice('R', [name('mailbox'), name('label'), ANY_IDENT])];
      for (const z of fromZonesFromQ(parsed, md)) {
        slices.push(slice('R', [name('mailbox'), name('from-zone'), ident(z)]));
      }
      if (isNonDiscriminatingQ(parsed)) {
        slices.push(slice('R', [name('mailbox'), name('bulk-marker')]));
        if (parsed.fromAddresses.length === 0) {
          slices.push(slice('R', [name('mailbox'), name('from-zone'), ident('unknown')]));
        }
      }
      for (const lbl of sensitiveLabelsTouched(parsed, md)) {
        slices.push(slice('R', [name('mailbox'), name('sensitive-label'), ident(lbl)]));
      }
      return { slices };
    }

    // Worst case : the sender is unknown until the thread is fetched.
    case 'gmail__get_thread': {
      const tid = typeof args.id === 'string' && args.id.length > 0 ? args.id : '*';
      return {
        slices: [
          slice('R', [name('mailbox'), name('thread'), ident(tid), name('message'), ANY_IDENT]),
          slice('R', [name('mailbox'), name('from-zone'), ident('unknown')]),
        ],
      };
    }

    case 'gmail__list_drafts':
      return { slices: [slice('R', [name('mailbox'), name('draft'), ANY_IDENT])] };

    case 'gmail__create_draft': {
      const zone = classifyRecipients(collectRecipients(args), md);
      return {
        slices: [
          slice('W', [name('mailbox'), name('draft')]),
          slice('W', [name('mailbox'), name('to-zone'), ident(zone)]),
        ],
      };
    }

    case 'gmail__list_labels':
      return { slices: [slice('R', [name('mailbox'), name('label'), ANY_IDENT])] };

    case 'gmail__label_message':
    case 'gmail__unlabel_message': {
      const tid = typeof args.thread_id === 'string' ? args.thread_id : '*';
      const mid = typeof args.message_id === 'string' ? args.message_id : '*';
      return {
        slices: [
          slice('W', [
            name('mailbox'),
            name('thread'),
            ident(tid),
            name('message'),
            ident(mid),
            name('label'),
          ]),
        ],
      };
    }

    case 'gmail__label_thread':
    case 'gmail__unlabel_thread': {
      const tid = typeof args.thread_id === 'string' ? args.thread_id : '*';
      return {
        slices: [slice('W', [name('mailbox'), name('thread'), ident(tid), name('label')])],
      };
    }

    default:
      return { denied: `unknown gmail tool '${tool}'.` };
  }
}
