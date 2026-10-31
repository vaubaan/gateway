/**
 * The database a successful `upstash_redis__create_database` created, read
 * from the Management API's answer (ADR created-resources-join-the-mission).
 * Handbook : docs/handbook/providers/upstash-redis.md.
 *
 * The plugin builds the answer itself : the JSON of `POST /v2/redis/database`,
 * its credentials stripped (`redactDatabases`). The answer is untrusted : the
 * `database_id` must be a path identifier, the grammar every database ref
 * passes before it reaches a request. The resource is described as discovery
 * describes it (ref = `database_id`, name = `database_name`, the same
 * non-secret metadata keys).
 */

import { jsonObjectsOf, type McpToolResult, type Resource } from '@vaubaan/plugin-sdk';

import { pathIdent } from './classify.ts';
import { PROVIDER_ID, TOOL } from './identity.ts';

/** `ProviderPlugin.createdResources` : the database `create_database` made, or `[]`. */
export function createdUpstashRedisResources(
  tool: string,
  _args: Readonly<Record<string, unknown>>,
  result: McpToolResult,
): readonly Resource[] {
  if (tool !== TOOL.createDatabase) return [];
  const [d] = jsonObjectsOf(result);
  const ref = d ? pathIdent(d.database_id) : null;
  if (!d || ref === null) return [];
  return [databaseResource(ref, d)];
}

/**
 * The resource of a database the Management API described (`ref` already
 * checked by the caller), as discovery and `create_database` both return it :
 * named by `database_name`, with the non-secret metadata keys whose value has
 * the type Upstash documents — the answer is untrusted, a value of another
 * type is left out.
 */
export function databaseResource(ref: string, d: Readonly<Record<string, unknown>>): Resource {
  const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  const name = text(d.database_name);
  return {
    provider: PROVIDER_ID,
    ref,
    displayName: name ?? ref,
    metadata: {
      ...(text(d.region) ? { region: d.region } : {}),
      ...(text(d.primary_region) ? { primary_region: d.primary_region } : {}),
      ...(Array.isArray(d.read_regions) ? { read_regions: d.read_regions } : {}),
      ...(text(d.endpoint) ? { endpoint: d.endpoint } : {}),
      ...(text(d.state) ? { state: d.state } : {}),
      ...(text(d.database_type) ? { database_type: d.database_type } : {}),
      ...(typeof d.tls === 'boolean' ? { tls: d.tls } : {}),
    },
  };
}
