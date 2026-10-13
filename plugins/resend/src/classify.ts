/**
 * Classifier of the `resend` provider : `(tool, args, resources) → slices`.
 *
 * Spec : docs/spec/resend.md §4, §7 ; docs/spec/gateway-risk-model.md §3, §7 ;
 *        docs/spec/vaubaan-gateway.md §10 ("a classification error is a security hole").
 *
 * Pure : no IO, no credential, no `Date`. Slices are rooted at the mission
 * resources so the default `resourceEnvResolver` qualifies env-scoped risks :
 *
 *   single send                domain[<from domain>].to-zone[Z].W
 *   batch send                 the same per from domain + .recipient-count[batch].W
 *   domain tools               domain[<ref>]…
 *   segment / broadcast tools  segment[<segment_id>]…
 *   contacts, sent emails      contact[…] / email[…] (account-level)
 *
 * Resend-specific rules :
 *
 *   1. **The from domain is the resource.** A send whose `from` is not on a
 *      sending domain of the mission is `denied` — never widened.
 *   2. **Zone = worst recipient** of to + cc + bcc against the domain
 *      resource's zone lists (`zones.ts`) ; a malformed address is `denied`.
 *   3. **Batch** : one zone slice per sending domain of the batch plus the
 *      `recipient-count[batch]` marker ; more than 100 emails is `denied`.
 *      A single send emits no count marker : the catalog names a risk for
 *      the batch only, and a slice no named risk matches would touch the
 *      fallback on every send.
 *   4. **Attachments and scheduling are out of scope** (spec §10) : any
 *      `attachments` (a non-array value included), `scheduled_at` or
 *      broadcast `send: true` is `denied`, so the broadcast-send gate cannot
 *      be bypassed from a draft.
 *   5. **Every broadcast call names its segment** ; `execute` checks upstream
 *      that the broadcast belongs to it before acting.
 *   6. **Custom headers cannot rewrite the envelope** : a `headers` key that
 *      names a recipient or sender field (`ENVELOPE_HEADERS`), a malformed
 *      header name or a non-string / multi-line value is `denied` — the zone
 *      was computed from `from`, `to`, `cc` and `bcc` alone.
 *
 * The classifier states what a call does ; whether that is acceptable *here*
 * is the engine's decision. An `external-unbounded` send is classified as
 * such on every domain, and `evaluateCall` refuses it where the catalog's
 * `acceptable_in_envs` excludes the domain's label (or the domain has none) :
 * the environment list lives in the catalog only, and the refusal reaches the
 * audit log with the risk id.
 *
 * Identifiers from the arguments go through one grammar per kind
 * (`resources.ts` : `pathIdent` for an id, `contactSelector` for a contact id
 * or address, `domainName` for a domain) before they are embedded — the
 * functions `execute` builds its request path from ; a contact looked up by
 * email address is the glob `*` (an unknown member — same risk, less
 * precision), anything else malformed is `denied`, never escaped.
 * Fields the classifier does not read never reach Resend : `execute` forwards
 * the declared fields of each tool only.
 */

import type { ClassifyOutcome, Resource, Slice, SliceSegment } from '@vaubaan/plugin-sdk';

import {
  RESEND_PROVIDER,
  contactSelector,
  pathIdent,
  resolveDomain,
  resolveDomainArg,
  resolveSegmentArg,
  zoneConfigOf,
  type Resolved,
} from './resources.ts';
import { collectRecipients, parseAddress, worstZone, type EmailAddress } from './zones.ts';

/** Resend accepts at most 100 emails per batch call ; a larger batch is refused here, before the provider. */
export const BATCH_MAX_EMAILS = 100;

type Args = Readonly<Record<string, unknown>>;

function slice(action: 'R' | 'W', segments: readonly SliceSegment[]): Slice {
  return { provider: RESEND_PROVIDER, path: segments, action };
}
function name(value: string): SliceSegment {
  return { kind: 'name', value };
}
function ident(value: string): SliceSegment {
  return { kind: 'ident', value };
}
const ANY: SliceSegment = { kind: 'ident', value: '*' };

type Denied = { readonly denied: string };
type Ident = { readonly ident: string };

/** Refusal of a missing or malformed `id`, shared with `execute`. */
export const MALFORMED_ID = 'id: missing or malformed identifier';
/** Refusal of a missing or malformed contact selector, shared with `execute`. */
export const MALFORMED_CONTACT = 'id: missing or malformed contact id or email';

/** The required `id` argument (uuid-like ids, a segment of the request path) ; anything else is refused. */
function requireIdent(args: Args): Ident | Denied {
  const id = pathIdent(args.id);
  return id === null ? { denied: MALFORMED_ID } : { ident: id };
}

/** A contact selector : an id (ident) or an email address (glob — unknown member). */
function contactIdent(args: Args): Ident | Denied {
  const contact = contactSelector(args.id);
  return contact === null ? { denied: MALFORMED_CONTACT } : { ident: contact.ident };
}

/** Anything but an absent field or an empty list : a non-array value is unreadable, not absent. */
function hasAttachments(args: Args): boolean {
  const value = args.attachments;
  if (value === undefined) return false;
  return !(Array.isArray(value) && value.length === 0);
}

/**
 * Header names that decide who receives the email or who it claims to come
 * from. The zone of a send is computed from `from`, `to`, `cc` and `bcc` ; a
 * custom header carrying one of these would add a recipient, or move the
 * sender off the mission's domain, behind the classifier's back.
 */
export const ENVELOPE_HEADERS: ReadonlySet<string> = new Set([
  'to',
  'cc',
  'bcc',
  'from',
  'sender',
  'reply-to',
  'return-path',
  'resent-to',
  'resent-cc',
  'resent-bcc',
  'resent-from',
  'resent-sender',
]);

/** RFC 5322 header field name (a `token`) : no space, no colon, no control character. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** `headers` must be a flat object of plain header names and single-line string values. */
function refuseHeaders(headers: unknown, where: string): Denied | null {
  if (headers === undefined) return null;
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    return { denied: `${where}headers: expected an object of header names and string values` };
  }
  for (const [key, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(key)) return { denied: `${where}headers: malformed header name` };
    if (ENVELOPE_HEADERS.has(key.toLowerCase())) {
      return {
        denied: `${where}headers: '${key}' is an envelope header — use the from, to, cc, bcc and reply_to fields`,
      };
    }
    if (typeof value !== 'string' || /[\r\n]/.test(value)) {
      return { denied: `${where}headers: '${key}' must be a single-line string` };
    }
  }
  return null;
}

/** The v1 refusals shared by single and batch sends. */
function refuseOutOfScope(args: Args, where = ''): Denied | null {
  if (hasAttachments(args)) return { denied: `${where}attachments: not supported in v1` };
  if (args.scheduled_at !== undefined) {
    return { denied: `${where}scheduled_at: scheduling is not supported in v1` };
  }
  return refuseHeaders(args.headers, where);
}

type Send = { readonly resource: Resource; readonly recipients: readonly EmailAddress[] };

/** Validate one email payload : out-of-scope fields, from on a mission domain, parseable recipients. */
function resolveSend(args: Args, resources: readonly Resource[], where = ''): Send | Denied {
  const refused = refuseOutOfScope(args, where);
  if (refused) return refused;
  const from = parseAddress(args.from);
  if (!from) return { denied: `${where}from: missing or malformed address` };
  const target = resolveDomain(from.domain, resources);
  if ('denied' in target) return { denied: `${where}${target.denied}` };
  const collected = collectRecipients(args);
  if ('denied' in collected) return { denied: `${where}${collected.denied}` };
  if (collected.recipients.length === 0) {
    return { denied: `${where}to: at least one recipient is required` };
  }
  return { resource: target.resource, recipients: collected.recipients };
}

/** The `from` of a broadcast (when given) must be on a sending domain of the mission. */
function checkBroadcastFrom(args: Args, resources: readonly Resource[]): Denied | null {
  if (args.from === undefined) return null;
  const from = parseAddress(args.from);
  if (!from) return { denied: 'from: malformed address' };
  const target = resolveDomain(from.domain, resources);
  return 'denied' in target ? target : null;
}

/** A broadcast create or update must stay a draft : no send, no schedule. */
function refuseBroadcastDispatch(args: Args): Denied | null {
  if (args.send !== undefined) {
    return { denied: 'send: a broadcast is sent with resend__send_broadcast, not at creation' };
  }
  if (args.scheduled_at !== undefined) {
    return { denied: 'scheduled_at: scheduling is not supported in v1' };
  }
  return null;
}

export function classifyResend(
  tool: string,
  args: Args,
  resources: readonly Resource[],
): ClassifyOutcome {
  switch (tool) {
    // ─── Reads — sent emails ──────────────────────────────────────────────
    case 'resend__get_email': {
      const id = requireIdent(args);
      if ('denied' in id) return id;
      return { slices: [slice('R', [name('email'), ident(id.ident)])] };
    }

    // ─── Reads — domains ──────────────────────────────────────────────────
    case 'resend__list_domains':
    case 'resend__describe_zones':
      return { slices: [slice('R', [name('domain'), ANY])] };
    case 'resend__get_domain': {
      const target = resolveDomainArg(args.domain, resources);
      if ('denied' in target) return target;
      const root = [name('domain'), ident(target.resource.ref)];
      return {
        slices: [slice('R', root), slice('R', [...root, name('dns-record'), ANY])],
      };
    }

    // ─── Reads — segments, contacts, broadcasts ───────────────────────────
    case 'resend__list_segments':
      return { slices: [slice('R', [name('segment'), ANY])] };
    case 'resend__get_segment': {
      const seg = resolveSegmentArg(args.segment_id, resources);
      if ('denied' in seg) return seg;
      return { slices: [slice('R', [name('segment'), ident(seg.resource.ref)])] };
    }
    case 'resend__list_contacts': {
      if (args.segment_id === undefined) return { slices: [slice('R', [name('contact'), ANY])] };
      const seg = resolveSegmentArg(args.segment_id, resources);
      if ('denied' in seg) return seg;
      return {
        slices: [slice('R', [name('segment'), ident(seg.resource.ref), name('member'), ANY])],
      };
    }
    case 'resend__get_contact': {
      const contact = contactIdent(args);
      if ('denied' in contact) return contact;
      return { slices: [slice('R', [name('contact'), ident(contact.ident)])] };
    }
    case 'resend__list_broadcasts':
      return { slices: [slice('R', [name('segment'), ANY, name('broadcast'), ANY])] };
    case 'resend__get_broadcast':
      return broadcastSlice('R', args, resources);

    // ─── Writes — transactional sends ─────────────────────────────────────
    case 'resend__send_email': {
      const send = resolveSend(args, resources);
      if ('denied' in send) return send;
      const zone = worstZone(send.recipients, zoneConfigOf(send.resource));
      // The zone slice alone : no named risk matches a single / multi count
      // marker, so emitting one would touch the fallback on every send.
      return {
        slices: [
          slice('W', [name('domain'), ident(send.resource.ref), name('to-zone'), ident(zone)]),
        ],
      };
    }
    case 'resend__send_batch_emails':
      return classifyBatch(args, resources);

    // ─── Writes — domains ─────────────────────────────────────────────────
    case 'resend__create_domain':
      if (typeof args.name !== 'string' || args.name.length === 0) {
        return { denied: 'name: missing domain name' };
      }
      return { slices: [slice('W', [name('domain')])] };
    case 'resend__update_domain':
    case 'resend__delete_domain': {
      const target = resolveDomainArg(args.domain, resources);
      if ('denied' in target) return target;
      return { slices: [slice('W', [name('domain'), ident(target.resource.ref)])] };
    }
    case 'resend__verify_domain': {
      const target = resolveDomainArg(args.domain, resources);
      if ('denied' in target) return target;
      return {
        slices: [slice('W', [name('domain'), ident(target.resource.ref), name('dns-record'), ANY])],
      };
    }

    // ─── Writes — segments and members ────────────────────────────────────
    case 'resend__create_segment':
      if (typeof args.name !== 'string' || args.name.length === 0) {
        return { denied: 'name: missing segment name' };
      }
      return { slices: [slice('W', [name('segment')])] };
    case 'resend__delete_segment': {
      const seg = resolveSegmentArg(args.segment_id, resources);
      if ('denied' in seg) return seg;
      return { slices: [slice('W', [name('segment'), ident(seg.resource.ref)])] };
    }
    case 'resend__create_contact': {
      if (!parseAddress(args.email)) return { denied: 'email: missing or malformed address' };
      const slices = [slice('W', [name('contact')])];
      if (args.segment_id !== undefined) {
        const seg = resolveSegmentArg(args.segment_id, resources);
        if ('denied' in seg) return seg;
        slices.push(slice('W', [name('segment'), ident(seg.resource.ref), name('member'), ANY]));
      }
      return { slices };
    }
    case 'resend__update_contact':
    case 'resend__delete_contact': {
      const contact = contactIdent(args);
      if ('denied' in contact) return contact;
      return { slices: [slice('W', [name('contact'), ident(contact.ident)])] };
    }
    case 'resend__add_contact_to_segment':
    case 'resend__remove_contact_from_segment': {
      const seg = resolveSegmentArg(args.segment_id, resources);
      if ('denied' in seg) return seg;
      const contact = contactIdent(args);
      if ('denied' in contact) return contact;
      return {
        slices: [
          slice('W', [
            name('segment'),
            ident(seg.resource.ref),
            name('member'),
            ident(contact.ident),
          ]),
        ],
      };
    }

    // ─── Writes — broadcasts ──────────────────────────────────────────────
    case 'resend__create_broadcast': {
      const seg = resolveSegmentArg(args.segment_id, resources);
      if ('denied' in seg) return seg;
      const dispatch = refuseBroadcastDispatch(args);
      if (dispatch) return dispatch;
      if (args.from === undefined) return { denied: 'from: missing or malformed address' };
      const from = checkBroadcastFrom(args, resources);
      if (from) return from;
      return {
        slices: [slice('W', [name('segment'), ident(seg.resource.ref), name('broadcast')])],
      };
    }
    case 'resend__update_broadcast': {
      const dispatch = refuseBroadcastDispatch(args);
      if (dispatch) return dispatch;
      const from = checkBroadcastFrom(args, resources);
      if (from) return from;
      return broadcastSlice('W', args, resources);
    }
    case 'resend__send_broadcast': {
      if (args.scheduled_at !== undefined) {
        return { denied: 'scheduled_at: scheduling is not supported in v1' };
      }
      return broadcastSlice('W', args, resources, 'send');
    }
    case 'resend__delete_broadcast':
      return broadcastSlice('W', args, resources, 'delete');

    default:
      return { denied: `unknown resend tool '${tool}'.` };
  }
}

/** `segment[S].broadcast[B](.<leaf>)?.<action>` from `segment_id` + `id`. */
function broadcastSlice(
  action: 'R' | 'W',
  args: Args,
  resources: readonly Resource[],
  leaf?: 'send' | 'delete',
): ClassifyOutcome {
  const seg: Resolved = resolveSegmentArg(args.segment_id, resources);
  if ('denied' in seg) return seg;
  const id = requireIdent(args);
  if ('denied' in id) return id;
  const path = [name('segment'), ident(seg.resource.ref), name('broadcast'), ident(id.ident)];
  return { slices: [slice(action, leaf ? [...path, name(leaf)] : path)] };
}

/** One zone slice per sending domain of the batch, plus the bulk marker on each. */
function classifyBatch(args: Args, resources: readonly Resource[]): ClassifyOutcome {
  const emails = args.emails;
  if (!Array.isArray(emails) || emails.length === 0) {
    return { denied: 'emails: a non-empty list of emails is required' };
  }
  if (emails.length > BATCH_MAX_EMAILS) {
    return { denied: `emails: Resend accepts at most ${BATCH_MAX_EMAILS} emails per batch` };
  }
  const groups = new Map<string, { resource: Resource; recipients: EmailAddress[] }>();
  for (const [index, email] of emails.entries()) {
    if (typeof email !== 'object' || email === null || Array.isArray(email)) {
      return { denied: `emails[${index}]: expected an email object` };
    }
    const send = resolveSend(email as Args, resources, `emails[${index}].`);
    if ('denied' in send) return send;
    const group = groups.get(send.resource.ref);
    if (group) group.recipients.push(...send.recipients);
    else
      groups.set(send.resource.ref, { resource: send.resource, recipients: [...send.recipients] });
  }
  const slices: Slice[] = [];
  for (const { resource, recipients } of groups.values()) {
    const root = [name('domain'), ident(resource.ref)];
    slices.push(
      slice('W', [...root, name('to-zone'), ident(worstZone(recipients, zoneConfigOf(resource)))]),
      slice('W', [...root, name('recipient-count'), ident('batch')]),
    );
  }
  return { slices };
}
