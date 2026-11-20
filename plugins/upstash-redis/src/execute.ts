/**
 * Upstream calls of the `upstash-redis` service, and resource discovery.
 *
 * Spec : docs/spec/vaubaan-gateway.md §2.4 (the credential arrives decrypted
 *        in the context, is used for one call, never returned), §5.
 * Handbook : docs/handbook/services/upstash-redis.md.
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
 *   - both surfaces are called with the SDK's `httpJson` : a service failure
 *     is **thrown**, never returned — 401 / 403 from either surface →
 *     `UpstreamAuthError` (the host treats a 401 as a rejected credential —
 *     the account ends up `expired` — and a 403 as a failed call), any
 *     other failed status → `UpstreamHttpError` (a Redis command the database
 *     refuses is its HTTP 400 `{ error }`), an answer that is not JSON or not
 *     the expected shape → `UpstreamProtocolError`, a network failure → the
 *     error itself. The host records it as `upstream_error` in the audit ;
 *   - what this executor declines itself (a malformed argument, a database
 *     outside the mission, a tool that is not wired) is a `refusalResult`,
 *     or an `ExecutorRefusal` thrown inside `declining` ;
 *   - `execute` sends the command the classifier read (`redisCommandOf`) :
 *     one flat command of strings and finite numbers. A pipeline-shaped
 *     `command` is refused here — no pipeline endpoint is wired — whatever
 *     it was classified as ;
 *   - the database a call runs on is resolved by the classifier's own
 *     `resolveDatabase` : a resource of the mission, named by its id or its
 *     exact name, whose ref is one path segment (`pathIdent`), or the
 *     mission's single database when a data
 *     tool names none ; anything else is refused before any network call.
 *     The resolved ref is what is interpolated into the Management API
 *     path — the argument is not read a second time ;
 *   - a Redis command (verb, keys, values) is sent as a JSON array in the
 *     body of a POST to the database's REST endpoint : no word of it is ever
 *     part of a URL ;
 *   - Management API answers about a database are **redacted** : the REST
 *     tokens and password never reach the agent (`read-database-metadata`
 *     promises "no credential leak") ;
 *   - `list_databases` answers the mission's databases alone
 *     (`missionDatabases`) : the account's other databases are not named.
 */

import {
  anyJson,
  declining,
  ExecutorRefusal,
  httpJson,
  isList,
  isRecord,
  jsonResult,
  refusalResult,
  textResult,
  UpstreamProtocolError,
  type AccountContext,
  type ExecuteContext,
  type Guard,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { databaseArg, redisCommandOf, resolveDatabase } from './classify.ts';
import { databaseResource } from './created.ts';
import {
  UPSTASH_MANAGEMENT_API,
  basicAuthHeader,
  upstashAuth,
  type UpstashAuth,
} from './credential.ts';
import { SERVICE_ID, TOOL } from './identity.ts';
import { ACCOUNT_TOOL_NAMES, MANAGEMENT_TOOL_NAMES } from './tools.ts';

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
// ServicePlugin entry points
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
  if ('denied' in database) return refusalResult(database.denied);
  const ref = database.ref;

  return declining(async () => {
    if (MANAGEMENT_TOOL_NAMES.has(tool)) {
      // A management tool acts on the database the call names : the mission's
      // single database is not a default for it (its schema requires the id).
      const named = databaseArg(args) === undefined ? null : ref;
      return toToolResult(await executeManagementTool(call, tool, args, named, ctx.resources));
    }
    if (ref === null) {
      throw new ExecutorRefusal(`Upstash Redis data tool '${tool}' requires a databaseId.`);
    }
    return toToolResult(await executeDataTool(call, ref, tool, args));
  });
}

/**
 * Resources reachable with this credential : one `Resource` per Redis
 * database of the account (`GET /v2/redis/databases`, unpaged upstream,
 * capped at `MAX_DISCOVERED_DATABASES` with a logger warning). The owner
 * labels `env` on the account page ; the classifier then resolves
 * env-scoped risks through the `database[<id>]` segment.
 */
export async function discoverUpstashRedisResources(
  ctx: AccountContext,
): Promise<readonly Resource[]> {
  const call: UpstashCall = {
    fetch: ctx.fetch,
    auth: upstashAuth(ctx.credential),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };
  const listed = await callManagementApi(call, 'GET', '/redis/databases', isList);
  // An entry that names no database is skipped : the rest of the list stays usable.
  const all = listed.filter(isNamedDatabase);
  if (all.length > MAX_DISCOVERED_DATABASES) {
    ctx.logger?.warn(`${SERVICE_ID}: more databases than the discovery cap, list truncated`, {
      total: all.length,
      cap: MAX_DISCOVERED_DATABASES,
    });
  }
  return all.slice(0, MAX_DISCOVERED_DATABASES).map((d) => databaseResource(d.database_id, d));
}

/** A database the Management API describes : its other fields are read one by one, untrusted. */
type NamedDatabase = Readonly<Record<string, unknown>> & { readonly database_id: string };

/** An object with a non-empty string `database_id`. */
function isNamedDatabase(value: unknown): value is NamedDatabase {
  return isRecord(value) && typeof value.database_id === 'string' && value.database_id.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Management API (Basic auth)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One Management API call, its answer read through `guard`. `path` is under
 * `/v2` ; the messages name it without its query string.
 */
async function callManagementApi<T>(
  call: UpstashCall,
  method: ManagementMethod,
  path: string,
  guard: Guard<T>,
  body?: Record<string, unknown>,
): Promise<T> {
  const [pathname = path] = path.split('?');
  return httpJson(
    call,
    {
      url: `${UPSTASH_MANAGEMENT_API}${path}`,
      method,
      headers: { authorization: basicAuthHeader(call.auth) },
      ...(body !== undefined ? { body } : {}),
      what: `Upstash Management API ${method} ${pathname}`,
    },
    guard,
  );
}

/**
 * A Management API answer the agent reads as it is (redacted by the caller
 * when it describes a database). An empty answer reads as `{}`, so the
 * agent always gets a JSON document.
 */
async function passThroughManagementApi(
  call: UpstashCall,
  method: ManagementMethod,
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  return (await callManagementApi(call, method, path, anyJson, body)) ?? {};
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
  resources: readonly Resource[],
): Promise<unknown> {
  switch (tool) {
    case TOOL.listDatabases:
      return missionDatabases(
        await callManagementApi(call, 'GET', '/redis/databases', isList),
        resources,
      );
    case TOOL.getDatabase:
      return redactDatabases(
        // `credentials=hide`: Upstash leaves the credentials out of the answer
        // itself; the redaction below stays (SEC 2026-10-15 re-check L-2).
        await passThroughManagementApi(
          call,
          'GET',
          `/redis/database/${databasePath(databaseId)}?credentials=hide`,
        ),
      );
    case TOOL.createDatabase: {
      const body: Record<string, unknown> = { name: args.name, region: args.region };
      if (args.primary_region !== undefined) body.primary_region = args.primary_region;
      if (args.read_regions !== undefined) body.read_regions = args.read_regions;
      if (args.tls !== undefined) body.tls = args.tls;
      if (args.eviction !== undefined) body.eviction = args.eviction;
      return redactDatabases(await passThroughManagementApi(call, 'POST', '/redis/database', body));
    }
    case TOOL.deleteDatabase:
      return passThroughManagementApi(
        call,
        'DELETE',
        `/redis/database/${databasePath(databaseId)}`,
      );
    case TOOL.renameDatabase:
      return redactDatabases(
        await passThroughManagementApi(call, 'POST', `/redis/rename/${databasePath(databaseId)}`, {
          name: args.name,
        }),
      );
    case TOOL.getDatabaseStats:
      return passThroughManagementApi(call, 'GET', `/redis/stats/${databasePath(databaseId)}`);
    default:
      throw new ExecutorRefusal(`Upstash Redis management tool not implemented: ${tool}`);
  }
}

/** The note `list_databases` answers with : what it lists, and how to name a database. */
export const LIST_DATABASES_NOTE =
  "The Upstash Redis databases of this mission on this account; the account's other databases are left out. " +
  'Name one in `databaseId` by its id or its name.';

/**
 * `list_databases` : the account's databases (`GET /v2/redis/databases`, a
 * list or the service's failure) kept to the mission's, by `database_id`
 * against the refs of the gateway's resources, and redacted. A database
 * outside the mission is not named ; an entry without an id is dropped.
 */
export function missionDatabases(
  listed: readonly unknown[],
  resources: readonly Resource[],
): { databases: unknown[]; note: string } {
  const own = new Set(resources.filter((r) => r.service === SERVICE_ID).map((r) => r.ref));
  const databases = listed
    .filter((d) => isNamedDatabase(d) && own.has(d.database_id))
    .map(redactDatabases);
  return { databases, note: LIST_DATABASES_NOTE };
}

function databasePath(databaseId: string | null): string {
  if (databaseId === null) throw new ExecutorRefusal('databaseId is required.');
  return databaseId;
}

/**
 * Strip the per-database credentials from a Management API answer (object or list),
 * at any depth: a credential nested in an object (`credentials: { rest: … }`) is
 * caught by its name too (SEC 2026-10-15 re-check L-2).
 */
export function redactDatabases(payload: unknown): unknown {
  if (isList(payload)) return payload.map(redactDatabases);
  if (!isRecord(payload)) return payload;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!REDACTED_DATABASE_FIELDS.includes(k) && !CREDENTIAL_LIKE_FIELD.test(k)) {
      out[k] = redactDatabases(v);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Data API (per-database Bearer token)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The REST endpoint and token of a database, read from the Management API.
 * `databaseId` is a ref `resolveDatabase` returned : one path segment. An
 * answer that gives no usable endpoint or token is the service's failure
 * (`UpstreamProtocolError`) : nothing is sent.
 */
async function databaseConnection(
  call: UpstashCall,
  databaseId: string,
): Promise<{ endpoint: string; restToken: string }> {
  const db = await callManagementApi(call, 'GET', `/redis/database/${databaseId}`, isRecord);
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined;
  const named = text(db.rest_url) ?? text(db.endpoint);
  const restToken = text(db.rest_token);
  if (!named || !restToken) {
    throw new UpstreamProtocolError(
      `Upstash database ${databaseId} does not expose a REST endpoint/token. ` +
        'Ensure the database is active and its REST API is enabled.',
    );
  }
  const endpoint = restEndpointOf(named);
  if (endpoint === null) {
    // The token is the database's own credential: it goes to Upstash or nowhere.
    throw new UpstreamProtocolError(
      `Upstash database ${databaseId}: the Management API named a host that is not an Upstash REST endpoint ` +
        `(expected https://<name>${UPSTASH_REST_HOST_SUFFIX}); the call was not sent.`,
    );
  }
  return { endpoint, restToken };
}

/** Where every per-database REST endpoint lives. A fact about the service. */
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
  return httpJson(
    call,
    {
      url: endpoint,
      method: 'POST',
      headers: { authorization: `Bearer ${restToken}` },
      body: command,
      // The endpoint is not named : the messages say which surface failed, as the agent needs.
      what: 'Upstash Data API',
    },
    isRedisAnswer,
  );
}

/**
 * What the REST endpoint answers a command : `{ result }`, or `{ error }`
 * for a command Redis refuses — which Upstash sends with HTTP 400, thrown
 * as `UpstreamHttpError` before this guard. The agent reads the document
 * as it is.
 */
type RedisAnswer = Readonly<Record<string, unknown>> &
  ({ readonly result: unknown } | { readonly error: string });

function isRedisAnswer(value: unknown): value is RedisAnswer {
  return isRecord(value) && ('result' in value || typeof value.error === 'string');
}

/** The Redis command array of a data tool. Throws on a malformed argument set. */
export function buildCommand(tool: string, args: Readonly<Record<string, unknown>>): string[] {
  switch (tool) {
    case TOOL.execute: {
      // The same reading as the classifier : what was classified is what is sent.
      const command = redisCommandOf(args.command);
      if (command === null) {
        throw new ExecutorRefusal(
          'command must be one Redis command: a non-empty array of strings (or finite numbers) starting with the command name. Pipelines and nested arrays are not supported.',
        );
      }
      return command;
    }
    case TOOL.get:
      return ['GET', str(args.key, 'key')];
    case TOOL.set: {
      const cmd = ['SET', str(args.key, 'key'), str(args.value, 'value')];
      if (args.ex !== undefined) cmd.push('EX', String(args.ex));
      if (args.px !== undefined) cmd.push('PX', String(args.px));
      if (args.nx === true) cmd.push('NX');
      if (args.xx === true) cmd.push('XX');
      return cmd;
    }
    case TOOL.del:
      return ['DEL', ...stringList(args.keys, 'keys')];
    case TOOL.keys:
      return ['KEYS', str(args.pattern, 'pattern')];
    case TOOL.scan: {
      const cmd = ['SCAN', String(args.cursor ?? 0)];
      if (args.match !== undefined) cmd.push('MATCH', str(args.match, 'match'));
      if (args.count !== undefined) cmd.push('COUNT', String(args.count));
      return cmd;
    }
    case TOOL.ttl:
      return ['TTL', str(args.key, 'key')];
    case TOOL.expire:
      return ['EXPIRE', str(args.key, 'key'), String(args.seconds)];
    case TOOL.hset: {
      const cmd = ['HSET', str(args.key, 'key')];
      const fields = args.fields;
      if (!isRecord(fields)) {
        throw new ExecutorRefusal('fields must be an object of field-value pairs.');
      }
      for (const [field, value] of Object.entries(fields)) {
        cmd.push(field, String(value));
      }
      return cmd;
    }
    case TOOL.hgetall:
      return ['HGETALL', str(args.key, 'key')];
    case TOOL.lpush:
      return ['LPUSH', str(args.key, 'key'), ...stringList(args.values, 'values')];
    case TOOL.lrange:
      return ['LRANGE', str(args.key, 'key'), String(args.start), String(args.stop)];
    case TOOL.sadd:
      return ['SADD', str(args.key, 'key'), ...stringList(args.members, 'members')];
    case TOOL.smembers:
      return ['SMEMBERS', str(args.key, 'key')];
    case TOOL.dbsize:
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
  if (!isList(value) || value.length === 0) {
    throw new ExecutorRefusal(`${arg} must be a non-empty array of strings.`);
  }
  return value.map((v) => String(v));
}

// ─────────────────────────────────────────────────────────────────────────────
// Results
// ─────────────────────────────────────────────────────────────────────────────

/** A JSON string answer (`"OK"`) is shown as its text ; anything else as indented JSON. */
function toToolResult(payload: unknown): McpToolResult {
  return typeof payload === 'string' ? textResult(payload) : jsonResult(payload);
}
