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
 *   - 401 / 403 from either surface → `UpstreamAuthError`, so the host marks
 *     the connection `expired` ;
 *   - the database a data tool targets must be a resource of the mission ;
 *     absent, the mission's single database applies ; anything else is
 *     refused before any network call ;
 *   - Management API answers about a database are **redacted** : the REST
 *     tokens and password never reach the agent (`read-database-metadata`
 *     promises "no credential leak").
 */

import {
  UpstreamAuthError,
  type ConnectionContext,
  type ExecuteContext,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { PROVIDER } from './classify.ts';
import { basicAuthHeader, upstashAuth, type UpstashAuth } from './credential.ts';
import { MANAGEMENT_TOOL_NAMES } from './tools.ts';

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

  const own = ctx.resources.filter((r) => r.provider === PROVIDER);
  const explicit = args.databaseId ?? args.database_id;
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || !own.some((r) => r.ref === explicit)) {
      return errorResult(
        `databaseId '${String(explicit)}' is not a database of this mission — omit the argument or name one of the mission's databases.`,
      );
    }
  }

  try {
    if (MANAGEMENT_TOOL_NAMES.has(tool)) {
      return toToolResult(await executeManagementTool(call, tool, args));
    }
    const databaseId =
      typeof explicit === 'string' ? explicit : own.length === 1 ? own[0]!.ref : null;
    if (databaseId === null) {
      return errorResult(
        own.length === 0
          ? `Upstash Redis data tool '${tool}' requires a databaseId and the mission touches no Upstash database.`
          : `Upstash Redis data tool '${tool}' requires a databaseId : the mission touches ${own.length} Upstash databases — name one.`,
      );
    }
    return toToolResult(await executeDataTool(call, databaseId, tool, args));
  } catch (e) {
    if (e instanceof UpstreamAuthError) throw e;
    return errorResult(e instanceof Error ? e.message : String(e));
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
  const body = await callManagementApi(call, 'GET', '/redis/databases');
  const all = (Array.isArray(body) ? (body as DatabaseDto[]) : []).filter(
    (d) => typeof d.database_id === 'string' && d.database_id.length > 0,
  );
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
    throw new Error(msg);
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function executeManagementTool(
  call: UpstashCall,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  switch (tool) {
    case 'upstash_redis__list_databases':
      return redactDatabases(await callManagementApi(call, 'GET', '/redis/databases'));
    case 'upstash_redis__get_database':
      return redactDatabases(
        await callManagementApi(call, 'GET', `/redis/database/${databasePath(args)}`),
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
      return callManagementApi(call, 'DELETE', `/redis/database/${databasePath(args)}`);
    case 'upstash_redis__rename_database':
      return redactDatabases(
        await callManagementApi(call, 'POST', `/redis/rename/${databasePath(args)}`, {
          name: args.name,
        }),
      );
    case 'upstash_redis__get_database_stats':
      return callManagementApi(call, 'GET', `/redis/stats/${databasePath(args)}`);
    default:
      throw new Error(`Upstash Redis management tool not implemented: ${tool}`);
  }
}

function databasePath(args: Readonly<Record<string, unknown>>): string {
  const id = args.databaseId ?? args.database_id;
  if (typeof id !== 'string' || id.length === 0) throw new Error('databaseId is required.');
  return encodeURIComponent(id);
}

/** Strip the per-database credentials from a Management API answer (object or list). */
export function redactDatabases(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map(redactDatabases);
  if (typeof payload !== 'object' || payload === null) return payload;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (!REDACTED_DATABASE_FIELDS.includes(k)) out[k] = v;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Data API (per-database Bearer token)
// ─────────────────────────────────────────────────────────────────────────────

/** The REST endpoint and token of a database, read from the Management API. */
async function databaseConnection(
  call: UpstashCall,
  databaseId: string,
): Promise<{ endpoint: string; restToken: string }> {
  const db = (await callManagementApi(
    call,
    'GET',
    `/redis/database/${encodeURIComponent(databaseId)}`,
  )) as DatabaseDto;
  const endpoint = db.rest_url ?? (db.endpoint ? `https://${db.endpoint}` : undefined);
  const restToken = db.rest_token;
  if (!endpoint || !restToken) {
    throw new Error(
      `Upstash database ${databaseId} does not expose a REST endpoint/token. ` +
        'Ensure the database is active and its REST API is enabled.',
    );
  }
  return { endpoint, restToken };
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
    throw new Error(msg);
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
    case 'upstash_redis__execute':
      return stringList(args.command, 'command');
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
        throw new Error('fields must be an object of field-value pairs.');
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
      throw new Error(`Upstash Redis data tool not implemented: ${tool}`);
  }
}

function str(value: unknown, arg: string): string {
  if (typeof value !== 'string') throw new Error(`${arg} must be a string.`);
  return value;
}

function stringList(value: unknown, arg: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${arg} must be a non-empty array of strings.`);
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
