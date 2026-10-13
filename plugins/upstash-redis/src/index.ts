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
 *
 * The block at the end re-exports the v4 shapes the gateway application
 * still imports (`UpstashRedisAdapter`, `upstashRedisAvailableTools`,
 * `upstashRedisRiskCatalog`, `classifyUpstashRedisV4`). They are deleted in
 * P1.6 with the v4 pipeline.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { definePlugin, loadCatalogFile, type RiskCatalog } from '@vaubaan/plugin-sdk';

import {
  classifyUpstashRedis,
  KNOWN_DESTRUCTIVE,
  KNOWN_READS,
  KNOWN_WRITES,
  redisVerbOf,
  resolveDatabase,
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
} from './execute.ts';
import { upstashRedisTools } from './tools.ts';

// The YAML sits next to this module. The path is built from `import.meta.url`
// as a string rather than with `new URL('./risk-catalog.yaml', import.meta.url)` :
// bundlers (Turbopack in `apps/gateway`) rewrite that exact pattern into an
// asset URL of another realm, which `node:url`'s `fileURLToPath` rejects.
// An SDK helper replaces this in a later feature.
export const UPSTASH_REDIS_CATALOG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'risk-catalog.yaml',
);

export const upstashRedisCatalog = loadCatalogFile(UPSTASH_REDIS_CATALOG_PATH);

export const upstashRedisPlugin = definePlugin({
  id: 'upstash-redis',
  displayName: 'Upstash Redis',
  version: '1.0.0',
  description:
    'Serverless Redis plane — databases through the Management API, key-value data through each database REST endpoint.',
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
  basicAuthHeader,
  buildCommand,
  classifyUpstashRedis,
  discoverUpstashRedisResources,
  executeUpstashRedis,
  redactDatabases,
  redisVerbOf,
  resolveDatabase,
  upstashAuth,
  upstashRedisCredential,
  upstashRedisDataModel,
  upstashRedisTools,
  KNOWN_DESTRUCTIVE,
  KNOWN_READS,
  KNOWN_WRITES,
  MAX_DISCOVERED_DATABASES,
  REDACTED_DATABASE_FIELDS,
  UPSTASH_API_KEYS_URL,
  UPSTASH_EMAIL_PATTERN,
  UPSTASH_MANAGEMENT_API,
  type UpstashAuth,
};

// ─── legacy v4, deleted in P1.6 ──────────────────────────────────────────────
// Same import paths as before so `apps/gateway` keeps compiling until the v4
// pipeline goes. Nothing new may import these.

/** @deprecated legacy v4, deleted in P1.6 — use `upstashRedisPlugin`. */
export { UpstashRedisAdapter } from './upstash-redis-adapter.ts';
/** @deprecated legacy v4, deleted in P1.6 — use `upstashRedisPlugin.tools`. */
export { availableTools as upstashRedisAvailableTools } from './tools.ts';
/** @deprecated legacy v4, deleted in P1.6 — use `upstashRedisPlugin.catalog` (same object, loaded from the YAML). */
export const upstashRedisRiskCatalog: RiskCatalog = upstashRedisCatalog.catalog;
/** @deprecated legacy v4, deleted in P1.6 — use `upstashRedisPlugin.classify(tool, args, resources)`. */
export { classifyUpstashRedisV4 } from './risk-classifier.ts';
/** @deprecated legacy v4, deleted in P1.6 — use `ClassifyOutcome` from the SDK. */
export type { ClassifyResult as UpstashRedisClassifyV4Result } from './risk-classifier.ts';
