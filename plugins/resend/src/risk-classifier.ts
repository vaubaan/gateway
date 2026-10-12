/**
 * Resend v4 risk-based classifier — maps a concrete `(tool, args, bindings)`
 * call to the set of slices the runtime intersects with the risk catalog.
 *
 * Spec : docs/spec/resend.md §7.
 *
 * Distinctive Resend twists vs the prior providers :
 *
 *   1. **Identity-based to-zone** — the risk profile of a send depends on
 *      *who the email goes to*. The classifier computes a zone (`internal` /
 *      `allowlist` / `external-unbounded`) by matching the union of to+cc+bcc
 *      recipients against the binding's metadata (`internal_domains`,
 *      `allowlist_domains`, `allowlist_addresses`). Worst-case wins.
 *
 *   2. **Recipient-count as a separate blast axis** — `single` (1 recipient),
 *      `multi` (2+), `batch` (POST /emails/batch). The classifier emits the
 *      count slice alongside the to-zone slice so both risks must be accepted.
 *
 *   3. **Batch sends emit 3 slices** — to-zone + recipient-count[batch] +
 *      batch.W. The worst-case zone is computed across ALL emails in the batch.
 *
 *   4. **Broadcast sends** bypass individual recipient classification because
 *      they target an audience. The classifier emits a single
 *      `audience[AUD].broadcast[B].send.W` slice.
 *
 *   5. **Attachment denial (v1)** — if `args.attachments` is non-empty, the
 *      classifier short-circuits with `{ denied: 'attachments not supported
 *      in v1' }`. Audited as DENY in the trail.
 *
 *   6. **Synthetic `describe_zones`** tool — returns binding metadata (the
 *      zone config). No risk — classified as read-only.
 */

import type { ProviderBinding, Slice, SliceSegment } from '@vaubaan/shared';

export type ClassifyResult = { slices: Slice[] } | { denied: string };

// ─── To-zone names ─────────────────────────────────────────────────────────

type ToZone = 'internal' | 'allowlist' | 'external-unbounded';

// ─── Slice helpers ─────────────────────────────────────────────────────────

function slice(action: 'R' | 'W', segments: readonly SliceSegment[]): Slice {
  return { provider: 'resend', path: segments, action };
}

function name(value: string): SliceSegment {
  return { kind: 'name', value };
}

function ident(value: string): SliceSegment {
  return { kind: 'ident', value };
}

const ANY_IDENT: SliceSegment = { kind: 'ident', value: '*' };

// ─── Binding plumbing ──────────────────────────────────────────────────────

function pickResendBinding(bindings: ReadonlyArray<ProviderBinding>): ProviderBinding | null {
  return bindings.find((b) => b.provider === 'resend') ?? null;
}

/** Resolve the account ident segment from the binding's `resource_ref`
 *  (the operator-chosen slug, e.g. `prod-email`). Falls back to `*` when
 *  absent so the classifier stays robust during the early binding-bootstrap. */
function accountSeg(binding: ProviderBinding): SliceSegment {
  const ref = binding.resource_ref;
  return typeof ref === 'string' && ref.length > 0 ? ident(ref) : ANY_IDENT;
}

/** Read a string arg uniformly (returns `null` when missing/empty). */
function strArg(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Resolve an ident segment from a string arg, with `*` fallback. */
function identArg(args: Record<string, unknown>, key: string): SliceSegment {
  const v = strArg(args, key);
  return v !== null ? ident(v) : ANY_IDENT;
}

// ─── Binding metadata extraction ───────────────────────────────────────────

interface ResendBindingMetadata {
  readonly internal_domains: readonly string[];
  readonly allowlist_domains: readonly string[];
  readonly allowlist_addresses: readonly string[];
}

function readBindingMetadata(binding: ProviderBinding | null): ResendBindingMetadata {
  const raw: Record<string, unknown> = binding?.metadata ?? {};
  return {
    internal_domains: toStringArray(raw.internal_domains).map((s) => s.toLowerCase()),
    allowlist_domains: toStringArray(raw.allowlist_domains).map((s) => s.toLowerCase()),
    allowlist_addresses: toStringArray(raw.allowlist_addresses).map((s) => s.toLowerCase()),
  };
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

// ─── To-zone classification ────────────────────────────────────────────────

/**
 * Extract the domain from an email address. Returns lowercase.
 * Returns `null` for invalid addresses (no `@`).
 */
function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  return email.slice(at + 1).toLowerCase();
}

/**
 * Classify a single recipient address into a zone.
 */
function classifyAddress(addr: string, meta: ResendBindingMetadata): ToZone {
  const lower = addr.toLowerCase();
  const domain = domainOf(lower);

  // Internal domains match
  if (domain && meta.internal_domains.includes(domain)) return 'internal';

  // Allowlist addresses match
  if (meta.allowlist_addresses.includes(lower)) return 'allowlist';

  // Allowlist domains match
  if (domain && meta.allowlist_domains.includes(domain)) return 'allowlist';

  return 'external-unbounded';
}

/** Zone severity ordering — worst case wins. */
const ZONE_SEVERITY: Record<ToZone, number> = {
  internal: 0,
  allowlist: 1,
  'external-unbounded': 2,
};

/**
 * Classify the to-zone for a list of recipient addresses.
 * Worst-case (most permissive) zone across all recipients.
 */
function classifyRecipients(recipients: readonly string[], meta: ResendBindingMetadata): ToZone {
  let worstZone: ToZone = 'internal';
  for (const addr of recipients) {
    const zone = classifyAddress(addr, meta);
    if (ZONE_SEVERITY[zone] > ZONE_SEVERITY[worstZone]) {
      worstZone = zone;
    }
    if (worstZone === 'external-unbounded') break; // can't get worse
  }
  return worstZone;
}

/**
 * Collect all recipient addresses from args (to + cc + bcc).
 * Each field can be a string or an array of strings.
 */
function collectRecipients(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const field of ['to', 'cc', 'bcc']) {
    const v = args[field];
    if (typeof v === 'string') {
      out.push(v);
    } else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === 'string') out.push(item);
      }
    }
  }
  return out;
}

/**
 * Check if args.attachments is non-empty. Returns true if the attachment
 * denial should fire.
 */
function hasAttachments(args: Record<string, unknown>): boolean {
  const att = args.attachments;
  return Array.isArray(att) && att.length > 0;
}

// ─── Classifier ────────────────────────────────────────────────────────────

/**
 * Classify a Resend tool call into the slice(s) it touches.
 *
 * Returns `{ slices: Slice[] }` on success — the runtime intersects each
 * slice with the catalog. Returns `{ denied: string }` for an unknown tool,
 * when no Resend binding is attached, or when attachments are present (v1).
 *
 * The 25 supported tools cover the 5 cardinal use-cases (spec §0) :
 * transactional email, broadcast/marketing, domain management, audience/
 * contact management, and email status reads.
 */
export function classifyResendV4(
  tool: string,
  args: Record<string, unknown>,
  bindings: ReadonlyArray<ProviderBinding>,
): ClassifyResult {
  const binding = pickResendBinding(bindings);
  if (!binding) {
    return { denied: 'no resend binding is attached to this token.' };
  }
  const acct = accountSeg(binding);
  const meta = readBindingMetadata(binding);

  /** Shorthand : build the `account[A]` prefix common to every Resend slice. */
  const root: readonly SliceSegment[] = [name('account'), acct];

  switch (tool) {
    // ─── READS — email status ────────────────────────────────────────────
    case 'resend__get_email': {
      const emailId = identArg(args, 'id');
      return {
        slices: [slice('R', [...root, name('email'), emailId])],
      };
    }

    // ─── READS — domains ─────────────────────────────────────────────────
    case 'resend__list_domains':
      return {
        slices: [slice('R', [...root, name('domain'), ANY_IDENT])],
      };

    case 'resend__get_domain': {
      const domId = identArg(args, 'id');
      return {
        slices: [
          slice('R', [...root, name('domain'), domId]),
          slice('R', [...root, name('domain'), domId, name('dns-record'), ANY_IDENT]),
        ],
      };
    }

    // ─── READS — audiences & contacts ────────────────────────────────────
    case 'resend__list_audiences':
      return {
        slices: [slice('R', [...root, name('audience'), ANY_IDENT])],
      };

    case 'resend__get_audience': {
      const audId = identArg(args, 'id');
      return {
        slices: [slice('R', [...root, name('audience'), audId])],
      };
    }

    case 'resend__list_contacts': {
      const audId = identArg(args, 'audience_id');
      return {
        slices: [slice('R', [...root, name('audience'), audId, name('contact'), ANY_IDENT])],
      };
    }

    case 'resend__get_contact': {
      const contactId = identArg(args, 'id');
      return {
        slices: [slice('R', [...root, name('audience'), ANY_IDENT, name('contact'), contactId])],
      };
    }

    // ─── READS — broadcasts ──────────────────────────────────────────────
    case 'resend__list_broadcasts':
      return {
        slices: [slice('R', [...root, name('audience'), ANY_IDENT, name('broadcast'), ANY_IDENT])],
      };

    case 'resend__get_broadcast': {
      const brdId = identArg(args, 'id');
      return {
        slices: [slice('R', [...root, name('audience'), ANY_IDENT, name('broadcast'), brdId])],
      };
    }

    // ─── WRITES — transactional email ────────────────────────────────────
    case 'resend__send_email': {
      // Attachment denial (v1)
      if (hasAttachments(args)) {
        return { denied: 'attachments not supported in v1' };
      }

      const recipients = collectRecipients(args);
      const zone =
        recipients.length > 0 ? classifyRecipients(recipients, meta) : 'external-unbounded'; // no recipients = worst-case

      const count = recipients.length === 1 ? 'single' : 'multi';

      return {
        slices: [
          slice('W', [...root, name('to-zone'), ident(zone)]),
          slice('W', [...root, name('recipient-count'), ident(count)]),
        ],
      };
    }

    case 'resend__send_batch_emails': {
      // Attachment denial (v1) — check across all emails in the batch
      const emails = Array.isArray(args.emails) ? args.emails : [];
      for (const email of emails) {
        if (
          typeof email === 'object' &&
          email !== null &&
          hasAttachments(email as Record<string, unknown>)
        ) {
          return { denied: 'attachments not supported in v1' };
        }
      }

      // Compute worst-case zone across ALL emails in the batch
      const allRecipients: string[] = [];
      for (const email of emails) {
        if (typeof email === 'object' && email !== null) {
          allRecipients.push(...collectRecipients(email as Record<string, unknown>));
        }
      }

      const zone =
        allRecipients.length > 0 ? classifyRecipients(allRecipients, meta) : 'external-unbounded';

      return {
        slices: [
          slice('W', [...root, name('to-zone'), ident(zone)]),
          slice('W', [...root, name('recipient-count'), ident('batch')]),
          slice('W', [...root, name('batch')]),
        ],
      };
    }

    // ─── WRITES — domains ────────────────────────────────────────────────
    case 'resend__create_domain':
      return {
        slices: [slice('W', [...root, name('domain')])],
      };

    case 'resend__update_domain': {
      const domId = identArg(args, 'id');
      return {
        slices: [slice('W', [...root, name('domain'), domId])],
      };
    }

    case 'resend__delete_domain': {
      const domId = identArg(args, 'id');
      return {
        slices: [slice('W', [...root, name('domain'), domId])],
      };
    }

    case 'resend__verify_domain': {
      const domId = identArg(args, 'id');
      return {
        slices: [slice('W', [...root, name('domain'), domId, name('dns-record'), ANY_IDENT])],
      };
    }

    // ─── WRITES — audiences ──────────────────────────────────────────────
    case 'resend__create_audience':
      return {
        slices: [slice('W', [...root, name('audience')])],
      };

    case 'resend__delete_audience': {
      const audId = identArg(args, 'id');
      return {
        slices: [slice('W', [...root, name('audience'), audId])],
      };
    }

    // ─── WRITES — contacts ───────────────────────────────────────────────
    case 'resend__create_contact': {
      const audId = identArg(args, 'audience_id');
      return {
        slices: [slice('W', [...root, name('audience'), audId, name('contact')])],
      };
    }

    case 'resend__update_contact': {
      const contactId = identArg(args, 'id');
      return {
        slices: [slice('W', [...root, name('audience'), ANY_IDENT, name('contact'), contactId])],
      };
    }

    case 'resend__delete_contact': {
      const contactId = identArg(args, 'id');
      return {
        slices: [slice('W', [...root, name('audience'), ANY_IDENT, name('contact'), contactId])],
      };
    }

    // ─── WRITES — broadcasts ─────────────────────────────────────────────
    case 'resend__create_broadcast': {
      const audId = identArg(args, 'audience_id');
      return {
        slices: [slice('W', [...root, name('audience'), audId, name('broadcast')])],
      };
    }

    case 'resend__update_broadcast': {
      // PUT /broadcasts/:id — broadcast-draft risk
      return {
        slices: [slice('W', [...root, name('audience'), ANY_IDENT, name('broadcast')])],
      };
    }

    case 'resend__send_broadcast': {
      const brdId = identArg(args, 'id');
      return {
        slices: [
          slice('W', [
            ...root,
            name('audience'),
            ANY_IDENT,
            name('broadcast'),
            brdId,
            name('send'),
          ]),
        ],
      };
    }

    case 'resend__delete_broadcast': {
      const brdId = identArg(args, 'id');
      return {
        slices: [
          slice('W', [
            ...root,
            name('audience'),
            ANY_IDENT,
            name('broadcast'),
            brdId,
            name('delete'),
          ]),
        ],
      };
    }

    // ─── SYNTHETIC — describe_zones (no risk) ────────────────────────────
    case 'resend__describe_zones':
      // Returns binding metadata. Classified as a domain read (metadata-level).
      return {
        slices: [slice('R', [...root, name('domain'), ANY_IDENT])],
      };

    default:
      return { denied: `unknown resend tool '${tool}'.` };
  }
}
