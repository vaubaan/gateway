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
 *   - broadcast calls re-read the broadcast upstream and refuse to act on one
 *     that belongs to another segment than the one the mission named ;
 *   - list calls return only the mission's resources (domains, segments) and
 *     the broadcasts of those segments ;
 *   - 401 → `UpstreamAuthError` ; 403 → `UpstreamAuthError` unless Resend
 *     names a `validation_error` (an unverified `from` domain is a 403 too).
 */

import {
  UpstreamAuthError,
  expectCredentialKind,
  type ConnectionContext,
  type ExecuteContext,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { classifyResend } from './classify.ts';
import {
  RESEND_PROVIDER,
  domainRef,
  domainResources,
  resolveDomain,
  resolveDomainArg,
  resolveSegmentArg,
  segmentResources,
  zoneConfigOf,
} from './resources.ts';
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
interface ContactDto {
  readonly id: string;
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
      return request(ctx, 'GET', `/emails/${enc(args.id)}`);
    case 'resend__list_domains': {
      const refs = new Set(domainResources(ctx.resources).map((r) => r.ref));
      const all = await listAll<DomainDto>(ctx, '/domains');
      return { data: all.filter((d) => refs.has(domainRef(d.name))) };
    }
    case 'resend__get_domain':
      return request(ctx, 'GET', `/domains/${enc(domainId(args.domain, ctx.resources))}`);
    case 'resend__list_segments': {
      const refs = new Set(segmentResources(ctx.resources).map((r) => r.ref));
      const all = await listAll<SegmentDto>(ctx, '/segments');
      return { data: all.filter((s) => refs.has(s.id)) };
    }
    case 'resend__get_segment':
      return request(ctx, 'GET', `/segments/${enc(segmentRef(args.segment_id, ctx.resources))}`);
    case 'resend__list_contacts': {
      const { segment_id, ...rest } = args;
      const query: Record<string, unknown> = { ...rest };
      if (segment_id !== undefined) query.segment_id = segmentRef(segment_id, ctx.resources);
      return request(ctx, 'GET', '/contacts', undefined, query);
    }
    case 'resend__get_contact':
      return request(ctx, 'GET', `/contacts/${enc(args.id)}`);
    case 'resend__list_broadcasts': {
      const refs = new Set(segmentResources(ctx.resources).map((r) => r.ref));
      const all = await listAll<BroadcastDto>(ctx, '/broadcasts');
      return { data: all.filter((b) => refs.has(segmentOf(b) ?? '')) };
    }
    case 'resend__get_broadcast':
      return broadcastInSegment(ctx, args);

    // ─── Writes — sends ───────────────────────────────────────────────────
    case 'resend__send_email':
      return request(ctx, 'POST', '/emails', args);
    case 'resend__send_batch_emails':
      // The batch endpoint takes the bare array as its body.
      return request(ctx, 'POST', '/emails/batch', args.emails);

    // ─── Writes — domains ─────────────────────────────────────────────────
    case 'resend__create_domain':
      return request(ctx, 'POST', '/domains', args);
    case 'resend__update_domain': {
      const { domain, ...body } = args;
      return request(ctx, 'PATCH', `/domains/${enc(domainId(domain, ctx.resources))}`, body);
    }
    case 'resend__delete_domain':
      return request(ctx, 'DELETE', `/domains/${enc(domainId(args.domain, ctx.resources))}`);
    case 'resend__verify_domain':
      return request(ctx, 'POST', `/domains/${enc(domainId(args.domain, ctx.resources))}/verify`);

    // ─── Writes — segments and members ────────────────────────────────────
    case 'resend__create_segment':
      return request(ctx, 'POST', '/segments', { name: args.name });
    case 'resend__delete_segment':
      return request(ctx, 'DELETE', `/segments/${enc(segmentRef(args.segment_id, ctx.resources))}`);
    case 'resend__create_contact': {
      const { segment_id, ...body } = args;
      const created = (await request(ctx, 'POST', '/contacts', body)) as ContactDto;
      if (segment_id === undefined) return created;
      const seg = segmentRef(segment_id, ctx.resources);
      const membership = await request(
        ctx,
        'POST',
        `/contacts/${enc(created.id)}/segments/${enc(seg)}`,
      );
      return { ...created, segment: membership };
    }
    case 'resend__update_contact': {
      const { id, ...body } = args;
      return request(ctx, 'PATCH', `/contacts/${enc(id)}`, body);
    }
    case 'resend__delete_contact':
      return request(ctx, 'DELETE', `/contacts/${enc(args.id)}`);
    case 'resend__add_contact_to_segment':
      return request(
        ctx,
        'POST',
        `/contacts/${enc(args.id)}/segments/${enc(segmentRef(args.segment_id, ctx.resources))}`,
      );
    case 'resend__remove_contact_from_segment':
      return request(
        ctx,
        'DELETE',
        `/contacts/${enc(args.id)}/segments/${enc(segmentRef(args.segment_id, ctx.resources))}`,
      );

    // ─── Writes — broadcasts ──────────────────────────────────────────────
    case 'resend__create_broadcast': {
      const { segment_id, ...body } = args;
      return request(ctx, 'POST', '/broadcasts', {
        ...body,
        segment_id: segmentRef(segment_id, ctx.resources),
      });
    }
    case 'resend__update_broadcast': {
      await broadcastInSegment(ctx, args);
      const { segment_id: _segment, id, ...body } = args;
      return request(ctx, 'PATCH', `/broadcasts/${enc(id)}`, body);
    }
    case 'resend__send_broadcast':
      await broadcastInSegment(ctx, args);
      return request(ctx, 'POST', `/broadcasts/${enc(args.id)}/send`, {});
    case 'resend__delete_broadcast':
      await broadcastInSegment(ctx, args);
      return request(ctx, 'DELETE', `/broadcasts/${enc(args.id)}`);

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

// ─── Resource plumbing ───────────────────────────────────────────────────────

/** The Resend id of a mission domain, from the resource metadata discovery wrote. */
function domainId(value: unknown, resources: readonly Resource[]): string {
  const target = resolveDomainArg(value, resources);
  if ('denied' in target) throw new Error(`resend: ${target.denied}`);
  const id = target.resource.metadata?.domain_id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(
      `resend: resource '${target.resource.ref}' carries no domain_id — refresh the connection's resources`,
    );
  }
  return id;
}

function segmentRef(value: unknown, resources: readonly Resource[]): string {
  const seg = resolveSegmentArg(value, resources);
  if ('denied' in seg) throw new Error(`resend: ${seg.denied}`);
  return seg.resource.ref;
}

function segmentOf(broadcast: BroadcastDto): string | null {
  return broadcast.segment_id ?? broadcast.audience_id ?? null;
}

/** Read the broadcast and refuse it unless it targets the segment the call names. */
async function broadcastInSegment(ctx: ExecuteContext, args: Args): Promise<BroadcastDto> {
  const seg = segmentRef(args.segment_id, ctx.resources);
  const broadcast = (await request(ctx, 'GET', `/broadcasts/${enc(args.id)}`)) as BroadcastDto;
  const actual = segmentOf(broadcast);
  if (actual !== seg) {
    throw new Error(
      `resend: broadcast '${String(args.id)}' targets segment '${actual ?? 'unknown'}', not '${seg}'`,
    );
  }
  return broadcast;
}

/** Exported for the host and tests : is this `from` on a mission domain ? */
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

function enc(value: unknown): string {
  return encodeURIComponent(String(value));
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
    throw new Error(message);
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
