/**
 * Upstream calls of the `cloudflare-dns` provider — Cloudflare REST API v4.
 *
 * Spec : docs/spec/vaubaan-gateway.md §2.4 — the credential arrives decrypted
 *        in the context, is used for one call, and never reaches the agent.
 *
 * Rules :
 *   - `fetch` comes from the context, never from the global ;
 *   - the bearer is the `api_token` field of the `api-key` secret ; a
 *     Global API Key (`email|key`) is never accepted ;
 *   - the zone in the URL is the **resolved mission resource**, never the
 *     raw argument ; `zone_id` / `record_id` are consumed and not forwarded ;
 *   - `update_record` is preceded by a read of the record : when the call
 *     declared an ordinary record (`type` + `name`) but the record is apex,
 *     wildcard, MX or NS, the call is refused before the PATCH ;
 *   - `list_zones` is filtered to the mission's zones ;
 *   - 401 / 403 from Cloudflare → `UpstreamAuthError`.
 */

import {
  UpstreamAuthError,
  expectCredentialKind,
  type ConnectionContext,
  type ExecuteContext,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import {
  CLOUDFLARE_DNS_PROVIDER,
  SAFE_IDENT,
  isCriticalRecord,
  recordSensitivity,
  resolveZoneResource,
  zoneNameOf,
} from './resources.ts';

/** Public API of the provider — a fact about Cloudflare, not instance configuration. */
export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

/** Discovery stops after this many zones (10 pages of 50). */
export const MAX_DISCOVERED_ZONES = 500;
const DISCOVERY_PAGE_SIZE = 50;

/** Credential field holding the API token. */
export const API_TOKEN_FIELD = 'api_token';

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type Args = Readonly<Record<string, unknown>>;

interface Route {
  readonly method: HttpMethod;
  /** Path under `/client/v4`, built from the zone and (when relevant) the record id. */
  readonly path: (zone: string, record: string) => string;
  /** How the remaining arguments travel : query string, JSON body, multipart `file`, or not at all. */
  readonly payload: 'query' | 'json' | 'multipart' | 'none';
  /** Whether the route needs `record_id`. */
  readonly record?: boolean;
}

const z = (zone: string) => `/zones/${encodeURIComponent(zone)}`;
const r = (zone: string, record: string) => `${z(zone)}/dns_records/${encodeURIComponent(record)}`;

/** Tool → Cloudflare endpoint. Every declared tool has a row ; the classifier enforces the inverse. */
const ROUTES: Readonly<Record<string, Route>> = {
  // reads
  cloudflare_dns__list_zones: { method: 'GET', path: () => '/zones', payload: 'query' },
  cloudflare_dns__get_zone: { method: 'GET', path: z, payload: 'none' },
  cloudflare_dns__list_records: {
    method: 'GET',
    path: (zone) => `${z(zone)}/dns_records`,
    payload: 'query',
  },
  cloudflare_dns__get_record: { method: 'GET', path: r, payload: 'none', record: true },
  cloudflare_dns__export_records: {
    method: 'GET',
    path: (zone) => `${z(zone)}/dns_records/export`,
    payload: 'none',
  },
  cloudflare_dns__get_zone_settings: {
    method: 'GET',
    path: (zone) => `${z(zone)}/settings`,
    payload: 'none',
  },
  cloudflare_dns__get_dnssec: {
    method: 'GET',
    path: (zone) => `${z(zone)}/dnssec`,
    payload: 'none',
  },
  // writes — records
  cloudflare_dns__create_record: {
    method: 'POST',
    path: (zone) => `${z(zone)}/dns_records`,
    payload: 'json',
  },
  cloudflare_dns__update_record: { method: 'PATCH', path: r, payload: 'json', record: true },
  cloudflare_dns__delete_record: { method: 'DELETE', path: r, payload: 'none', record: true },
  cloudflare_dns__import_records: {
    method: 'POST',
    path: (zone) => `${z(zone)}/dns_records/import`,
    payload: 'multipart',
  },
  // writes — zone-level
  cloudflare_dns__edit_zone_settings: {
    method: 'PATCH',
    path: (zone) => `${z(zone)}/settings`,
    payload: 'json',
  },
  cloudflare_dns__purge_cache: {
    method: 'POST',
    path: (zone) => `${z(zone)}/purge_cache`,
    payload: 'json',
  },
  cloudflare_dns__edit_dnssec: {
    method: 'PATCH',
    path: (zone) => `${z(zone)}/dnssec`,
    payload: 'json',
  },
  cloudflare_dns__delete_zone: { method: 'DELETE', path: z, payload: 'none' },
};

// ─── v5 entry points ──────────────────────────────────────────────────────────

export async function executeCloudflareDns(
  ctx: ExecuteContext,
  tool: string,
  args: Args,
): Promise<McpToolResult> {
  const route = ROUTES[tool];
  if (!route) return { content: [{ type: 'text', text: `unknown tool '${tool}'` }], isError: true };
  const headers = bearerHeaders(tokenOf(ctx));

  if (tool === 'cloudflare_dns__list_zones') {
    const payload = await callCloudflareApi(ctx.fetch, headers, route, '/zones', args, ctx.signal);
    return textResult(filterZonesToMission(payload, ctx.resources));
  }

  const target = resolveZoneResource(args, ctx.resources);
  if ('denied' in target) throw new Error(`cloudflare-dns: ${target.denied}`);
  const zone = target.resource;
  const { zone_id: _zone, record_id, ...rest } = args;
  const record = route.record ? recordIdArg(record_id) : '';
  const path = route.path(zone.ref, record);

  if (tool === 'cloudflare_dns__update_record') {
    await assertDeclaredSensitivity(ctx, headers, zone, path, args);
  }

  const payload = await callCloudflareApi(ctx.fetch, headers, route, path, rest, ctx.signal);
  return textResult(payload);
}

interface ZoneDto {
  readonly id: string;
  readonly name: string;
  readonly status?: string;
  readonly account?: { readonly id?: string; readonly name?: string } | null;
}

interface ZoneListDto {
  readonly result?: readonly ZoneDto[];
  readonly result_info?: { readonly total_pages?: number };
}

/**
 * One resource per zone the token reaches : `GET /zones` paginated (50 per
 * page, at most `MAX_DISCOVERED_ZONES`). No account filter — a token may
 * cover zones of several accounts ; the account travels in the metadata.
 */
export async function discoverCloudflareDnsResources(
  ctx: ConnectionContext,
): Promise<readonly Resource[]> {
  const headers = bearerHeaders(tokenOf(ctx));
  const resources: Resource[] = [];
  for (let page = 1; resources.length < MAX_DISCOVERED_ZONES; page += 1) {
    const dto = (await callCloudflareApi(
      ctx.fetch,
      headers,
      ROUTES.cloudflare_dns__list_zones!,
      '/zones',
      { page, per_page: DISCOVERY_PAGE_SIZE },
      ctx.signal,
    )) as ZoneListDto;
    const zones = dto.result ?? [];
    for (const zone of zones) {
      if (resources.length >= MAX_DISCOVERED_ZONES) break;
      resources.push(zoneResource(zone));
    }
    const totalPages = dto.result_info?.total_pages ?? page;
    if (zones.length < DISCOVERY_PAGE_SIZE || page >= totalPages) break;
  }
  return resources;
}

function zoneResource(zone: ZoneDto): Resource {
  const metadata: Record<string, string> = { zone_name: zone.name };
  if (zone.account?.id) metadata.account_id = zone.account.id;
  if (zone.account?.name) metadata.account_name = zone.account.name;
  if (zone.status) metadata.status = zone.status;
  return {
    provider: CLOUDFLARE_DNS_PROVIDER,
    ref: zone.id,
    displayName: zone.name,
    metadata,
  };
}

function tokenOf(ctx: ConnectionContext): string {
  const secret = expectCredentialKind(CLOUDFLARE_DNS_PROVIDER, ctx.credential, 'api-key');
  const token = secret.fields[API_TOKEN_FIELD];
  if (!token) throw new Error(`cloudflare-dns: the credential has no '${API_TOKEN_FIELD}' field`);
  return token;
}

function recordIdArg(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_IDENT.test(value)) {
    throw new Error('cloudflare-dns: record_id: missing or malformed identifier');
  }
  return value;
}

/** Keep only the zones of the mission in a `GET /zones` answer ; `result_info` is left as upstream sent it. */
function filterZonesToMission(payload: unknown, resources: readonly Resource[]): unknown {
  if (typeof payload !== 'object' || payload === null) return payload;
  const dto = payload as ZoneListDto;
  const zones = dto.result;
  if (!isZoneList(zones)) return payload;
  const refs = new Set(
    resources.filter((x) => x.provider === CLOUDFLARE_DNS_PROVIDER).map((x) => x.ref),
  );
  return { ...dto, result: zones.filter((zone) => refs.has(zone.id)) };
}

/** `Array.isArray` narrows to `any[]` ; this guard keeps the element type. */
function isZoneList(x: unknown): x is readonly ZoneDto[] {
  return Array.isArray(x);
}

interface RecordDto {
  readonly result?: { readonly type?: string; readonly name?: string } | null;
}

/**
 * An update declared as an ordinary record (`type` + `name` of a subdomain
 * record) must target a record that is ordinary today ; otherwise the agent
 * could move an apex record away while accepting only `record-write`.
 */
async function assertDeclaredSensitivity(
  ctx: ExecuteContext,
  headers: Record<string, string>,
  zone: Resource,
  recordPath: string,
  args: Args,
): Promise<void> {
  const zoneName = zoneNameOf(zone);
  if (recordSensitivity(args, zoneName) === 'critical') return;
  const current = (await callCloudflareApi(
    ctx.fetch,
    headers,
    ROUTES.cloudflare_dns__get_record!,
    recordPath,
    {},
    ctx.signal,
  )) as RecordDto;
  const type = current.result?.type ?? '';
  const name = current.result?.name ?? '';
  if (isCriticalRecord(type, name, zoneName)) {
    throw new Error(
      `cloudflare-dns: the record is a critical record (${type} ${name}) but the call ` +
        `declared an ordinary one (${String(args.type)} ${String(args.name)}) ; name the ` +
        'record as it is so the change is classified as a critical record write',
    );
  }
}

function textResult(payload: unknown): McpToolResult {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text }] };
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function bearerHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' };
}

function toQueryString(args: Args): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === null || value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

async function callCloudflareApi(
  fetchImpl: typeof fetch,
  authHeaders: Readonly<Record<string, string>>,
  route: Pick<Route, 'method' | 'payload'>,
  path: string,
  args: Args,
  signal?: AbortSignal,
): Promise<unknown> {
  let url = `${CLOUDFLARE_API_BASE}${path}`;
  const headers: Record<string, string> = { ...authHeaders };
  const init: RequestInit = { method: route.method, headers, ...(signal ? { signal } : {}) };

  switch (route.payload) {
    case 'query':
      url += toQueryString(args);
      break;
    case 'json':
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(args);
      break;
    case 'multipart': {
      const form = new FormData();
      form.append(
        'file',
        new Blob([String(args.file ?? '')], { type: 'application/octet-stream' }),
        'records.txt',
      );
      init.body = form;
      break;
    }
    case 'none':
      break;
  }

  const res = await fetchImpl(url, init);
  const text = await res.text();
  if (!res.ok) {
    const message = `Cloudflare API ${route.method} ${path} ${res.status}: ${text.slice(0, 500)}`;
    if (res.status === 401 || res.status === 403) throw new UpstreamAuthError(message, res.status);
    throw new Error(message);
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
