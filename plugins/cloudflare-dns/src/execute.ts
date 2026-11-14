/**
 * Upstream calls of the `cloudflare-dns` provider — Cloudflare REST API v4.
 *
 * Spec : docs/spec/vaubaan-gateway.md §2.4 — the credential arrives decrypted
 *        in the context, is used for one call, and never reaches the agent.
 *
 * Rules :
 *   - every request goes through `cloudflare-api.ts`, on the SDK's transport :
 *     `fetch` and the signal come from the context, the answer is bounded ;
 *   - the bearer is the `api_token` field of the `api-key` secret ; a
 *     Global API Key (`email|key`) is never accepted ;
 *   - the zone in the URL is the **resolved mission resource**, never the
 *     raw argument ; `zone_id` / `record_id` are consumed and not forwarded ;
 *   - every identifier interpolated into the path (zone ref, `record_id`)
 *     passes `pathIdent`, the function the classifier uses : a dot segment
 *     or a separator is refused before any call ;
 *   - `update_record` and `delete_record` are preceded by a read of the
 *     record when the call declared an ordinary one (`type` + `name`) : if
 *     the record is apex, wildcard, MX or NS, or cannot be read back, the
 *     call is refused before the PATCH / DELETE ;
 *   - `list_zones` is filtered to the mission's zones ;
 *   - a provider failure is **thrown**, never turned into a result : 401 /
 *     403 from Cloudflare → `UpstreamAuthError`, any other failed status →
 *     `UpstreamHttpError`, an answer that is not JSON (but for the BIND
 *     export) or not the envelope read → `UpstreamProtocolError`. The host
 *     records it as `upstream_error` in the audit ;
 *   - what this executor declines itself (an unknown tool, an undeclared
 *     argument, a zone outside the mission, a malformed identifier, a
 *     critical record declared as an ordinary one) is an `ExecutorRefusal`,
 *     turned into the `isError` result by `declining` : nothing failed at
 *     the provider.
 */

import {
  ExecutorRefusal,
  anyJson,
  declining,
  isList,
  isRecord,
  jsonResult,
  refusalResult,
  textResult,
  type AccountContext,
  type ExecuteContext,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { undeclaredArgument } from './classify.ts';
import {
  callCloudflareApi,
  callCloudflareText,
  envelopeOf,
  tokenOf,
  type Endpoint,
} from './cloudflare-api.ts';
import { PROVIDER_ID, TOOL } from './identity.ts';
import {
  isCriticalRecord,
  pathIdent,
  recordSensitivity,
  resolveZoneResource,
  zoneNameOf,
} from './resources.ts';

/** Discovery stops after this many zones (10 pages of 50). */
export const MAX_DISCOVERED_ZONES = 500;
const DISCOVERY_PAGE_SIZE = 50;

type Args = Readonly<Record<string, unknown>>;

interface Route extends Endpoint {
  /** Path under `/client/v4`, built from the zone and (when relevant) the record id. */
  readonly path: (zone: string, record: string) => string;
  /** Whether the route needs `record_id`. */
  readonly record?: boolean;
  /** The BIND export answers a text file, passed to the agent as it is ; every other route JSON. */
  readonly answer?: 'bind-text';
}

/** One path segment. Refuses anything `pathIdent` refuses : `encodeURIComponent` would let `..` through. */
function segment(value: string): string {
  if (pathIdent(value) === null) {
    throw new ExecutorRefusal(
      `${PROVIDER_ID}: refusing to build a request path from an unsafe identifier`,
    );
  }
  return encodeURIComponent(value);
}

const z = (zone: string) => `/zones/${segment(zone)}`;
const r = (zone: string, record: string) => `${z(zone)}/dns_records/${segment(record)}`;

/** Record writes on an existing record : their declared sensitivity is checked against the record. */
const SENSITIVITY_GUARDED_TOOLS: ReadonlySet<string> = new Set([
  TOOL.updateRecord,
  TOOL.deleteRecord,
]);

/** Tool → Cloudflare endpoint. Every declared tool has a row ; the classifier enforces the inverse. */
const ROUTES: Readonly<Record<string, Route>> = {
  // reads
  [TOOL.listZones]: { method: 'GET', path: () => '/zones', payload: 'query' },
  [TOOL.getZone]: { method: 'GET', path: z, payload: 'none' },
  [TOOL.listRecords]: {
    method: 'GET',
    path: (zone) => `${z(zone)}/dns_records`,
    payload: 'query',
  },
  [TOOL.getRecord]: { method: 'GET', path: r, payload: 'none', record: true },
  [TOOL.exportRecords]: {
    method: 'GET',
    path: (zone) => `${z(zone)}/dns_records/export`,
    payload: 'none',
    answer: 'bind-text',
  },
  [TOOL.getZoneSettings]: {
    method: 'GET',
    path: (zone) => `${z(zone)}/settings`,
    payload: 'none',
  },
  [TOOL.getDnssec]: {
    method: 'GET',
    path: (zone) => `${z(zone)}/dnssec`,
    payload: 'none',
  },
  // writes — records
  [TOOL.createRecord]: {
    method: 'POST',
    path: (zone) => `${z(zone)}/dns_records`,
    payload: 'json',
  },
  [TOOL.updateRecord]: { method: 'PATCH', path: r, payload: 'json', record: true },
  [TOOL.deleteRecord]: { method: 'DELETE', path: r, payload: 'none', record: true },
  [TOOL.importRecords]: {
    method: 'POST',
    path: (zone) => `${z(zone)}/dns_records/import`,
    payload: 'multipart',
  },
  // writes — zone-level
  [TOOL.editZoneSettings]: {
    method: 'PATCH',
    path: (zone) => `${z(zone)}/settings`,
    payload: 'json',
  },
  [TOOL.purgeCache]: {
    method: 'POST',
    path: (zone) => `${z(zone)}/purge_cache`,
    payload: 'json',
  },
  [TOOL.editDnssec]: {
    method: 'PATCH',
    path: (zone) => `${z(zone)}/dnssec`,
    payload: 'json',
  },
  [TOOL.deleteZone]: { method: 'DELETE', path: z, payload: 'none' },
};

// ─── entry points ─────────────────────────────────────────────────────────────

export function executeCloudflareDns(
  ctx: ExecuteContext,
  tool: string,
  args: Args,
): Promise<McpToolResult> {
  return declining(async () => {
    const route = Object.hasOwn(ROUTES, tool) ? ROUTES[tool] : undefined;
    if (!route) return refusalResult(`unknown tool '${tool}'`);
    return executeRoute(ctx, tokenOf(ctx), route, tool, args);
  });
}

function refuseUndeclared(tool: string, args: Args): void {
  const undeclared = undeclaredArgument(tool, args);
  if (undeclared !== null) throw new ExecutorRefusal(`${PROVIDER_ID}: ${undeclared}`);
}

async function executeRoute(
  ctx: ExecuteContext,
  token: string,
  route: Route,
  tool: string,
  args: Args,
): Promise<McpToolResult> {
  if (tool === TOOL.listZones) {
    refuseUndeclared(tool, args);
    const answer = await callCloudflareApi(ctx, token, route, '/zones', args, isZoneListAnswer);
    return jsonResult(zonesOfTheMission(answer, ctx.resources));
  }

  const target = resolveZoneResource(args, ctx.resources);
  if ('denied' in target) throw new ExecutorRefusal(`${PROVIDER_ID}: ${target.denied}`);
  // The query string and the JSON body below are built from the arguments: only what
  // the tool declares — hence what the classifier read — may be in them.
  refuseUndeclared(tool, args);
  const zone = target.resource;
  const { zone_id: _zone, record_id, ...rest } = args;
  const record = route.record ? recordIdArg(record_id) : '';
  const path = route.path(zone.ref, record);

  if (SENSITIVITY_GUARDED_TOOLS.has(tool)) {
    await assertDeclaredSensitivity(ctx, token, zone, path, args);
  }

  if (route.answer === 'bind-text') return textResult(await callCloudflareText(ctx, token, path));
  // An empty answer (Cloudflare sends none in practice) reads as `{}`, as it always has.
  return jsonResult((await callCloudflareApi(ctx, token, route, path, rest, anyJson)) ?? {});
}

/** A zone as `GET /zones` lists it : the id and the name are read, the rest is optional. */
interface ZoneDto {
  readonly id: string;
  readonly name: string;
  readonly status?: unknown;
  readonly account?: unknown;
}

function isZoneDto(value: unknown): value is ZoneDto {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string';
}

function isZoneList(value: unknown): value is readonly ZoneDto[] {
  return isList(value) && value.every(isZoneDto);
}

const isZoneListAnswer = envelopeOf(isList);
const isZonePage = envelopeOf(isZoneList);

/**
 * One resource per zone the token reaches : `GET /zones` paginated (50 per
 * page, at most `MAX_DISCOVERED_ZONES`). No account filter — a token may
 * cover zones of several accounts ; the account travels in the metadata.
 */
export async function discoverCloudflareDnsResources(
  ctx: AccountContext,
): Promise<readonly Resource[]> {
  const token = tokenOf(ctx);
  const resources: Resource[] = [];
  for (let page = 1; resources.length < MAX_DISCOVERED_ZONES; page += 1) {
    const answer = await callCloudflareApi(
      ctx,
      token,
      ROUTES[TOOL.listZones]!,
      '/zones',
      { page, per_page: DISCOVERY_PAGE_SIZE },
      isZonePage,
    );
    const zones = answer.result;
    for (const zone of zones) {
      if (resources.length >= MAX_DISCOVERED_ZONES) break;
      resources.push(zoneResource(zone));
    }
    if (zones.length < DISCOVERY_PAGE_SIZE || page >= totalPages(answer.result_info, page)) break;
  }
  return resources;
}

/** `result_info.total_pages` of a page of zones ; the current page when Cloudflare omits it. */
function totalPages(info: unknown, page: number): number {
  return isRecord(info) && typeof info.total_pages === 'number' ? info.total_pages : page;
}

function zoneResource(zone: ZoneDto): Resource {
  const metadata: Record<string, string> = { zone_name: zone.name };
  const account = isRecord(zone.account) ? zone.account : {};
  if (typeof account.id === 'string' && account.id) metadata.account_id = account.id;
  if (typeof account.name === 'string' && account.name) metadata.account_name = account.name;
  if (typeof zone.status === 'string' && zone.status) metadata.status = zone.status;
  return {
    provider: PROVIDER_ID,
    ref: zone.id,
    displayName: zone.name,
    metadata,
  };
}

function recordIdArg(value: unknown): string {
  const recordId = pathIdent(value);
  if (recordId === null) {
    throw new ExecutorRefusal(`${PROVIDER_ID}: record_id: missing or malformed identifier`);
  }
  return recordId;
}

/**
 * The `GET /zones` answer with only the zones of the mission ; `result_info`
 * and the rest of the envelope are left as upstream sent them. A listed
 * entry without an id is dropped : it cannot be a zone of the mission.
 */
function zonesOfTheMission(
  answer: { readonly result: readonly unknown[] },
  resources: readonly Resource[],
): unknown {
  const refs = new Set(resources.filter((x) => x.provider === PROVIDER_ID).map((x) => x.ref));
  return {
    ...answer,
    result: answer.result.filter(
      (zone) => isRecord(zone) && typeof zone.id === 'string' && refs.has(zone.id),
    ),
  };
}

/**
 * The `result` of `GET …/dns_records/<id>` : a record whose type or name is
 * absent is read as critical below, so the guard accepts a missing one.
 */
function isRecordResult(
  value: unknown,
): value is Readonly<Record<string, unknown>> | null | undefined {
  return value === null || value === undefined || isRecord(value);
}

const isRecordAnswer = envelopeOf(isRecordResult);

/**
 * An update or a deletion declared as an ordinary record (`type` + `name` of
 * a subdomain record) must target a record that is ordinary today ;
 * otherwise the agent could move or remove an apex record while accepting
 * only `record-write` (+ `record-delete`). A record whose type and name
 * cannot be read back counts as critical : the call is refused.
 */
async function assertDeclaredSensitivity(
  ctx: ExecuteContext,
  token: string,
  zone: Resource,
  recordPath: string,
  args: Args,
): Promise<void> {
  const zoneName = zoneNameOf(zone);
  if (recordSensitivity(args, zoneName) === 'critical') return;
  const current = (
    await callCloudflareApi(ctx, token, ROUTES[TOOL.getRecord]!, recordPath, {}, isRecordAnswer)
  ).result;
  const type = typeof current?.type === 'string' ? current.type : '';
  const name = typeof current?.name === 'string' ? current.name : '';
  if (isCriticalRecord(type, name, zoneName)) {
    throw new ExecutorRefusal(
      `${PROVIDER_ID}: the record is a critical record (${type} ${name}) but the call ` +
        `declared an ordinary one (${String(args.type)} ${String(args.name)}) ; name the ` +
        'record as it is so the change is classified as a critical record write',
    );
  }
}
