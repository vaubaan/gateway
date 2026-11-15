/**
 * Identity of the `upstash-redis` service — the one place its ids are written.
 *
 * Handbook : docs/handbook/services/upstash-redis.md.
 *
 * `SERVICE_ID` is also written as `service:` and as the prefix of every id
 * in `risk-catalog.yaml`, and in the package name. Everything else — the
 * plugin id, the data-model service, the slices, the credential kind check,
 * the tool names, the resources discovery returns — is derived from this
 * module.
 */

import { toolPrefixFor } from '@vaubaan/plugin-sdk';

/** The service id. */
export const SERVICE_ID = 'upstash-redis';

/** `upstash_redis__` : the prefix of every tool name (the dash is not a tool-name character). */
export const TOOL_PREFIX = toolPrefixFor(SERVICE_ID);

/** The MCP tool names : 6 management tools (Management API), then 15 data tools (REST endpoint). */
export const TOOL = {
  listDatabases: `${TOOL_PREFIX}list_databases`,
  getDatabase: `${TOOL_PREFIX}get_database`,
  createDatabase: `${TOOL_PREFIX}create_database`,
  deleteDatabase: `${TOOL_PREFIX}delete_database`,
  renameDatabase: `${TOOL_PREFIX}rename_database`,
  getDatabaseStats: `${TOOL_PREFIX}get_database_stats`,
  execute: `${TOOL_PREFIX}execute`,
  get: `${TOOL_PREFIX}get`,
  set: `${TOOL_PREFIX}set`,
  del: `${TOOL_PREFIX}del`,
  keys: `${TOOL_PREFIX}keys`,
  scan: `${TOOL_PREFIX}scan`,
  ttl: `${TOOL_PREFIX}ttl`,
  expire: `${TOOL_PREFIX}expire`,
  hset: `${TOOL_PREFIX}hset`,
  hgetall: `${TOOL_PREFIX}hgetall`,
  lpush: `${TOOL_PREFIX}lpush`,
  lrange: `${TOOL_PREFIX}lrange`,
  sadd: `${TOOL_PREFIX}sadd`,
  smembers: `${TOOL_PREFIX}smembers`,
  dbsize: `${TOOL_PREFIX}dbsize`,
} as const;
