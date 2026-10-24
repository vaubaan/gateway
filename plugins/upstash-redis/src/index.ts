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
import { createdUpstashRedisResources } from './created.ts';
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
import { UPSTASH_REDIS_ICON } from './icon.ts';
import { upstashRedisToolTitles } from './tool-titles.ts';
import { upstashRedisTools } from './tools.ts';

// The YAML sits next to this module ; `catalogPathNextTo` keeps the path a
// filesystem path the bundler leaves alone (ADR plugin-catalog-path-and-standalone-tracing).
export const UPSTASH_REDIS_CATALOG_PATH = catalogPathNextTo(import.meta.url);

export const upstashRedisCatalog = loadCatalogFile(UPSTASH_REDIS_CATALOG_PATH);

export const upstashRedisPlugin = definePlugin({
  id: 'upstash-redis',
  displayName: 'Upstash Redis',
  icon: UPSTASH_REDIS_ICON,
  version: '3.2.0',
  description:
    'Serverless Redis plane — databases through the Management API, key-value data through each database REST endpoint.',
  summary:
    'One account is one Upstash account (email and management API key); one resource is one Redis database. Its owner labels each database with an environment; key reads and writes, deletions, FLUSH, arbitrary commands and database management are separate permissions held per label.',
  manualRevocation:
    'Delete the management API key in the Upstash console, under Account, Management API.',
  docsUrl: 'https://github.com/vaubaan/gateway/blob/main/docs/handbook/providers/upstash-redis.md',
  tools: upstashRedisTools,
  toolTitles: upstashRedisToolTitles,
  // A database is what an Upstash connection lists : a created one is
  // discovered at once (ADR discovery-runs-after-a-creating-call).
  resourceCreatingTools: ['upstash_redis__create_database'],
  // Read from the call's answer: the mission that created it reaches it at once
  // (ADR created-resources-join-the-mission).
  createdResources: createdUpstashRedisResources,
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
