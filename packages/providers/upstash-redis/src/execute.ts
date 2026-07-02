/**
 * Upstash Redis tool dispatcher — routes tool calls to either the
 * Management API (api.upstash.com/v2, Basic Auth) or the per-database
 * Data API (REST endpoint, Bearer token).
 *
 * Auth model :
 *   - Management API : the stored secret is `email:api_key` (concatenated
 *     at paste-token time). Decoded → split on first `:` → Basic Auth header.
 *   - Data API : call Management API `GET /redis/database/{id}` to get
 *     `rest_url` + `rest_token`, then use `Authorization: Bearer <rest_token>`
 *     against the database endpoint.
 */

import { UpstreamAuthError } from '@vaubaan/shared';
import { MANAGEMENT_TOOL_NAMES } from './tools.ts';

export type FetchImpl = typeof fetch;

const MANAGEMENT_API = 'https://api.upstash.com/v2';

/**
 * Parse the stored secret (`email:api_key`) into Basic Auth components.
 * The split is on the FIRST `:` — the api_key itself may contain colons.
 */
function parseCredentials(secret: string): { email: string; apiKey: string } {
  const idx = secret.indexOf(':');
  if (idx < 0) {
    throw new Error('Upstash Redis credentials must be in `email:api_key` format.');
  }
  return { email: secret.slice(0, idx), apiKey: secret.slice(idx + 1) };
}

/** Build a Base64-encoded Basic Auth header value. */
function basicAuth(email: string, apiKey: string): string {
  // btoa is available in both Node 18+ and Edge runtimes.
  const encoded = btoa(`${email}:${apiKey}`);
  return `Basic ${encoded}`;
}

async function callManagementApi(
  fetchImpl: FetchImpl,
  credentials: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const { email, apiKey } = parseCredentials(credentials);
  const url = `${MANAGEMENT_API}${path}`;
  const headers: Record<string, string> = {
    Authorization: basicAuth(email, apiKey),
    Accept: 'application/json',
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetchImpl(url, init);
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

async function callDataApi(
  fetchImpl: FetchImpl,
  endpoint: string,
  token: string,
  command: string[],
): Promise<unknown> {
  const url = `${endpoint}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
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

/**
 * Build the Redis command array for a data tool based on tool name and args.
 */
function buildCommand(tool: string, args: Record<string, unknown>): string[] {
  switch (tool) {
    case 'upstash_redis__execute':
      return args.command as string[];
    case 'upstash_redis__get':
      return ['GET', args.key as string];
    case 'upstash_redis__set': {
      const cmd = ['SET', args.key as string, args.value as string];
      if (args.ex !== undefined) cmd.push('EX', String(args.ex));
      if (args.px !== undefined) cmd.push('PX', String(args.px));
      if (args.nx === true) cmd.push('NX');
      if (args.xx === true) cmd.push('XX');
      return cmd;
    }
    case 'upstash_redis__del':
      return ['DEL', ...(args.keys as string[])];
    case 'upstash_redis__keys':
      return ['KEYS', args.pattern as string];
    case 'upstash_redis__scan': {
      const cmd = ['SCAN', String(args.cursor)];
      if (args.match !== undefined) cmd.push('MATCH', args.match as string);
      if (args.count !== undefined) cmd.push('COUNT', String(args.count));
      return cmd;
    }
    case 'upstash_redis__ttl':
      return ['TTL', args.key as string];
    case 'upstash_redis__expire':
      return ['EXPIRE', args.key as string, String(args.seconds)];
    case 'upstash_redis__hset': {
      const cmd = ['HSET', args.key as string];
      const fields = args.fields as Record<string, string>;
      for (const [field, value] of Object.entries(fields)) {
        cmd.push(field, value);
      }
      return cmd;
    }
    case 'upstash_redis__hgetall':
      return ['HGETALL', args.key as string];
    case 'upstash_redis__lpush':
      return ['LPUSH', args.key as string, ...(args.values as string[])];
    case 'upstash_redis__lrange':
      return ['LRANGE', args.key as string, String(args.start), String(args.stop)];
    case 'upstash_redis__sadd':
      return ['SADD', args.key as string, ...(args.members as string[])];
    case 'upstash_redis__smembers':
      return ['SMEMBERS', args.key as string];
    case 'upstash_redis__dbsize':
      return ['DBSIZE'];
    default:
      throw new Error(`Upstash Redis data tool not implemented: ${tool}`);
  }
}

/**
 * Fetch the per-database REST endpoint and token from the Management API.
 */
async function getDatabaseConnection(
  fetchImpl: FetchImpl,
  credentials: string,
  databaseId: string,
): Promise<{ endpoint: string; restToken: string }> {
  const db = (await callManagementApi(
    fetchImpl,
    credentials,
    'GET',
    `/redis/database/${databaseId}`,
  )) as {
    rest_url?: string;
    endpoint?: string;
    rest_token?: string;
  };
  const endpoint = db.rest_url ?? (db.endpoint ? `https://${db.endpoint}` : undefined);
  const restToken = db.rest_token;
  if (!endpoint || !restToken) {
    throw new Error(
      `Upstash database ${databaseId} does not expose REST endpoint/token. ` +
        'Ensure the database is active and REST API is enabled.',
    );
  }
  return { endpoint, restToken };
}

/**
 * Execute an Upstash Redis tool call.
 *
 * @param fetchImpl - fetch implementation (injectable for tests)
 * @param credentials - the stored secret (`email:api_key`)
 * @param databaseId - the database id from the binding's resource_ref
 *   (required for data tools and database-scoped management tools)
 * @param tool - the full tool name (e.g. `upstash_redis__get`)
 * @param args - the tool arguments
 */
export async function executeCall(
  fetchImpl: FetchImpl,
  credentials: string,
  databaseId: string | null,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (MANAGEMENT_TOOL_NAMES.has(tool)) {
    return executeManagementTool(fetchImpl, credentials, tool, args);
  }
  // Data tools require a database id.
  const effectiveDbId =
    (typeof args.databaseId === 'string' ? args.databaseId : null) ?? databaseId;
  if (!effectiveDbId) {
    throw new Error(
      `Upstash Redis data tool '${tool}' requires a databaseId (from binding or args).`,
    );
  }
  const { endpoint, restToken } = await getDatabaseConnection(
    fetchImpl,
    credentials,
    effectiveDbId,
  );
  const command = buildCommand(tool, args);
  return callDataApi(fetchImpl, endpoint, restToken, command);
}

async function executeManagementTool(
  fetchImpl: FetchImpl,
  credentials: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (tool) {
    case 'upstash_redis__list_databases':
      return callManagementApi(fetchImpl, credentials, 'GET', '/redis/databases');
    case 'upstash_redis__get_database':
      return callManagementApi(
        fetchImpl,
        credentials,
        'GET',
        `/redis/database/${args.databaseId as string}`,
      );
    case 'upstash_redis__create_database': {
      const body: Record<string, unknown> = {
        name: args.name,
        region: args.region,
      };
      if (args.primary_region !== undefined) body.primary_region = args.primary_region;
      if (args.read_regions !== undefined) body.read_regions = args.read_regions;
      if (args.tls !== undefined) body.tls = args.tls;
      if (args.eviction !== undefined) body.eviction = args.eviction;
      return callManagementApi(fetchImpl, credentials, 'POST', '/redis/database', body);
    }
    case 'upstash_redis__delete_database':
      return callManagementApi(
        fetchImpl,
        credentials,
        'DELETE',
        `/redis/database/${args.databaseId as string}`,
      );
    case 'upstash_redis__rename_database':
      return callManagementApi(
        fetchImpl,
        credentials,
        'POST',
        `/redis/rename/${args.databaseId as string}`,
        { name: args.name },
      );
    case 'upstash_redis__get_database_stats':
      return callManagementApi(
        fetchImpl,
        credentials,
        'GET',
        `/redis/stats/${args.databaseId as string}`,
      );
    default:
      throw new Error(`Upstash Redis management tool not implemented: ${tool}`);
  }
}
