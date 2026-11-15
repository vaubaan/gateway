/**
 * Upstream calls of the `resend` service — Resend REST API, JSON bodies.
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
 *   - every request goes through the SDK's `httpJson` : 401 →
 *     `UpstreamAuthError` ; 403 → `UpstreamAuthError` unless Resend names a
 *     `validation_error` (an unverified `from` domain is a 403 too) ; an
 *     answer that is not JSON, or not the shape a guard below reads →
 *     `UpstreamProtocolError`.
 */

import {
  ExecutorRefusal,
  UpstreamAuthError,
  UpstreamHttpError,
  UpstreamProtocolError,
  anyJson,
  declining,
  expectCredentialKind,
  httpJson,
  isList,
  isRecord,
  jsonResult,
  readShape,
  type AccountContext,
  type Guard,
  type ExecuteContext,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { MALFORMED_CONTACT, MALFORMED_ID, classifyResend } from './classify.ts';
import { SERVICE_ID, TOOL } from './identity.ts';
import {
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
import { EMAIL_FIELDS, RESEND_TOOL_NAMES, declaredFieldsOf } from './tools.ts';
import { parseAddress } from './zones.ts';

/** Public API of the service — a fact about Resend, not instance configuration. */
export const RESEND_API_BASE = 'https://api.resend.com';

/** Page size of the list endpoints (Resend's maximum). */
export const DISCOVERY_PAGE_SIZE = 100;
/** Upper bound of resources discovered per kind ; beyond it the owner narrows the account. */
export const MAX_DISCOVERED_PER_KIND = 500;

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type Args = Readonly<Record<string, unknown>>;

// ─── What Resend answers, read through guards ─────────────────────────────────

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
  readonly name?: string;
}
interface BroadcastDto {
  readonly id?: string;
  readonly segment_id?: string | null;
  readonly audience_id?: string | null;
}

const optional = (value: unknown, type: 'string' | 'boolean'): boolean =>
  value === undefined || typeof value === type;
const optionalOrNull = (value: unknown): boolean => value === null || optional(value, 'string');

function isDomainDto(x: unknown): x is DomainDto {
  return (
    isRecord(x) &&
    typeof x.id === 'string' &&
    typeof x.name === 'string' &&
    optional(x.status, 'string') &&
    optional(x.region, 'string')
  );
}

function isSegmentDto(x: unknown): x is SegmentDto {
  return isRecord(x) && typeof x.id === 'string' && optional(x.name, 'string');
}

/** A broadcast as the segment guard reads it : its segment, under its current or its former name. */
function isBroadcastDto(x: unknown): x is BroadcastDto {
  return (
    isRecord(x) &&
    optional(x.id, 'string') &&
    optionalOrNull(x.segment_id) &&
    optionalOrNull(x.audience_id)
  );
}

/** A listed broadcast : its id is the cursor of the next page. */
function isListedBroadcast(x: unknown): x is BroadcastDto & { readonly id: string } {
  return isBroadcastDto(x) && typeof x.id === 'string';
}

function isListPageOf<T>(item: Guard<T>): Guard<ListPage<T>> {
  return (x: unknown): x is ListPage<T> =>
    isRecord(x) &&
    (x.data === undefined || (isList(x.data) && x.data.every(item))) &&
    optional(x.has_more, 'boolean');
}

// ─── v5 entry points ──────────────────────────────────────────────────────────

/**
 * Everything the classifier denies, and every guard below that does not hold (a
 * broadcast of another segment), is declined : an `isError` result, no request
 * beyond the reads the guard itself needed, nothing failed at Resend.
 */
export function executeResend(
  ctx: ExecuteContext,
  tool: string,
  args: Args,
): Promise<McpToolResult> {
  return declining(async () => {
    const outcome = classifyResend(tool, args, ctx.resources);
    if ('denied' in outcome) {
      throw new ExecutorRefusal(
        RESEND_TOOL_NAMES.has(tool) ? `resend: ${outcome.denied}` : outcome.denied,
      );
    }
    return jsonResult(await dispatch(ctx, tool, args));
  });
}

async function dispatch(ctx: ExecuteContext, tool: string, args: Args): Promise<unknown> {
  switch (tool) {
    // ─── Reads ────────────────────────────────────────────────────────────
    case TOOL.getEmail:
      return request(ctx, 'GET', `/emails/${idSegment(args.id)}`);
    case TOOL.listDomains: {
      const refs = new Set(domainResources(ctx.resources).map((r) => r.ref));
      const all = await listAll(ctx, '/domains', isDomainDto);
      return { data: all.filter((d) => refs.has(domainRef(d.name))) };
    }
    case TOOL.getDomain:
      return request(ctx, 'GET', `/domains/${domainId(args.domain, ctx.resources)}`);
    case TOOL.listSegments: {
      const refs = new Set(segmentResources(ctx.resources).map((r) => r.ref));
      const all = await listAll(ctx, '/segments', isSegmentDto);
      return { data: all.filter((s) => refs.has(s.id)) };
    }
    case TOOL.getSegment:
      return request(ctx, 'GET', `/segments/${segmentRef(args.segment_id, ctx.resources)}`);
    case TOOL.listContacts: {
      const query = forwarded(tool, args, ['segment_id']);
      if (args.segment_id !== undefined) {
        query.segment_id = segmentRef(args.segment_id, ctx.resources);
      }
      return request(ctx, 'GET', '/contacts', undefined, query);
    }
    case TOOL.getContact:
      return request(ctx, 'GET', `/contacts/${contactSegment(args.id)}`);
    case TOOL.listBroadcasts: {
      const refs = new Set(segmentResources(ctx.resources).map((r) => r.ref));
      const all = await listAll(ctx, '/broadcasts', isListedBroadcast);
      return { data: all.filter((b) => refs.has(segmentOf(b) ?? '')) };
    }
    case TOOL.getBroadcast:
      return broadcastInSegment(ctx, args);

    // ─── Writes — sends ───────────────────────────────────────────────────
    case TOOL.sendEmail:
      return request(ctx, 'POST', '/emails', forwarded(tool, args));
    case TOOL.sendBatchEmails:
      // The batch endpoint takes the bare array as its body.
      return request(ctx, 'POST', '/emails/batch', batchBody(args.emails));

    // ─── Writes — domains ─────────────────────────────────────────────────
    case TOOL.createDomain:
      return request(ctx, 'POST', '/domains', forwarded(tool, args));
    case TOOL.updateDomain:
      return request(
        ctx,
        'PATCH',
        `/domains/${domainId(args.domain, ctx.resources)}`,
        forwarded(tool, args, ['domain']),
      );
    case TOOL.deleteDomain:
      return request(ctx, 'DELETE', `/domains/${domainId(args.domain, ctx.resources)}`);
    case TOOL.verifyDomain:
      return request(ctx, 'POST', `/domains/${domainId(args.domain, ctx.resources)}/verify`);

    // ─── Writes — segments and members ────────────────────────────────────
    case TOOL.createSegment:
      return request(ctx, 'POST', '/segments', { name: args.name });
    case TOOL.deleteSegment:
      return request(ctx, 'DELETE', `/segments/${segmentRef(args.segment_id, ctx.resources)}`);
    case TOOL.createContact: {
      const body = forwarded(tool, args, ['segment_id']);
      const created = await request(ctx, 'POST', '/contacts', body);
      if (args.segment_id === undefined) return created;
      const seg = segmentRef(args.segment_id, ctx.resources);
      // The id comes from the service's answer : it is not trusted to be a path segment.
      const contact = isRecord(created) ? pathIdent(created.id) : null;
      if (!isRecord(created) || contact === null) {
        // Resend answered a creation without the id its API promises : its failure.
        throw new UpstreamProtocolError(
          `resend: the contact was created but Resend returned no id — it was not added to segment '${seg}'`,
        );
      }
      const membership = await request(ctx, 'POST', `/contacts/${contact}/segments/${seg}`);
      return { ...created, segment: membership };
    }
    case TOOL.updateContact:
      return request(
        ctx,
        'PATCH',
        `/contacts/${contactSegment(args.id)}`,
        forwarded(tool, args, ['id']),
      );
    case TOOL.deleteContact:
      return request(ctx, 'DELETE', `/contacts/${contactSegment(args.id)}`);
    case TOOL.addContactToSegment:
      return request(
        ctx,
        'POST',
        `/contacts/${contactSegment(args.id)}/segments/${segmentRef(args.segment_id, ctx.resources)}`,
      );
    case TOOL.removeContactFromSegment:
      return request(
        ctx,
        'DELETE',
        `/contacts/${contactSegment(args.id)}/segments/${segmentRef(args.segment_id, ctx.resources)}`,
      );

    // ─── Writes — broadcasts ──────────────────────────────────────────────
    case TOOL.createBroadcast:
      return request(ctx, 'POST', '/broadcasts', {
        ...forwarded(tool, args, ['segment_id']),
        segment_id: segmentRef(args.segment_id, ctx.resources),
      });
    case TOOL.updateBroadcast:
      await broadcastInSegment(ctx, args);
      return request(
        ctx,
        'PATCH',
        `/broadcasts/${idSegment(args.id)}`,
        forwarded(tool, args, ['segment_id', 'id']),
      );
    case TOOL.sendBroadcast:
      await broadcastInSegment(ctx, args);
      return request(ctx, 'POST', `/broadcasts/${idSegment(args.id)}/send`, {});
    case TOOL.deleteBroadcast:
      await broadcastInSegment(ctx, args);
      return request(ctx, 'DELETE', `/broadcasts/${idSegment(args.id)}`);

    // ─── Synthetic ────────────────────────────────────────────────────────
    case TOOL.describeZones:
      return {
        domains: domainResources(ctx.resources).map((r) => ({
          domain: r.ref,
          env: r.env ?? null,
          ...zoneConfigOf(r),
        })),
      };

    default:
      // Unreachable : the classifier refused unknown tools above.
      throw new ExecutorRefusal(`resend: tool not implemented: ${tool}`);
  }
}

/**
 * Resources reachable with this API key : one per sending domain (ref = domain
 * name, zone lists empty until the owner fills them) and one per segment
 * (ref = segment id). Requires a full-access key : a `sending_access` key is
 * refused by `GET /domains` and surfaces as `UpstreamAuthError`.
 */
export async function discoverResendResources(ctx: AccountContext): Promise<readonly Resource[]> {
  expectCredentialKind(SERVICE_ID, ctx.credential, 'api-key');
  const domains = await listAll(ctx, '/domains', isDomainDto);
  const segments = await listAll(ctx, '/segments', isSegmentDto);
  return [
    ...domains.map((d): Resource => ({
      service: SERVICE_ID,
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
    })),
    ...segments.map((s): Resource => ({
      service: SERVICE_ID,
      ref: s.id,
      // A segment Resend lists without a name is shown by its id.
      displayName: s.name ?? s.id,
      metadata: { kind: 'segment', segment_id: s.id },
    })),
  ];
}

// ─── Forwarded fields ────────────────────────────────────────────────────────

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
  if (!Array.isArray(emails))
    throw new ExecutorRefusal('resend: emails: expected a list of emails');
  return emails.map((email: unknown) => pick(isRecord(email) ? email : {}, EMAIL_FIELDS));
}

// ─── Resource plumbing ───────────────────────────────────────────────────────

/** The Resend id of a mission domain (one path segment), from the resource metadata discovery wrote. */
function domainId(value: unknown, resources: readonly Resource[]): string {
  const target = resolveDomainArg(value, resources);
  if ('denied' in target) throw new ExecutorRefusal(`resend: ${target.denied}`);
  const id = domainIdOf(target.resource);
  if ('denied' in id) throw new ExecutorRefusal(`resend: ${id.denied}`);
  return id.id;
}

/** The ref of a mission segment : one path segment (`resolveSegmentArg` returns nothing else). */
function segmentRef(value: unknown, resources: readonly Resource[]): string {
  const seg = resolveSegmentArg(value, resources);
  if ('denied' in seg) throw new ExecutorRefusal(`resend: ${seg.denied}`);
  return seg.resource.ref;
}

/** The `id` of an email or a broadcast as a path segment, read as the classifier read it. */
function idSegment(value: unknown): string {
  const id = pathIdent(value);
  if (id === null) throw new ExecutorRefusal(`resend: ${MALFORMED_ID}`);
  return id;
}

/** A contact id or address as a path segment, read as the classifier read it. */
function contactSegment(value: unknown): string {
  const contact = contactSelector(value);
  if (contact === null) throw new ExecutorRefusal(`resend: ${MALFORMED_CONTACT}`);
  return contact.segment;
}

function segmentOf(broadcast: BroadcastDto): string | null {
  return broadcast.segment_id ?? broadcast.audience_id ?? null;
}

/** Read the broadcast and refuse it unless it targets the segment the call names. */
async function broadcastInSegment(ctx: ExecuteContext, args: Args): Promise<BroadcastDto> {
  const seg = segmentRef(args.segment_id, ctx.resources);
  const path = `/broadcasts/${idSegment(args.id)}`;
  const broadcast = readShape(
    await request(ctx, 'GET', path),
    isBroadcastDto,
    `GET ${path}: a broadcast`,
  );
  const actual = segmentOf(broadcast);
  if (actual !== seg) {
    throw new ExecutorRefusal(
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
  ctx: AccountContext,
  path: string,
  item: Guard<T>,
): Promise<T[]> {
  const isPage = isListPageOf(item);
  const out: T[] = [];
  let after: string | undefined;
  while (out.length < MAX_DISCOVERED_PER_KIND) {
    const answer = await request(ctx, 'GET', path, undefined, {
      limit: DISCOVERY_PAGE_SIZE,
      ...(after ? { after } : {}),
    });
    const page = readShape(answer, isPage, `GET ${path}: a page of { data: [{ id, … }] }`);
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

/** The `authorization` header of a Resend account. */
export function authorizationOf(ctx: AccountContext): Readonly<Record<string, string>> {
  const key = expectCredentialKind(SERVICE_ID, ctx.credential, 'api-key').fields.api_key;
  if (!key) throw new Error('resend: the credential carries no api_key');
  return { authorization: `Bearer ${key}` };
}

/**
 * The `name` of Resend's error document (`{ statusCode, name, message }`),
 * read from the answer the failure quotes, or `null`. The SDK quotes the
 * first 300 characters : Resend's error documents are shorter.
 */
export function resendErrorName(failure: Error): string | null {
  return /"name"\s*:\s*"([a-z_]+)"/i.exec(failure.message)?.[1] ?? null;
}

/** Resend's name of a request it refuses as invalid, whatever its status. */
const VALIDATION_ERROR = 'validation_error';

/**
 * One request to the Resend API. An answer without content is `{}` : the
 * agent reads a confirmation.
 */
async function request(
  ctx: AccountContext,
  method: HttpMethod,
  path: string,
  body?: unknown,
  query?: Args,
): Promise<unknown> {
  const url = `${RESEND_API_BASE}${path}${query ? toQueryString(query) : ''}`;
  try {
    const answer = await httpJson(
      ctx,
      {
        url,
        method,
        headers: authorizationOf(ctx),
        what: `Resend API ${method} ${path}`,
        ...(body !== undefined && method !== 'GET' ? { body } : {}),
      },
      anyJson,
    );
    return answer ?? {};
  } catch (error) {
    // An unverified `from` domain is answered 403 too : the request's fault, not the key's.
    if (
      error instanceof UpstreamAuthError &&
      error.upstreamStatus === 403 &&
      resendErrorName(error) === VALIDATION_ERROR
    ) {
      throw new UpstreamHttpError(error.message, error.upstreamStatus);
    }
    throw error;
  }
}
