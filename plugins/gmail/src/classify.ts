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
 * It fails closed : what it cannot read costs the worst case or refuses the
 * call, never less. Modelling rules (handbook) :
 *
 *   1. `get_thread` is classified worst-case `from-zone[unknown]` : the sender
 *      is unknown until the thread is fetched. Agents search first.
 *   2. A `search_threads` query is bounded only when it is a pure conjunction
 *      holding at least one positive `from:<full address>`. Anything else —
 *      `OR`, grouping, quoting, a `from:` that is not one address, no `from:`
 *      at all — is `from-zone[unknown].R` plus `bulk-marker.R`. A negation or
 *      an operator the parser does not model adds `from-zone[unknown].R`.
 *   3. A sender is `automated` only when the local part of its full address
 *      *is* a well-known no-reply name (`no-reply@myorg.com`) ; that rule
 *      runs before the internal-domain rule.
 *   4. When the mailbox declares sensitive labels, every read carries the
 *      `sensitive-label` marker : `get_thread` always, a search for each
 *      label its query does not provably exclude with `-label:<name>`.
 *   5. Every recipient of a draft is parsed strictly and counted ; one that
 *      does not parse refuses the call. The to-zone is the *worst* of the
 *      recipients, and a recipient outside the internal domains and the
 *      allowlists refuses the draft.
 *   6. A label write needs well-formed ids and a label ; `TRASH` and `SPAM`
 *      are refused ; a label that is, or may be, a sensitive one adds
 *      `sensitive-label[l].W`.
 *   7. One mission, one mailbox : zero gmail resources is denied, two or more
 *      is denied as ambiguous (no argument selects a mailbox today).
 *   8. A send is zoned like a draft — the worst recipient — but every zone is
 *      a risk a mission may accept, the external one included. `send_draft`
 *      is priced on the recipients its arguments declare ; `execute` reads
 *      the draft and refuses it, unsent, when it holds any other.
 */

import {
  ANY_IDENT,
  identSegment,
  type ClassifyOutcome,
  type Resource,
  type Slice,
  type SliceSegment,
} from '@vaubaan/plugin-sdk';

import { collectRecipients, parseBareAddress, type EmailAddress } from './address.ts';
import { parseQ, type QParsed } from './q-parser.ts';
import { PROVIDER_ID, TOOL } from './identity.ts';
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
 * Well-known no-reply local parts — a sender whose local part **is** one of
 * them, on an internal or allowlisted domain (or an allowlisted address), is
 * `automated`. On any other domain the local part is chosen by the sender and
 * decides nothing. Deliberately narrow : the
 * universe of automated senders is not enumerable, and a substring match
 * would turn `supportive.ceo@` into an automated sender.
 */
const KNOWN_AUTOMATED_LOCAL_PARTS: ReadonlySet<string> = new Set([
  'no-reply',
  'noreply',
  'do-not-reply',
  'donotreply',
  'notifications',
  'alerts',
  'support',
]);

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

// ─── Zone classification ───────────────────────────────────────────────────

/**
 * From-zone of one sender. `address` must be exactly one full address ; a
 * bare word, a domain or a list is `unknown` (Gmail would match it loosely).
 */
export function classifyFromAddress(address: string, md: GmailMailboxMetadata): FromZone {
  const parsed = parseBareAddress(address);
  return parsed ? fromZoneOf(parsed, md) : 'unknown';
}

function fromZoneOf(sender: EmailAddress, md: GmailMailboxMetadata): FromZone {
  const internal = md.internal_domains.includes(sender.domain);
  const known =
    md.allowlist_domains.includes(sender.domain) || md.allowlist_addresses.includes(sender.address);
  // `automated` is a zone of senders the owner already knows. Anybody can name a mailbox
  // `support@` or `noreply@` on a domain of their own: on an unknown domain the local
  // part says nothing, and the sender stays `unknown`.
  if ((internal || known) && KNOWN_AUTOMATED_LOCAL_PARTS.has(sender.local)) return 'automated';
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

/**
 * To-zone of a recipient set : the worst of the individual zones ; `self`
 * when empty. Each entry must be exactly one full address ; one that is not
 * is `external-unbounded`.
 */
export function classifyRecipients(addresses: readonly string[], md: GmailMailboxMetadata): ToZone {
  return worstToZone(
    addresses.map((a) => parseBareAddress(a)),
    md,
  );
}

function worstToZone(
  recipients: readonly (EmailAddress | null)[],
  md: GmailMailboxMetadata,
): ToZone {
  let worst: ToZone = 'self';
  for (const recipient of recipients) {
    const z = recipient ? toZoneOf(recipient, md) : 'external-unbounded';
    if (TO_ZONE_RANK[z] > TO_ZONE_RANK[worst]) worst = z;
  }
  return worst;
}

function toZoneOf(recipient: EmailAddress, md: GmailMailboxMetadata): ToZone {
  if (md.account_email !== null && recipient.address === md.account_email) return 'self';
  if (md.internal_domains.includes(recipient.domain)) return 'internal';
  if (md.allowlist_addresses.includes(recipient.address)) return 'allowlist';
  if (md.allowlist_domains.includes(recipient.domain)) return 'allowlist';
  return 'external-unbounded';
}

// ─── Slice helpers ─────────────────────────────────────────────────────────

function slice(action: 'R' | 'W', segments: readonly SliceSegment[]): Slice {
  return { provider: PROVIDER_ID, path: segments, action };
}
const name = (value: string): SliceSegment => ({ kind: 'name', value });
const ident = (value: string): SliceSegment => ({ kind: 'ident', value });

const fromZoneSlice = (zone: FromZone): Slice =>
  slice('R', [name('mailbox'), name('from-zone'), ident(zone)]);

/** `sensitive-label[<name>]` ; `*` when the owner's label name is not a legal slice identifier. */
function sensitiveLabelSlice(action: 'R' | 'W', label: string | null): Slice {
  const segment = label !== null ? identSegment(label) : ANY_IDENT;
  return slice(action, [name('mailbox'), name('sensitive-label'), segment]);
}

// ─── Argument validation ───────────────────────────────────────────────────

/**
 * Longest thread or message id accepted : the lower-case hexadecimal of a
 * 64-bit `X-GM-THRID` / `X-GM-MSGID`, as the Gmail API prints it.
 */
export const MAX_GMAIL_ID_LENGTH = 16;
/** Longest label accepted (Gmail caps a label name at 225 characters). */
export const MAX_LABEL_LENGTH = 225;

/** Most recipients of one send, To, Cc and Bcc together (Gmail's own limit over SMTP). */
export const MAX_SEND_RECIPIENTS = 100;

/** Longest MIME part number accepted (`1.2.3`), in characters. */
export const MAX_PART_LENGTH = 32;

const GMAIL_ID = new RegExp(`^[0-9a-f]{1,${MAX_GMAIL_ID_LENGTH}}$`);
/** One number of a part number : 1 to 9999, no leading zero. */
const PART_NUMBER = /^[1-9][0-9]{0,3}$/;
/**
 * What a label name may hold : letters, marks and digits of any script, the
 * space, and common punctuation. Never a control character, a quote, a
 * backslash, `*` / `%` (IMAP's `LIST` wildcards), braces (an IMAP literal
 * starts with `{`), brackets (`[Gmail]`) or angle brackets.
 */
const LABEL_CHAR = /^[\p{L}\p{M}\p{N} _.,;:!?'’&+()@#=~^$€£«»–—/-]$/u;

/**
 * A Gmail thread or message id, or `null` : 1 to 16 lower-case hexadecimal
 * digits, the Gmail API's spelling of the 64-bit `X-GM-THRID` / `X-GM-MSGID`
 * the IMAP server numbers them with. The id lands in a slice and, converted
 * to its decimal value, in an IMAP `SEARCH` ; a value outside the grammar is
 * refused, never escaped or normalised. The one check `classify` and
 * `execute` share (ADR plugin-identifiers-one-grammar-for-classify-and-execute).
 */
export function gmailId(value: unknown): string | null {
  return typeof value === 'string' && GMAIL_ID.test(value) ? value : null;
}

/**
 * A MIME part number of a message (`2`, `1.2`), or `null` : numbers from 1,
 * separated by dots, bounded. The `part` of `get_attachment` lands in an IMAP
 * `FETCH BODY[<part>]` ; shared with `execute`, like `gmailId`.
 */
export function gmailPartId(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_PART_LENGTH) return null;
  // Split on the dots, each number checked alone : no repeated group to backtrack in.
  return value.split('.').every((n) => PART_NUMBER.test(n)) ? value : null;
}

/**
 * A label argument, or `null` : a system label id (`INBOX`) or a user label
 * name as `list_labels` returns it, nested with `/` — `Clients 2026`,
 * `Factures payées`, `Projets/Été`. At most `MAX_LABEL_LENGTH` characters,
 * each one of `LABEL_CHAR` (no control character, CR or LF, quote,
 * backslash, wildcard, brace or bracket) ; no segment empty, `.` or `..`, and
 * no blank at either end of the name or of a segment. Over IMAP the name is
 * a mailbox name, which `imapflow` sends quoted, in modified UTF-7. Shared
 * with `execute`, like `gmailId`.
 */
export function labelRef(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if ([...value].length > MAX_LABEL_LENGTH) return null;
  for (const ch of value) if (!LABEL_CHAR.test(ch)) return null;
  return value
    .split('/')
    .every((seg) => seg !== '' && seg !== '.' && seg !== '..' && seg === seg.trim())
    ? value
    : null;
}

/** A required identifier argument checked by its grammar, or the denial that names it. */
function requireArg(
  args: Readonly<Record<string, unknown>>,
  key: string,
  grammar: (value: unknown) => string | null,
): string | { denied: string } {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) return { denied: `${key}: missing.` };
  return grammar(value) ?? { denied: `${key}: malformed.` };
}

// ─── Labels ────────────────────────────────────────────────────────────────

/**
 * Comparison key of a label name : Gmail's search syntax is case-insensitive
 * and writes a space or a `/` of the name as `-` (`label:legal-contracts`) ;
 * the name is compared in Unicode NFC, so `Été` typed composed or decomposed
 * is one label.
 */
const labelKey = (label: string): string =>
  label
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s/]+/g, '-');

/** `candidate` is `parent` or a label nested under it (`legal/contracts`, `legal-contracts`). */
function isLabelOrNested(candidate: string, parent: string): boolean {
  const c = labelKey(candidate);
  const p = labelKey(parent);
  return c === p || c.startsWith(`${p}-`);
}

/** Label ids that move a message to the bin or to spam : a deletion, which no risk models. */
const DELETING_LABELS: ReadonlySet<string> = new Set(['TRASH', 'SPAM']);

/**
 * A label a write may name, or `null` : `labelRef`, and never `TRASH` or
 * `SPAM` in any case. The one check of a written label, for `classify` and
 * `execute`.
 */
export function writableLabel(value: unknown): string | null {
  const label = labelRef(value);
  return label !== null && !DELETING_LABELS.has(label.toUpperCase()) ? label : null;
}

/** Prefixes of Gmail's system folders, whatever the locale's product name. */
const SYSTEM_CONTAINER_PREFIXES = ['[gmail]', '[google mail]'];

/**
 * A label `create_label` may name, or `null` : `labelRef`, and none of the
 * system label ids (`INBOX`, `TRASH`, `SPAM`, `CATEGORY_*`…, in any case),
 * and nothing under Gmail's system container (`[Gmail]/…`). The server
 * check (the name exists, or is a special-use folder) is `execute`'s.
 */
export function creatableLabel(value: unknown): string | null {
  const label = labelRef(value);
  if (label === null) return null;
  const upper = label.toUpperCase();
  const first = upper.split('/')[0] ?? upper;
  if (SYSTEM_LABEL_IDS.has(first) || DELETING_LABELS.has(first)) return null;
  const lower = label.toLowerCase();
  if (SYSTEM_CONTAINER_PREFIXES.some((p) => lower === p || lower.startsWith(`${p}/`))) return null;
  return label;
}

/**
 * System label ids a write may name. Any other value is a user label name,
 * which may be, or be nested under, one of the owner's sensitive labels ;
 * only these ids are known not to be one. `execute` writes four of them
 * (`INBOX`, `STARRED`, `IMPORTANT`, `UNREAD`) and refuses the others, which
 * IMAP does not expose as writable labels.
 */
export const SYSTEM_LABEL_IDS: ReadonlySet<string> = new Set([
  'INBOX',
  'STARRED',
  'UNREAD',
  'IMPORTANT',
  'SENT',
  'DRAFT',
  'CHAT',
  'CATEGORY_PERSONAL',
  'CATEGORY_SOCIAL',
  'CATEGORY_PROMOTIONS',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
]);

/**
 * The sensitive-label marker of a label write, if any. A label that names a
 * sensitive label (or one nested under it) carries that label ; a label the
 * classifier cannot resolve — anything but a system label id, when the
 * mailbox declares sensitive labels — carries `*`.
 */
function sensitiveLabelWritten(label: string, md: GmailMailboxMetadata): Slice | null {
  if (md.sensitive_labels.length === 0) return null;
  const named = md.sensitive_labels.find((s) => isLabelOrNested(label, s));
  if (named !== undefined) return sensitiveLabelSlice('W', named);
  if (SYSTEM_LABEL_IDS.has(label)) return null;
  return sensitiveLabelSlice('W', null);
}

/** The label argument of a label write, or the denial. */
function requireWritableLabel(
  args: Readonly<Record<string, unknown>>,
): string | { denied: string } {
  const label = requireArg(args, 'label', labelRef);
  if (typeof label !== 'string') return label;
  if (DELETING_LABELS.has(label.toUpperCase())) {
    return { denied: `label: '${label.toUpperCase()}' deletes mail ; this is not a label write.` };
  }
  return label;
}

// ─── search_threads ────────────────────────────────────────────────────────

/**
 * Slices of a search. The sender zone is the whole security model of the
 * plugin, so a query the parser does not fully bound costs
 * `from-zone[unknown]` and the bulk marker, never less.
 */
function classifySearch(q: unknown, md: GmailMailboxMetadata): Slice[] {
  const parsed = parseQ(typeof q === 'string' ? q : '');
  const senders = parsed.fromAddresses.map((value) => parseBareAddress(value));
  const zones = new Set<FromZone>();
  for (const sender of senders) if (sender) zones.add(fromZoneOf(sender, md));

  // Bounded : a pure conjunction with at least one positive `from:`, each one a full address.
  const bounded = senders.length > 0 && !senders.includes(null) && !parsed.hasDisjunction;
  if (!bounded || parsed.hasNegation || parsed.hasUnknownOps) zones.add('unknown');

  const slices: Slice[] = [slice('R', [name('mailbox'), name('label'), ANY_IDENT])];
  for (const zone of zones) slices.push(fromZoneSlice(zone));
  if (!bounded) slices.push(slice('R', [name('mailbox'), name('bulk-marker')]));
  for (const label of sensitiveLabelsReadBySearch(parsed, md)) {
    slices.push(sensitiveLabelSlice('R', label));
  }
  return slices;
}

/**
 * The sensitive labels a search may return. The labels of a thread are
 * unknown before the fetch, so each declared label is read unless the query
 * proves otherwise : a pure conjunction carrying `-label:<name>` for it and
 * no positive `label:` clause on it or under it.
 */
function sensitiveLabelsReadBySearch(parsed: QParsed, md: GmailMailboxMetadata): string[] {
  return md.sensitive_labels.filter((sensitive) => {
    if (parsed.hasDisjunction) return true;
    if (parsed.labels.some((l) => isLabelOrNested(l, sensitive))) return true;
    return !parsed.negatedLabels.some((l) => labelKey(l) === labelKey(sensitive));
  });
}

// ─── Resource selection ────────────────────────────────────────────────────

/**
 * The single mailbox of the mission. No tool argument selects a mailbox, so
 * two or more gmail resources are ambiguous and denied (multi-account is a
 * later decision).
 */
export function selectMailbox(resources: readonly Resource[]): Resource | { denied: string } {
  const mailboxes = resources.filter((r) => r.provider === PROVIDER_ID);
  if (mailboxes.length === 0) return { denied: 'no gmail mailbox is a resource of this mission.' };
  if (mailboxes.length > 1) {
    return { denied: 'ambiguous gmail target: this mission has several mailboxes.' };
  }
  return mailboxes[0]!;
}

// ─── Classifier ────────────────────────────────────────────────────────────

/**
 * Classify a Gmail tool call into the slices it touches. `denied` for an
 * unknown tool, when the mission has no single mailbox, or when an argument
 * cannot be read safely ; otherwise one or more slices the catalog matches.
 */
export function classifyGmail(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ClassifyOutcome {
  const mailbox = selectMailbox(resources);
  if ('denied' in mailbox) return mailbox;
  if (!GMAIL_CLASSIFIED_TOOLS.includes(tool)) {
    return { denied: `unknown gmail tool '${tool}'.` };
  }
  const md = readMailboxMetadata(mailbox);

  switch (tool) {
    // Synthetic Vaubaan tool — returns the zoning configuration, read-only.
    case TOOL.describeZones:
      return { slices: [slice('R', [name('mailbox'), name('label'), ANY_IDENT])] };

    case TOOL.searchThreads:
      return { slices: classifySearch(args.q, md) };

    // Worst case : neither the sender nor the labels are known until the thread is fetched.
    case TOOL.getThread: {
      const tid = requireArg(args, 'id', gmailId);
      if (typeof tid !== 'string') return tid;
      const slices: Slice[] = [
        slice('R', [name('mailbox'), name('thread'), ident(tid), name('message'), ANY_IDENT]),
        fromZoneSlice('unknown'),
      ];
      if (md.sensitive_labels.length > 0) slices.push(sensitiveLabelSlice('R', null));
      return { slices };
    }

    // Like get_thread : the sender and the labels are unknown before the fetch.
    case TOOL.getAttachment: {
      const tid = requireArg(args, 'thread_id', gmailId);
      if (typeof tid !== 'string') return tid;
      const mid = requireArg(args, 'message_id', gmailId);
      if (typeof mid !== 'string') return mid;
      const part = requireArg(args, 'part', gmailPartId);
      if (typeof part !== 'string') return part;
      const slices: Slice[] = [
        slice('R', [name('mailbox'), name('thread'), ident(tid), name('message'), ident(mid)]),
        fromZoneSlice('unknown'),
      ];
      if (md.sensitive_labels.length > 0) slices.push(sensitiveLabelSlice('R', null));
      return { slices };
    }

    case TOOL.createLabel: {
      const label = requireArg(args, 'name', creatableLabel);
      if (typeof label !== 'string') return label;
      const slices: Slice[] = [slice('W', [name('mailbox'), name('label'), identSegment(label)])];
      const named = md.sensitive_labels.find((s) => isLabelOrNested(label, s));
      if (named !== undefined) slices.push(sensitiveLabelSlice('W', named));
      return { slices };
    }

    case TOOL.listDrafts:
      return { slices: [slice('R', [name('mailbox'), name('draft'), ANY_IDENT])] };

    case TOOL.createDraft: {
      const collected = collectRecipients(args);
      if ('denied' in collected) return collected;
      const zone = worstToZone(collected.recipients, md);
      // The exfiltration vector of the plugin : refused here, because no
      // catalog field can make a risk unacceptable to every mission.
      if (zone === 'external-unbounded') {
        return {
          denied:
            'recipients outside the internal domains and the allowlist: not acceptable for a draft.',
        };
      }
      return {
        slices: [
          slice('W', [name('mailbox'), name('draft')]),
          slice('W', [name('mailbox'), name('to-zone'), ident(zone)]),
        ],
      };
    }

    // Irreversible : a sent message cannot be called back. One slice, the recipient zone ;
    // removing the sent draft from Drafts is part of the send, not a draft write.
    case TOOL.sendMessage:
    case TOOL.sendDraft: {
      if (tool === TOOL.sendDraft) {
        const id = requireArg(args, 'id', gmailId);
        if (typeof id !== 'string') return id;
      }
      const collected = collectRecipients(args);
      if ('denied' in collected) return collected;
      if (collected.recipients.length === 0) {
        return { denied: 'a send needs at least one recipient in to, cc or bcc.' };
      }
      if (collected.recipients.length > MAX_SEND_RECIPIENTS) {
        return { denied: `a send has at most ${MAX_SEND_RECIPIENTS} recipients.` };
      }
      const zone = worstToZone(collected.recipients, md);
      return { slices: [slice('W', [name('mailbox'), name('send-zone'), ident(zone)])] };
    }

    case TOOL.listLabels:
      return { slices: [slice('R', [name('mailbox'), name('label'), ANY_IDENT])] };

    case TOOL.labelMessage:
    case TOOL.unlabelMessage: {
      const tid = requireArg(args, 'thread_id', gmailId);
      if (typeof tid !== 'string') return tid;
      const mid = requireArg(args, 'message_id', gmailId);
      if (typeof mid !== 'string') return mid;
      const label = requireWritableLabel(args);
      if (typeof label !== 'string') return label;
      const target = [name('mailbox'), name('thread'), ident(tid), name('message'), ident(mid)];
      return { slices: labelWriteSlices([...target, name('label')], label, md) };
    }

    case TOOL.labelThread:
    case TOOL.unlabelThread: {
      const tid = requireArg(args, 'thread_id', gmailId);
      if (typeof tid !== 'string') return tid;
      const label = requireWritableLabel(args);
      if (typeof label !== 'string') return label;
      const target = [name('mailbox'), name('thread'), ident(tid), name('label')];
      return { slices: labelWriteSlices(target, label, md) };
    }

    default:
      return { denied: `unknown gmail tool '${tool}'.` };
  }
}

/** The containment slice of a label write, plus the sensitive-label marker when it applies. */
function labelWriteSlices(
  target: readonly SliceSegment[],
  label: string,
  md: GmailMailboxMetadata,
): Slice[] {
  const sensitive = sensitiveLabelWritten(label, md);
  return sensitive ? [slice('W', target), sensitive] : [slice('W', target)];
}
