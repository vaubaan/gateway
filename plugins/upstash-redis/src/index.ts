/**
 * `@vaubaan/plugin-upstash-redis` — the Upstash Redis provider plugin.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADR      : docs/decisions/plugin-contract-and-credential-spec.md.
 * Handbook : docs/handbook/providers/upstash-redis.md ; guide : plugins/README.md.
 *
 * The plugin imports `@vaubaan/plugin-sdk` only. `definePlugin` validates the
 * definition at import time ; the YAML catalog is loaded here, once, when the
 * module is first imported (that is, at gateway boot).
 */

import { catalogPathNextTo, definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';

import {
  classifyRedisCommands,
  classifyUpstashRedis,
  KNOWN_ADMIN,
  KNOWN_ARBITRARY,
  KNOWN_DELETES,
  KNOWN_DESTRUCTIVE,
  KNOWN_READS,
  KNOWN_WRITES,
  redisCommandClass,
  redisCommandOf,
  pathIdent,
  redisVerbOf,
  resolveDatabase,
  TRANSACTION_CONTROL,
  type RedisCommandClass,
} from './classify.ts';
import {
  basicAuthHeader,
  upstashAuth,
  upstashRedisCredential,
  UPSTASH_API_KEYS_URL,
  UPSTASH_EMAIL_PATTERN,
  type UpstashAuth,
} from './credential.ts';
import { upstashRedisDataModel } from './data-model.ts';
import {
  buildCommand,
  discoverUpstashRedisResources,
  executeUpstashRedis,
  MAX_DISCOVERED_DATABASES,
  redactDatabases,
  REDACTED_DATABASE_FIELDS,
  UPSTASH_MANAGEMENT_API,
  UPSTASH_REST_HOST_SUFFIX,
} from './execute.ts';
import { upstashRedisTools } from './tools.ts';

// The YAML sits next to this module ; `catalogPathNextTo` keeps the path a
// filesystem path the bundler leaves alone (ADR plugin-catalog-path-and-standalone-tracing).
export const UPSTASH_REDIS_CATALOG_PATH = catalogPathNextTo(import.meta.url);

export const upstashRedisCatalog = loadCatalogFile(UPSTASH_REDIS_CATALOG_PATH);

export const upstashRedisPlugin = definePlugin({
  id: 'upstash-redis',
  displayName: 'Upstash Redis',
  version: '2.0.1',
  description:
    'Serverless Redis plane — databases through the Management API, key-value data through each database REST endpoint.',
  summary:
    'One connection is one Upstash account (email and management API key); one resource is one Redis database. The connection owner labels each database with an environment; key reads and writes, deletions, FLUSH, arbitrary commands and database management are separate risks accepted per label.',
  manualRevocation:
    'Delete the management API key in the Upstash console, under Account, Management API.',
  docsUrl:
    'https://github.com/sbw-vaubaan/vaubaan-gateway/blob/main/docs/handbook/providers/upstash-redis.md',
  tools: upstashRedisTools,
  dataModel: upstashRedisDataModel,
  catalog: upstashRedisCatalog.catalog,
  credential: upstashRedisCredential,
  classify: classifyUpstashRedis,
  execute: executeUpstashRedis,
  discoverResources: discoverUpstashRedisResources,
});

export default upstashRedisPlugin;

export {
  UPSTASH_REST_HOST_SUFFIX,
  basicAuthHeader,
  buildCommand,
  classifyRedisCommands,
  classifyUpstashRedis,
  discoverUpstashRedisResources,
  executeUpstashRedis,
  redactDatabases,
  redisCommandClass,
  redisCommandOf,
  pathIdent,
  redisVerbOf,
  resolveDatabase,
  upstashAuth,
  upstashRedisCredential,
  upstashRedisDataModel,
  upstashRedisTools,
  KNOWN_ADMIN,
  KNOWN_ARBITRARY,
  KNOWN_DELETES,
  KNOWN_DESTRUCTIVE,
  KNOWN_READS,
  KNOWN_WRITES,
  TRANSACTION_CONTROL,
  type RedisCommandClass,
  MAX_DISCOVERED_DATABASES,
  REDACTED_DATABASE_FIELDS,
  UPSTASH_API_KEYS_URL,
  UPSTASH_EMAIL_PATTERN,
  UPSTASH_MANAGEMENT_API,
  type UpstashAuth,
};
