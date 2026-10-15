/**
 * Upstream calls of the `upstash-redis` provider, and resource discovery.
 *
 * Spec : docs/spec/vaubaan-gateway.md §2.4 (the credential arrives decrypted
 *        in the context, is used for one call, never returned), §5.
 * Handbook : docs/handbook/providers/upstash-redis.md §4.
 *
 * Two upstream surfaces, one credential :
 *   - the 6 management tools hit the Management API (`api.upstash.com/v2`)
 *     with HTTP Basic auth (`email:api_key`) ;
 *   - the 15 data tools hit the per-database REST endpoint with the
 *     database's own Bearer token, which the plugin reads from the
 *     Management API at call time (`GET /v2/redis/database/{id}`) and never
 *     returns to the agent.
 *
 * Rules :
 *   - `fetch` comes from the context, never from the global ;
 *   - a provider failure is **thrown**, never returned : 401 / 403 from
 *     either surface → `UpstreamAuthError` (the host treats a 401 as a
 *     rejected credential — the connection ends up `expired` — and a 403 as
 *     a failed call), any other failed status → `UpstreamHttpError`, a
 *     network failure → the error itself. The host records it as
 *     `upstream_error` in the audit ;
 *   - what this executor declines itself (a malformed argument, a database
 *     outside the mission, a tool that is not wired) is an `ExecutorRefusal`,
 *     returned as an `isError` result ;
 *   - `execute` sends the command the classifier read (`redisCommandOf`) :
 *     one flat command of strings and finite numbers. A pipeline-shaped
 *     `command` is refused here — no pipeline endpoint is wired — whatever
 *     it was classified as ;
 *   - the database a call runs on is resolved by the classifier's own
 *     `resolveDatabase` : a resource of the mission whose ref is one path
 *     segment (`pathIdent`), or the mission's single database when a data
 *     tool names none ; anything else is refused before any network call.
 *     The resolved ref is what is interpolated into the Management API
 *     path — the argument is not read a second time ;
 *   - a Redis command (verb, keys, values) is sent as a JSON array in the
 *     body of a POST to the database's REST endpoint : no word of it is ever
 *     part of a URL ;
 *   - Management API answers about a database are **redacted** : the REST
 *     tokens and password never reach the agent (`read-database-metadata`
 *     promises "no credential leak").
 */

import {
  ExecutorRefusal,
  UpstreamAuthError,
  UpstreamHttpError,
  type ConnectionContext,
  type ExecuteContext,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { PROVIDER, databaseArg, redisCommandOf, resolveDatabase } from './classify.ts';
import { basicAuthHeader, upstashAuth, type UpstashAuth } from './credential.ts';
import { ACCOUNT_TOOL_NAMES, MANAGEMENT_TOOL_NAMES } from './tools.ts';

/** The Upstash Developer (Management) API. A fact about the provider. */
export const UPSTASH_MANAGEMENT_API = 'https://api.upstash.com/v2';

/** Databases kept by `discoverResources` (the list endpoint is unpaged upstream). */
export const MAX_DISCOVERED_DATABASES = 200;

/** Keys stripped from every Management API answer about a database. */
export const REDACTED_DATABASE_FIELDS: readonly string[] = [
  'rest_token',
  'read_only_rest_token',
  'password',
];

/**
 * A field name that reads as a credential (SEC 2026-10-15) : stripped too,
 * so a credential Upstash adds to the database answer tomorrow is not
 * returned under the `data: metadata` management read.
 */
export const CREDENTIAL_LIKE_FIELD = /(token|password|secret|_key)$/i;

/** What one upstream call needs, built from the context. */
interface UpstashCall {
  readonly fetch: typeof fetch;
  readonly auth: UpstashAuth;
  readonly signal?: AbortSignal;
}

type ManagementMethod = 'GET' | 'POST' | 'DELETE';

// ─────────────────────────────────────────────────────────────────────────────
// ProviderPlugin entry points
// ─────────────────────────────────────────────────────────────────────────────

export async function executeUpstashRedis(
  ctx: ExecuteContext,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<McpToolResult> {
  const call: UpstashCall = {
    fetch: ctx.fetch,
    auth: upstashAuth(ctx.credential),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };

  // The classifier's own resolution : the database the slices named, as one
  // path segment, or a refusal. Account tools need none but still refuse a
  // database outside the mission.
  const database = resolveDatabase(args, ctx.resources, !ACCOUNT_TOOL_NAMES.has(tool));
  if ('denied' in database) return errorResult(database.denied);

  try {
    if (MANAGEMENT_TOOL_NAMES.has(tool)) {
      // A management tool acts on the database the call names : the mission's
      // single database is not a default for it (its schema requires the id).
      const named = databaseArg(args) === undefined ? null : database.ref;
      return toToolResult(await executeManagementTool(call, tool, args, named));
    }
    if (database.ref === null) {
      return errorResult(`Upstash Redis data tool '${tool}' requires a databaseId.`);
    }
    return toToolResult(await executeDataTool(call, database.ref, tool, args));
  } catch (e) {
    if (e instanceof ExecutorRefusal) return errorResult(e.message);
    throw e;
  }
}

/**
 * Resources reachable with this credential : one `Resource` per Redis
 * database of the account (`GET /v2/redis/databases`, unpaged upstream,
 * capped at `MAX_DISCOVERED_DATABASES` with a logger warning). The owner
 * labels `env` on the connection page ; the classifier then resolves
 * env-scoped risks through the `database[<id>]` segment.
 */
export async function discoverUpstashRedisResources(
  ctx: ConnectionContext,
): Promise<readonly Resource[]> {
  const call: UpstashCall = {
    fetch: ctx.fetch,
    auth: upstashAuth(ctx.credential),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };
  const body: unknown = await callManagementApi(call, 'GET', '/redis/databases');
  const all = (Array.isArray(body) ? (body as readonly unknown[]) : []).filter(isDatabaseDto);
  if (all.length > MAX_DISCOVERED_DATABASES) {
    ctx.logger?.warn('upstash-redis: more databases than the discovery cap, list truncated', {
      total: all.length,
      cap: MAX_DISCOVERED_DATABASES,
    });
  }
  return all.slice(0, MAX_DISCOVERED_DATABASES).map((d) => ({
    provider: PROVIDER,
    ref: d.database_id,
    displayName: d.database_name ?? d.database_id,
    metadata: {
      ...(d.region ? { region: d.region } : {}),
      ...(d.primary_region ? { primary_region: d.primary_region } : {}),
      ...(Array.isArray(d.read_regions) ? { read_regions: d.read_regions } : {}),
      ...(d.endpoint ? { endpoint: d.endpoint } : {}),
      ...(d.state ? { state: d.state } : {}),
      ...(d.database_type ? { database_type: d.database_type } : {}),
      ...(typeof d.tls === 'boolean' ? { tls: d.tls } : {}),
    },
  }));
}

interface DatabaseDto {
  readonly database_id: string;
  readonly database_name?: string;
  readonly database_type?: string;
  readonly region?: string;
  readonly primary_region?: string;
  readonly read_regions?: readonly string[];
  readonly endpoint?: string;
  readonly rest_url?: string;
  readonly rest_token?: string;
  readonly state?: string;
  readonly tls?: boolean;
}

/** An upstream answer that names a database : an object with a non-empty string `database_id`. */
function isDatabaseDto(value: unknown): value is DatabaseDto {
  if (typeof value !== 'object' || value === null) return false;
  const id = (value as { database_id?: unknown }).database_id;
  return typeof id === 'string' && id.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Management API (Basic auth)
// ─────────────────────────────────────────────────────────────────────────────

async function callManagementApi(
  call: UpstashCall,
  method: ManagementMethod,
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: basicAuthHeader(call.auth),
    Accept: 'application/json',
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (call.signal) init.signal = call.signal;
  const res = await call.fetch(`${UPSTASH_MANAGEMENT_API}${path}`, init);
  const text = await res.text();
  if (!res.ok) {
    const msg = `Upstash Management API ${method} ${path} ${res.status}: ${text.slice(0, 300)}`;
    if (res.status === 401 || res.status === 403) throw new UpstreamAuthError(msg, res.status);
    throw new UpstreamHttpError(msg, res.status);
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * `databaseId` is the ref `resolveDatabase` returned for the database the
 * call names (one path segment, interpolated as it is), `null` when the call
 * names none.
 */
async function executeManagementTool(
  call: UpstashCall,
  tool: string,
  args: Readonly<Record<string, unknown>>,
  databaseId: string | null,
): Promise<unknown> {
  switch (tool) {
    case 'upstash_redis__list_databases':
      return redactDatabases(await callManagementApi(call, 'GET', '/redis/databases'));
    case 'upstash_redis__get_database':
      return redactDatabases(
        await callManagementApi(call, 'GET', `/redis/database/${databasePath(databaseId)}`),
      );
    case 'upstash_redis__create_database': {
      const body: Record<string, unknown> = { name: args.name, region: args.region };
      if (args.primary_region !== undefined) body.primary_region = args.primary_region;
      if (args.read_regions !== undefined) body.read_regions = args.read_regions;
      if (args.tls !== undefined) body.tls = args.tls;
      if (args.eviction !== undefined) body.eviction = args.eviction;
      return redactDatabases(await callManagementApi(call, 'POST', '/redis/database', body));
    }
    case 'upstash_redis__delete_database':
      return callManagementApi(call, 'DELETE', `/redis/database/${databasePath(databaseId)}`);
    case 'upstash_redis__rename_database':
      return redactDatabases(
        await callManagementApi(call, 'POST', `/redis/rename/${databasePath(databaseId)}`, {
          name: args.name,
        }),
      );
    case 'upstash_redis__get_database_stats':
      return callManagementApi(call, 'GET', `/redis/stats/${databasePath(databaseId)}`);
    default:
      throw new ExecutorRefusal(`Upstash Redis management tool not implemented: ${tool}`);
  }
}

function databasePath(databaseId: string | null): string {
  if (databaseId === null) throw new ExecutorRefusal('databaseId is required.');
  return databaseId;
}

/** Strip the per-database credentials from a Management API answer (object or list). */
export function redactDatabases(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map(redactDatabases);
  if (typeof payload !== 'object' || payload === null) return payload;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (!REDACTED_DATABASE_FIELDS.includes(k) && !CREDENTIAL_LIKE_FIELD.test(k)) out[k] = v;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Data API (per-database Bearer token)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The REST endpoint and token of a database, read from the Management API.
 * `databaseId` is a ref `resolveDatabase` returned : one path segment.
 */
async function databaseConnection(
  call: UpstashCall,
  databaseId: string,
): Promise<{ endpoint: string; restToken: string }> {
  const answer: unknown = await callManagementApi(call, 'GET', `/redis/database/${databaseId}`);
  const db: Partial<DatabaseDto> = isDatabaseDto(answer) ? answer : {};
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined;
  const named = text(db.rest_url) ?? text(db.endpoint);
  const restToken = text(db.rest_token);
  if (!named || !restToken) {
    throw new Error(
      `Upstash database ${databaseId} does not expose a REST endpoint/token. ` +
        'Ensure the database is active and its REST API is enabled.',
    );
  }
  const endpoint = restEndpointOf(named);
  if (endpoint === null) {
    // The token is the database's own credential: it goes to Upstash or nowhere.
    throw new Error(
      `Upstash database ${databaseId}: the Management API named a host that is not an Upstash REST endpoint ` +
        `(expected https://<name>${UPSTASH_REST_HOST_SUFFIX}); the call was not sent.`,
    );
  }
  return { endpoint, restToken };
}

/** Where every per-database REST endpoint lives. A fact about the provider. */
export const UPSTASH_REST_HOST_SUFFIX = '.upstash.io';

/** One DNS label: the database's name at Upstash (`us1-merry-cat-32748`). */
const REST_HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The REST endpoint of a database, pinned to Upstash: `https://<label>.upstash.io`,
 * rebuilt from the label alone. The Management API names it as a URL (`rest_url`),
 * a host or a bare slug (`endpoint`); the database token is posted there, so the
 * answer is not trusted to choose the destination — any other scheme, host, port,
 * path, query or userinfo is `null` and nothing is sent.
 */
export function restEndpointOf(named: string): string | null {
  let host: string;
  if (named.includes('://')) {
    let url: URL;
    try {
      url = new URL(named);
    } catch {
      return null;
    }
    const bare =
      url.protocol === 'https:' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      (url.pathname === '/' || url.pathname === '') &&
      url.search === '' &&
      url.hash === '';
    if (!bare) return null;
    host = url.hostname;
  } else {
    host = named.toLowerCase();
  }
  const label = host.endsWith(UPSTASH_REST_HOST_SUFFIX)
    ? host.slice(0, -UPSTASH_REST_HOST_SUFFIX.length)
    : host;
  return REST_HOST_LABEL.test(label) ? `https://${label}${UPSTASH_REST_HOST_SUFFIX}` : null;
}

async function executeDataTool(
  call: UpstashCall,
  databaseId: string,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const command = buildCommand(tool, args);
  const { endpoint, restToken } = await databaseConnection(call, databaseId);
  const init: RequestInit = {
    method: 'POST',
    headers: { Authorization: `Bearer ${restToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  };
  if (call.signal) init.signal = call.signal;
  const res = await call.fetch(endpoint, init);
  const text = await res.text();
  if (!res.ok) {
    const msg = `Upstash Data API ${res.status}: ${text.slice(0, 300)}`;
    if (res.status === 401 || res.status === 403) throw new UpstreamAuthError(msg, res.status);
    throw new UpstreamHttpError(msg, res.status);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The Redis command array of a data tool. Throws on a malformed argument set. */
export function buildCommand(tool: string, args: Readonly<Record<string, unknown>>): string[] {
  switch (tool) {
    case 'upstash_redis__execute': {
      // The same reading as the classifier : what was classified is what is sent.
      const command = redisCommandOf(args.command);
      if (command === null) {
        throw new ExecutorRefusal(
          'command must be one Redis command: a non-empty array of strings (or finite numbers) starting with the command name. Pipelines and nested arrays are not supported.',
        );
      }
      return command;
    }
    case 'upstash_redis__get':
      return ['GET', str(args.key, 'key')];
    case 'upstash_redis__set': {
      const cmd = ['SET', str(args.key, 'key'), str(args.value, 'value')];
      if (args.ex !== undefined) cmd.push('EX', String(args.ex));
      if (args.px !== undefined) cmd.push('PX', String(args.px));
      if (args.nx === true) cmd.push('NX');
      if (args.xx === true) cmd.push('XX');
      return cmd;
    }
    case 'upstash_redis__del':
      return ['DEL', ...stringList(args.keys, 'keys')];
    case 'upstash_redis__keys':
      return ['KEYS', str(args.pattern, 'pattern')];
    case 'upstash_redis__scan': {
      const cmd = ['SCAN', String(args.cursor ?? 0)];
      if (args.match !== undefined) cmd.push('MATCH', str(args.match, 'match'));
      if (args.count !== undefined) cmd.push('COUNT', String(args.count));
      return cmd;
    }
    case 'upstash_redis__ttl':
      return ['TTL', str(args.key, 'key')];
    case 'upstash_redis__expire':
      return ['EXPIRE', str(args.key, 'key'), String(args.seconds)];
    case 'upstash_redis__hset': {
      const cmd = ['HSET', str(args.key, 'key')];
      const fields = args.fields;
      if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
        throw new ExecutorRefusal('fields must be an object of field-value pairs.');
      }
      for (const [field, value] of Object.entries(fields as Record<string, unknown>)) {
        cmd.push(field, String(value));
      }
      return cmd;
    }
    case 'upstash_redis__hgetall':
      return ['HGETALL', str(args.key, 'key')];
    case 'upstash_redis__lpush':
      return ['LPUSH', str(args.key, 'key'), ...stringList(args.values, 'values')];
    case 'upstash_redis__lrange':
      return ['LRANGE', str(args.key, 'key'), String(args.start), String(args.stop)];
    case 'upstash_redis__sadd':
      return ['SADD', str(args.key, 'key'), ...stringList(args.members, 'members')];
    case 'upstash_redis__smembers':
      return ['SMEMBERS', str(args.key, 'key')];
    case 'upstash_redis__dbsize':
      return ['DBSIZE'];
    default:
      throw new ExecutorRefusal(`Upstash Redis data tool not implemented: ${tool}`);
  }
}

function str(value: unknown, arg: string): string {
  if (typeof value !== 'string') throw new ExecutorRefusal(`${arg} must be a string.`);
  return value;
}

function stringList(value: unknown, arg: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ExecutorRefusal(`${arg} must be a non-empty array of strings.`);
  }
  return value.map((v) => String(v));
}

// ─────────────────────────────────────────────────────────────────────────────
// Results
// ─────────────────────────────────────────────────────────────────────────────

function toToolResult(payload: unknown): McpToolResult {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text }] };
}

function errorResult(message: string): McpToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
