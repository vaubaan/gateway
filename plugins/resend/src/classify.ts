/**
 * Classifier of the `resend` provider : `(tool, args, resources) → slices`.
 *
 * Spec : docs/spec/resend.md §4, §7 ; docs/spec/gateway-risk-model.md §3, §7 ;
 *        docs/spec/vaubaan-gateway.md §10 ("a classification error is a security hole").
 *
 * Pure : no IO, no credential, no `Date`. Slices are rooted at the mission
 * resources so the default `resourceEnvResolver` qualifies env-scoped risks :
 *
 *   sends                      domain[<from domain>].to-zone[Z].W + .recipient-count[C].W
 *   domain tools               domain[<ref>]…
 *   segment / broadcast tools  segment[<segment_id>]…
 *   contacts, sent emails      contact[…] / email[…] (account-level)
 *
 * Resend-specific rules, carried over from the v4 modelling and tightened :
 *
 *   1. **The from domain is the resource.** A send whose `from` is not on a
 *      sending domain of the mission is `denied` — never widened.
 *   2. **Zone = worst recipient** of to + cc + bcc against the domain
 *      resource's zone lists (`zones.ts`) ; a malformed address is `denied`.
 *   3. **Batch** : one zone slice per sending domain of the batch plus the
 *      `recipient-count[batch]` marker ; more than 100 emails is `denied`.
 *   4. **Attachments and scheduling are out of scope** (spec §10) : any
 *      `attachments`, `scheduled_at` or broadcast `send: true` is `denied`,
 *      so the broadcast-send gate cannot be bypassed from a draft.
 *   5. **Every broadcast call names its segment** ; `execute` checks upstream
 *      that the broadcast belongs to it before acting.
 *
 * Identifiers from the arguments must match `SAFE_IDENT` before they are
 * embedded ; a contact looked up by email address is the glob `*` (an unknown
 * member — same risk, less precision), anything else malformed is `denied`.
 */

import type { ClassifyOutcome, Resource, Slice, SliceSegment } from '@vaubaan/plugin-sdk';

import {
  RESEND_PROVIDER,
  SAFE_IDENT,
  resolveDomain,
  resolveDomainArg,
  resolveSegmentArg,
  zoneConfigOf,
  type Resolved,
} from './resources.ts';
import {
  collectRecipients,
  parseAddress,
  recipientCountOf,
  worstZone,
  type EmailAddress,
} from './zones.ts';

/** Resend accepts at most 100 emails per batch call (`infra_limits` of `send-batch`). */
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

/** A required identifier argument (uuid-like ids) ; anything else is refused. */
function requireIdent(args: Args, key: string): Ident | Denied {
  const value = args[key];
  return typeof value === 'string' && SAFE_IDENT.test(value)
    ? { ident: value }
    : { denied: `${key}: missing or malformed identifier` };
}

/** A contact selector : an id (ident) or an email address (glob — unknown member). */
function contactIdent(args: Args, key = 'id'): Ident | Denied {
  const value = args[key];
  if (typeof value === 'string' && SAFE_IDENT.test(value)) return { ident: value };
  if (parseAddress(value)) return { ident: '*' };
  return { denied: `${key}: missing or malformed contact id or email` };
}

function hasAttachments(args: Args): boolean {
  return Array.isArray(args.attachments) && args.attachments.length > 0;
}

/** The v1 refusals shared by single and batch sends. */
function refuseOutOfScope(args: Args, where = ''): Denied | null {
  if (hasAttachments(args)) return { denied: `${where}attachments: not supported in v1` };
  if (args.scheduled_at !== undefined) {
    return { denied: `${where}scheduled_at: scheduling is not supported in v1` };
  }
  return null;
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
      const id = requireIdent(args, 'id');
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
      const root = [name('domain'), ident(send.resource.ref)];
      const zone = worstZone(send.recipients, zoneConfigOf(send.resource));
      return {
        slices: [
          slice('W', [...root, name('to-zone'), ident(zone)]),
          slice('W', [...root, name('recipient-count'), ident(recipientCountOf(send.recipients))]),
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
  const id = requireIdent(args, 'id');
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
