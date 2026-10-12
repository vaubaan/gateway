/**
 * Gmail v4 risk-based classifier — maps a concrete `(tool, args, bindings)`
 * call to the set of slices the runtime intersects with the risk catalog.
 *
 * Spec     : docs/spec/gateway-risk-model.md §3, §7.
 * Research : .vaubaan/research/providers/gmail.md §2 (tool mapping) + §5
 *            (edge cases) + §6.ter (decisions actées 2026-06-18).
 *
 * Distinctive Gmail twists vs the 5 prior providers :
 *
 *   1. **Identity-based zoning** — the risk profile of a read depends on
 *      the sender's domain, not on the entity containment. The classifier
 *      computes a *zone* (`automated` / `internal` / `known-external` /
 *      `unknown`) by matching the message sender against the binding's
 *      `metadata.internal_domains` / `allowlist_domains` /
 *      `allowlist_addresses`. Symmetric on writes : recipients drive
 *      `to-zone`.
 *
 *   2. **Worst-case classification on `get_thread`** (research Q2) — the
 *      classifier does NOT know the thread sender until after the fetch.
 *      So it always emits `from-zone[unknown].R`. The agent who wants to
 *      read non-unknown messages must `search_threads` first (the `q`
 *      reveals the zone).
 *
 *   3. **Synthetic tool `gmail__describe_zones`** (research Q7) — Vaubaan
 *      exposes a read-only tool returning the binding metadata so the
 *      agent can learn the zone shape without guessing. Classified as
 *      `gmail.read-mailbox` (metadata-level read).
 *
 *   4. **Mirror MCP Google scope at MVP** (research Q1) — only the 9
 *      official Google MCP tools + the synthetic `describe_zones` are
 *      classified. `send_message` / `delete_*` / `create_filter` will fall
 *      to the fallback `gmail.uncategorized-write` if surfaced — fail-loud
 *      by design (an explicit risk must be added to the catalog).
 *
 *   5. **Multi-account NO at MVP** (research Q9) — one Gmail binding = one
 *      Gmail account. If multiple Gmail bindings appear on the token (e.g.
 *      legal mailbox + support mailbox), the classifier picks the first
 *      one. Multi-account-aware classification = Phase 2.
 */

import type { ProviderBinding, Slice, SliceSegment } from '@vaubaan/shared';

import { parseQ } from './q-parser.ts';

export type ClassifyResult = { slices: Slice[] } | { denied: string };

// ─── Zone names ────────────────────────────────────────────────────────────

type FromZone = 'automated' | 'internal' | 'known-external' | 'unknown';
type ToZone = 'self' | 'internal' | 'allowlist' | 'external-unbounded';

// ─── Binding metadata extraction (Gmail-specific shape) ────────────────────

/** Structured view of the metadata fields the Gmail classifier reads. */
interface GmailBindingMetadata {
  /** Domains considered "internal" — emails from / to these match the
   *  `internal` zone (matches both from-zone and to-zone). */
  readonly internal_domains: readonly string[];
  /** Addresses considered "known-external" for from-zone reads. */
  readonly allowlist_addresses: readonly string[];
  /** Domains considered "known-external" for from-zone reads. */
  readonly allowlist_domains: readonly string[];
  /** Labels declared "sensitive" by the operator (e.g. FINANCIAL, LEGAL,
   *  HR, PERSONAL). When a read targets a label in this list, the
   *  classifier emits `sensitive-label[L].R` regardless of zone. */
  readonly sensitive_labels: readonly string[];
  /** The bound Gmail account address (e.g. `me@myorg.com`). Used to
   *  classify `to-zone[self]`. Optional — absent ≡ no self-detection. */
  readonly account_email?: string;
}

/** A handful of well-known no-reply patterns — used as a tiebreaker for
 *  `automated` classification when the binding metadata didn't yield a
 *  specific match. Intentionally narrow ; we don't try to enumerate the
 *  full universe of automated senders. */
const KNOWN_AUTOMATED_LOCAL_PARTS = [
  'no-reply',
  'noreply',
  'do-not-reply',
  'donotreply',
  'notifications',
  'alerts',
  'support',
] as const;

function pickGmailBinding(bindings: ReadonlyArray<ProviderBinding>): ProviderBinding | null {
  return bindings.find((b) => b.provider === 'gmail') ?? null;
}

function readBindingMetadata(binding: ProviderBinding | null): GmailBindingMetadata {
  const raw: Record<string, unknown> = binding?.metadata ?? {};
  return {
    internal_domains: toStringArray(raw.internal_domains),
    allowlist_addresses: toStringArray(raw.allowlist_addresses).map((s) => s.toLowerCase()),
    allowlist_domains: toStringArray(raw.allowlist_domains).map((s) => s.toLowerCase()),
    sensitive_labels: toStringArray(raw.sensitive_labels),
    account_email:
      typeof raw.account_email === 'string' ? raw.account_email.toLowerCase() : undefined,
  };
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

// ─── Address parsing & zone classification ────────────────────────────────

/** Extract the lowercased email address from a free-form `to` value
 *  (`"Name <addr@x.com>"` or `"addr@x.com"`). Returns null on failure. */
function extractAddress(raw: string): string | null {
  const m = raw.match(/<([^>]+)>/);
  const candidate = (m ? m[1]! : raw).trim().toLowerCase();
  if (!candidate.includes('@')) return null;
  return candidate;
}

function domainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at < 0) return null;
  return address.slice(at + 1);
}

/** Compute the from-zone for ONE sender address against the binding
 *  metadata. */
function classifyFromAddress(address: string, md: GmailBindingMetadata): FromZone {
  const local = address.split('@')[0]!;
  const domain = domainOf(address);

  // automated heuristic — known local parts (no-reply etc.) trump the
  // domain matching. An email from `no-reply@myorg.com` is *automated*
  // first, *internal* second — the agent wanting org notifications must
  // accept `read-from-zone-automated`.
  if (KNOWN_AUTOMATED_LOCAL_PARTS.some((p) => local.includes(p))) {
    return 'automated';
  }

  if (domain) {
    if (md.internal_domains.some((d) => domain === d.toLowerCase())) {
      return 'internal';
    }
    if (md.allowlist_domains.includes(domain)) {
      return 'known-external';
    }
  }
  if (md.allowlist_addresses.includes(address)) {
    return 'known-external';
  }
  return 'unknown';
}

/** Compute the to-zone for a *set* of recipient addresses against the
 *  binding metadata. The zone is the *worst* of all individual classes —
 *  any external-unbounded recipient drags the whole call into
 *  external-unbounded. */
function classifyRecipients(addresses: readonly string[], md: GmailBindingMetadata): ToZone {
  if (addresses.length === 0) {
    // No recipients → treat as self (it's a draft with no destination yet).
    return 'self';
  }
  let worst: ToZone = 'self';
  const rank: Record<ToZone, number> = {
    self: 0,
    internal: 1,
    allowlist: 2,
    'external-unbounded': 3,
  };
  for (const addr of addresses) {
    const z = classifyOneRecipient(addr, md);
    if (rank[z] > rank[worst]) worst = z;
  }
  return worst;
}

function classifyOneRecipient(address: string, md: GmailBindingMetadata): ToZone {
  if (md.account_email && address === md.account_email) return 'self';
  const domain = domainOf(address);
  if (domain && md.internal_domains.some((d) => domain === d.toLowerCase())) return 'internal';
  if (md.allowlist_addresses.includes(address)) return 'allowlist';
  if (domain && md.allowlist_domains.includes(domain)) return 'allowlist';
  return 'external-unbounded';
}

/** Collect addresses from a Gmail draft `to`/`cc`/`bcc` arg — accepts
 *  string or string[] or comma-separated string. */
function collectRecipients(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ['to', 'cc', 'bcc']) {
    const v = args[key];
    if (typeof v === 'string') {
      for (const part of v.split(',')) {
        const addr = extractAddress(part);
        if (addr) out.push(addr);
      }
    } else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === 'string') {
          const addr = extractAddress(item);
          if (addr) out.push(addr);
        }
      }
    }
  }
  return out;
}

// ─── Slice helpers ─────────────────────────────────────────────────────────

function slice(action: 'R' | 'W', segments: readonly SliceSegment[]): Slice {
  return { provider: 'gmail', path: segments, action };
}

function name(value: string): SliceSegment {
  return { kind: 'name', value };
}

function ident(value: string): SliceSegment {
  return { kind: 'ident', value };
}

const ANY_IDENT: SliceSegment = { kind: 'ident', value: '*' };

// ─── Worst-case helpers ────────────────────────────────────────────────────

/** Is a `q` "non-discriminating" — i.e. so loose that it could match an
 *  arbitrary number of threads ? Used to fire the `bulk-marker` for
 *  `search_threads`. Rule (research §5.4) : a `q` is non-discriminating if
 *  it carries neither `from:` nor `to:` nor `label:` clauses. */
function isNonDiscriminatingQ(parsed: ReturnType<typeof parseQ>): boolean {
  return (
    parsed.fromAddresses.length === 0 &&
    parsed.toAddresses.length === 0 &&
    parsed.labels.length === 0
  );
}

/** Classify all addresses extracted from a `q`'s `from:` clauses, then
 *  return the *union* of distinct from-zones. */
function fromZonesFromQ(parsed: ReturnType<typeof parseQ>, md: GmailBindingMetadata): FromZone[] {
  const out = new Set<FromZone>();
  for (const addr of parsed.fromAddresses) {
    out.add(classifyFromAddress(addr.toLowerCase(), md));
  }
  // If the `q` carried unknown opérators (something not in our 4 cardinals),
  // we have no idea what message it touches → worst-case unknown (research Q8).
  if (parsed.hasUnknownOps) out.add('unknown');
  return [...out];
}

/** Whether the q's `label:` clauses touch a binding-declared sensitive
 *  label. Returns the matched labels. */
function sensitiveLabelsTouched(
  parsed: ReturnType<typeof parseQ>,
  md: GmailBindingMetadata,
): string[] {
  if (md.sensitive_labels.length === 0) return [];
  const sensitiveLower = new Set(md.sensitive_labels.map((s) => s.toLowerCase()));
  return parsed.labels.filter((l) => sensitiveLower.has(l.toLowerCase()));
}

// ─── Classifier ────────────────────────────────────────────────────────────

/**
 * Classify a Gmail tool call into the slice(s) it touches.
 *
 * Returns `{ slices: Slice[] }` on success — the runtime intersects each
 * slice with the catalog. Returns `{ denied: string }` for an unknown tool.
 *
 * No projectId-style binding-existence check applies here : the Gmail
 * binding is the OAuth-authenticated account ; there is no resource-ref
 * arg an agent can pass that would let it escape its mailbox.
 */
export function classifyGmailV4(
  tool: string,
  args: Record<string, unknown>,
  bindings: ReadonlyArray<ProviderBinding>,
): ClassifyResult {
  const binding = pickGmailBinding(bindings);
  if (!binding) {
    return { denied: `no gmail binding is attached to this token.` };
  }
  const md = readBindingMetadata(binding);

  switch (tool) {
    // ─── Synthetic Vaubaan tool — describe binding zones (research Q7) ────
    case 'gmail__describe_zones': {
      return { slices: [slice('R', [name('mailbox'), name('label'), ANY_IDENT])] };
    }

    // ─── search_threads — the workhorse read tool ─────────────────────────
    case 'gmail__search_threads': {
      const q = typeof args.q === 'string' ? args.q : '';
      const parsed = parseQ(q);
      const slices: Slice[] = [
        // Baseline metadata read (matches `read-mailbox`).
        slice('R', [name('mailbox'), name('label'), ANY_IDENT]),
      ];

      // From-zone slices : one per resolved zone.
      for (const z of fromZonesFromQ(parsed, md)) {
        slices.push(slice('R', [name('mailbox'), name('from-zone'), ident(z)]));
      }

      // If the q carries no discriminator at all → bulk-marker.
      if (isNonDiscriminatingQ(parsed)) {
        slices.push(slice('R', [name('mailbox'), name('bulk-marker')]));
        // Even with `bulk`, expose an `unknown` from-zone slice (worst-case)
        // unless the q already produced specific zones via `from:`.
        if (parsed.fromAddresses.length === 0) {
          slices.push(slice('R', [name('mailbox'), name('from-zone'), ident('unknown')]));
        }
      }

      // Sensitive labels touched via explicit `label:LEGAL` etc.
      for (const lbl of sensitiveLabelsTouched(parsed, md)) {
        slices.push(slice('R', [name('mailbox'), name('sensitive-label'), ident(lbl)]));
      }

      return { slices };
    }

    // ─── get_thread — worst-case unknown (research Q2) ────────────────────
    case 'gmail__get_thread': {
      const tid = typeof args.id === 'string' && args.id.length > 0 ? args.id : '*';
      return {
        slices: [
          slice('R', [name('mailbox'), name('thread'), ident(tid), name('message'), ANY_IDENT]),
          slice('R', [name('mailbox'), name('from-zone'), ident('unknown')]),
        ],
      };
    }

    // ─── list_drafts ──────────────────────────────────────────────────────
    case 'gmail__list_drafts':
      return { slices: [slice('R', [name('mailbox'), name('draft'), ANY_IDENT])] };

    // ─── create_draft — to-zone derived from recipients ───────────────────
    case 'gmail__create_draft': {
      const recipients = collectRecipients(args);
      const zone = classifyRecipients(recipients, md);
      return {
        slices: [
          slice('W', [name('mailbox'), name('draft')]),
          slice('W', [name('mailbox'), name('to-zone'), ident(zone)]),
        ],
      };
    }

    // ─── list_labels ──────────────────────────────────────────────────────
    case 'gmail__list_labels':
      return { slices: [slice('R', [name('mailbox'), name('label'), ANY_IDENT])] };

    // ─── label_message / unlabel_message — single message label ───────────
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

    // ─── label_thread / unlabel_thread — whole-thread label ───────────────
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
