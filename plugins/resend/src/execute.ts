/**
 * Upstream calls of the `resend` provider — Resend REST API, JSON bodies.
 *
 * Spec : docs/spec/vaubaan-gateway.md §2.4 — the credential arrives decrypted
 *        in the context, is used for one call, and never reaches the agent.
 *
 * Rules :
 *   - `fetch` comes from the context, never from the global ;
 *   - every call re-runs the classifier first : a call the classifier refuses
 *     is never executed, whatever the host did before (fail closed) ;
 *   - every identifier interpolated into the request path is read by the
 *     grammar function the classifier used (`pathIdent`, `contactSelector`,
 *     `resolveSegmentArg`), and the ones that do not come from the arguments
 *     — a domain's `domain_id`, the id of a contact Resend just created — go
 *     through `pathIdent` too : a dot segment or a separator is refused
 *     before the call, never escaped ;
 *   - broadcast calls re-read the broadcast upstream and refuse to act on one
 *     that belongs to another segment than the one the mission named ;
 *   - list calls return only the mission's resources (domains, segments) and
 *     the broadcasts of those segments ;
 *   - only the fields a tool declares are forwarded (`declaredFieldsOf`) : an
 *     argument the schema does not name was read by no classifier rule, so it
 *     is dropped before the call ;
 *   - 401 → `UpstreamAuthError` ; 403 → `UpstreamAuthError` unless Resend
 *     names a `validation_error` (an unverified `from` domain is a 403 too).
 */

import {
  UpstreamAuthError,
  UpstreamHttpError,
  expectCredentialKind,
  type ConnectionContext,
  type ExecuteContext,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { MALFORMED_CONTACT, MALFORMED_ID, classifyResend } from './classify.ts';
import {
  RESEND_PROVIDER,
  contactSelector,
  domainIdOf,
  domainRef,
  domainResources,
  pathIdent,
  resolveDomain,
  resolveDomainArg,
  resolveSegmentArg,
  segmentResources,
  zoneConfigOf,
} from './resources.ts';
import { EMAIL_FIELDS, declaredFieldsOf } from './tools.ts';
import { parseAddress } from './zones.ts';

/** Public API of the provider — a fact about Resend, not instance configuration. */
export const RESEND_API_BASE = 'https://api.resend.com';

/** Page size of the list endpoints (Resend's maximum). */
export const DISCOVERY_PAGE_SIZE = 100;
/** Upper bound of resources discovered per kind ; beyond it the owner narrows the account. */
export const MAX_DISCOVERED_PER_KIND = 500;

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type Args = Readonly<Record<string, unknown>>;

interface ListPage<T> {
  readonly data?: readonly T[];
  readonly has_more?: boolean;
}
interface DomainDto {
  readonly id: string;
  readonly name: string;
  readonly status?: string;
  readonly region?: string;
}
interface SegmentDto {
  readonly id: string;
  readonly name: string;
}
interface BroadcastDto {
  readonly id: string;
  readonly segment_id?: string | null;
  readonly audience_id?: string | null;
}
// ─── v5 entry points ──────────────────────────────────────────────────────────

export async function executeResend(
  ctx: ExecuteContext,
  tool: string,
  args: Args,
): Promise<McpToolResult> {
  const outcome = classifyResend(tool, args, ctx.resources);
  if ('denied' in outcome) {
    if (outcome.denied.startsWith('unknown resend tool')) {
      return { content: [{ type: 'text', text: outcome.denied }], isError: true };
    }
    throw new Error(`resend: ${outcome.denied}`);
  }
  return text(await dispatch(ctx, tool, args));
}

async function dispatch(ctx: ExecuteContext, tool: string, args: Args): Promise<unknown> {
  switch (tool) {
    // ─── Reads ────────────────────────────────────────────────────────────
    case 'resend__get_email':
      return request(ctx, 'GET', `/emails/${idSegment(args.id)}`);
    case 'resend__list_domains': {
      const refs = new Set(domainResources(ctx.resources).map((r) => r.ref));
      const all = await listAll<DomainDto>(ctx, '/domains');
      return { data: all.filter((d) => refs.has(domainRef(d.name))) };
    }
    case 'resend__get_domain':
      return request(ctx, 'GET', `/domains/${domainId(args.domain, ctx.resources)}`);
    case 'resend__list_segments': {
      const refs = new Set(segmentResources(ctx.resources).map((r) => r.ref));
      const all = await listAll<SegmentDto>(ctx, '/segments');
      return { data: all.filter((s) => refs.has(s.id)) };
    }
    case 'resend__get_segment':
      return request(ctx, 'GET', `/segments/${segmentRef(args.segment_id, ctx.resources)}`);
    case 'resend__list_contacts': {
      const query = forwarded(tool, args, ['segment_id']);
      if (args.segment_id !== undefined) {
        query.segment_id = segmentRef(args.segment_id, ctx.resources);
      }
      return request(ctx, 'GET', '/contacts', undefined, query);
    }
    case 'resend__get_contact':
      return request(ctx, 'GET', `/contacts/${contactSegment(args.id)}`);
    case 'resend__list_broadcasts': {
      const refs = new Set(segmentResources(ctx.resources).map((r) => r.ref));
      const all = await listAll<BroadcastDto>(ctx, '/broadcasts');
      return { data: all.filter((b) => refs.has(segmentOf(b) ?? '')) };
    }
    case 'resend__get_broadcast':
      return broadcastInSegment(ctx, args);

    // ─── Writes — sends ───────────────────────────────────────────────────
    case 'resend__send_email':
      return request(ctx, 'POST', '/emails', forwarded(tool, args));
    case 'resend__send_batch_emails':
      // The batch endpoint takes the bare array as its body.
      return request(ctx, 'POST', '/emails/batch', batchBody(args.emails));

    // ─── Writes — domains ─────────────────────────────────────────────────
    case 'resend__create_domain':
      return request(ctx, 'POST', '/domains', forwarded(tool, args));
    case 'resend__update_domain':
      return request(
        ctx,
        'PATCH',
        `/domains/${domainId(args.domain, ctx.resources)}`,
        forwarded(tool, args, ['domain']),
      );
    case 'resend__delete_domain':
      return request(ctx, 'DELETE', `/domains/${domainId(args.domain, ctx.resources)}`);
    case 'resend__verify_domain':
      return request(ctx, 'POST', `/domains/${domainId(args.domain, ctx.resources)}/verify`);

    // ─── Writes — segments and members ────────────────────────────────────
    case 'resend__create_segment':
      return request(ctx, 'POST', '/segments', { name: args.name });
    case 'resend__delete_segment':
      return request(ctx, 'DELETE', `/segments/${segmentRef(args.segment_id, ctx.resources)}`);
    case 'resend__create_contact': {
      const body = forwarded(tool, args, ['segment_id']);
      const created = await request(ctx, 'POST', '/contacts', body);
      if (args.segment_id === undefined) return created;
      const seg = segmentRef(args.segment_id, ctx.resources);
      // The id comes from the provider's answer : it is not trusted to be a path segment.
      const contact = isRecord(created) ? pathIdent(created.id) : null;
      if (!isRecord(created) || contact === null) {
        throw new Error(
          `resend: the contact was created but Resend returned no id — it was not added to segment '${seg}'`,
        );
      }
      const membership = await request(ctx, 'POST', `/contacts/${contact}/segments/${seg}`);
      return { ...created, segment: membership };
    }
    case 'resend__update_contact':
      return request(
        ctx,
        'PATCH',
        `/contacts/${contactSegment(args.id)}`,
        forwarded(tool, args, ['id']),
      );
    case 'resend__delete_contact':
      return request(ctx, 'DELETE', `/contacts/${contactSegment(args.id)}`);
    case 'resend__add_contact_to_segment':
      return request(
        ctx,
        'POST',
        `/contacts/${contactSegment(args.id)}/segments/${segmentRef(args.segment_id, ctx.resources)}`,
      );
    case 'resend__remove_contact_from_segment':
      return request(
        ctx,
        'DELETE',
        `/contacts/${contactSegment(args.id)}/segments/${segmentRef(args.segment_id, ctx.resources)}`,
      );

    // ─── Writes — broadcasts ──────────────────────────────────────────────
    case 'resend__create_broadcast':
      return request(ctx, 'POST', '/broadcasts', {
        ...forwarded(tool, args, ['segment_id']),
        segment_id: segmentRef(args.segment_id, ctx.resources),
      });
    case 'resend__update_broadcast':
      await broadcastInSegment(ctx, args);
      return request(
        ctx,
        'PATCH',
        `/broadcasts/${idSegment(args.id)}`,
        forwarded(tool, args, ['segment_id', 'id']),
      );
    case 'resend__send_broadcast':
      await broadcastInSegment(ctx, args);
      return request(ctx, 'POST', `/broadcasts/${idSegment(args.id)}/send`, {});
    case 'resend__delete_broadcast':
      await broadcastInSegment(ctx, args);
      return request(ctx, 'DELETE', `/broadcasts/${idSegment(args.id)}`);

    // ─── Synthetic ────────────────────────────────────────────────────────
    case 'resend__describe_zones':
      return {
        domains: domainResources(ctx.resources).map((r) => ({
          domain: r.ref,
          env: r.env ?? null,
          ...zoneConfigOf(r),
        })),
      };

    default:
      // Unreachable : the classifier refused unknown tools above.
      throw new Error(`resend: tool not implemented: ${tool}`);
  }
}

/**
 * Resources reachable with this API key : one per sending domain (ref = domain
 * name, zone lists empty until the owner fills them) and one per segment
 * (ref = segment id). Requires a full-access key : a `sending_access` key is
 * refused by `GET /domains` and surfaces as `UpstreamAuthError`.
 */
export async function discoverResendResources(
  ctx: ConnectionContext,
): Promise<readonly Resource[]> {
  expectCredentialKind(RESEND_PROVIDER, ctx.credential, 'api-key');
  const domains = await listAll<DomainDto>(ctx, '/domains');
  const segments = await listAll<SegmentDto>(ctx, '/segments');
  return [
    ...domains.map(
      (d): Resource => ({
        provider: RESEND_PROVIDER,
        ref: domainRef(d.name),
        displayName: d.status === 'verified' || !d.status ? d.name : `${d.name} (${d.status})`,
        metadata: {
          kind: 'domain',
          domain_id: d.id,
          ...(d.status ? { status: d.status } : {}),
          ...(d.region ? { region: d.region } : {}),
          internal_domains: [],
          allowlist_domains: [],
          allowlist_addresses: [],
        },
      }),
    ),
    ...segments.map(
      (s): Resource => ({
        provider: RESEND_PROVIDER,
        ref: s.id,
        displayName: s.name,
        metadata: { kind: 'segment', segment_id: s.id },
      }),
    ),
  ];
}

// ─── Forwarded fields ────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The listed keys the source really carries ; nothing else leaves the plugin. */
function pick(source: Args, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(source, key) && source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/**
 * The upstream payload of a tool : its declared arguments, minus the ones
 * that route the call (`routing` — a resource ref or an id that goes in the
 * path, resolved against the mission separately).
 */
function forwarded(
  tool: string,
  args: Args,
  routing: readonly string[] = [],
): Record<string, unknown> {
  return pick(
    args,
    declaredFieldsOf(tool).filter((key) => !routing.includes(key)),
  );
}

/** The bare array `POST /emails/batch` takes, each email reduced to its declared fields. */
function batchBody(emails: unknown): Record<string, unknown>[] {
  if (!Array.isArray(emails)) throw new Error('resend: emails: expected a list of emails');
  return emails.map((email: unknown) => pick(isRecord(email) ? email : {}, EMAIL_FIELDS));
}

// ─── Resource plumbing ───────────────────────────────────────────────────────

/** The Resend id of a mission domain (one path segment), from the resource metadata discovery wrote. */
function domainId(value: unknown, resources: readonly Resource[]): string {
  const target = resolveDomainArg(value, resources);
  if ('denied' in target) throw new Error(`resend: ${target.denied}`);
  const id = domainIdOf(target.resource);
  if ('denied' in id) throw new Error(`resend: ${id.denied}`);
  return id.id;
}

/** The ref of a mission segment : one path segment (`resolveSegmentArg` returns nothing else). */
function segmentRef(value: unknown, resources: readonly Resource[]): string {
  const seg = resolveSegmentArg(value, resources);
  if ('denied' in seg) throw new Error(`resend: ${seg.denied}`);
  return seg.resource.ref;
}

/** The `id` of an email or a broadcast as a path segment, read as the classifier read it. */
function idSegment(value: unknown): string {
  const id = pathIdent(value);
  if (id === null) throw new Error(`resend: ${MALFORMED_ID}`);
  return id;
}

/** A contact id or address as a path segment, read as the classifier read it. */
function contactSegment(value: unknown): string {
  const contact = contactSelector(value);
  if (contact === null) throw new Error(`resend: ${MALFORMED_CONTACT}`);
  return contact.segment;
}

function segmentOf(broadcast: BroadcastDto): string | null {
  return broadcast.segment_id ?? broadcast.audience_id ?? null;
}

/** Read the broadcast and refuse it unless it targets the segment the call names. */
async function broadcastInSegment(ctx: ExecuteContext, args: Args): Promise<BroadcastDto> {
  const seg = segmentRef(args.segment_id, ctx.resources);
  const broadcast = (await request(
    ctx,
    'GET',
    `/broadcasts/${idSegment(args.id)}`,
  )) as BroadcastDto;
  const actual = segmentOf(broadcast);
  if (actual !== seg) {
    throw new Error(
      `resend: broadcast '${String(args.id)}' targets segment '${actual ?? 'unknown'}', not '${seg}'`,
    );
  }
  return broadcast;
}

/** The mission's domain resource a `from` address is on, or `null`. */
export function fromDomainOf(from: unknown, resources: readonly Resource[]): Resource | null {
  const parsed = parseAddress(from);
  if (!parsed) return null;
  const target = resolveDomain(parsed.domain, resources);
  return 'denied' in target ? null : target.resource;
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

async function listAll<T extends { readonly id: string }>(
  ctx: ConnectionContext,
  path: string,
): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  while (out.length < MAX_DISCOVERED_PER_KIND) {
    const page = (await request(ctx, 'GET', path, undefined, {
      limit: DISCOVERY_PAGE_SIZE,
      ...(after ? { after } : {}),
    })) as ListPage<T>;
    const data = page.data ?? [];
    out.push(...data);
    const last = data[data.length - 1];
    if (!page.has_more || !last) break;
    after = last.id;
  }
  return out;
}

function toQueryString(query: Args): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

async function request(
  ctx: ConnectionContext,
  method: HttpMethod,
  path: string,
  body?: unknown,
  query?: Args,
): Promise<unknown> {
  const secret = expectCredentialKind(RESEND_PROVIDER, ctx.credential, 'api-key');
  const key = secret.fields.api_key;
  if (!key) throw new Error('resend: the credential carries no api_key');

  const url = `${RESEND_API_BASE}${path}${query ? toQueryString(query) : ''}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
  };
  const init: RequestInit = { method, headers, ...(ctx.signal ? { signal: ctx.signal } : {}) };
  if (body !== undefined && method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const res = await ctx.fetch(url, init);
  const raw = await res.text();
  if (!res.ok) {
    const message = `Resend API ${method} ${path} ${res.status}: ${raw.slice(0, 500)}`;
    if (res.status === 401 || (res.status === 403 && errorNameOf(raw) !== 'validation_error')) {
      throw new UpstreamAuthError(message, res.status);
    }
    throw new UpstreamHttpError(message, res.status);
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function errorNameOf(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === 'string' ? parsed.name : null;
  } catch {
    return null;
  }
}

function text(payload: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}
