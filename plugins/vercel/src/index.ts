/**
 * `@vaubaan/plugin-vercel` — the Vercel provider plugin.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADR      : docs/decisions/plugin-contract-and-credential-spec.md.
 * Handbook : docs/handbook/providers/vercel.md ; guide : plugins/README.md.
 *
 * The plugin imports `@vaubaan/plugin-sdk` only. `definePlugin` validates the
 * definition at import time ; the YAML catalog is loaded here, once, when the
 * module is first imported (that is, at gateway boot).
 *
 * The block at the end re-exports the v4 shapes the gateway application
 * still imports (`VercelAdapter`, `vercelAvailableTools`, `vercelRiskCatalog`,
 * `classifyVercelV4`). They are deleted in P1.6 with the v4 pipeline.
 */

import {
  catalogPathNextTo,
  definePlugin,
  loadCatalogFile,
  type RiskCatalog,
} from '@vaubaan/plugin-sdk';

import {
  classifyVercel,
  toVercelEnv,
  vercelEnvOf,
  VERCEL_ENVS,
  type VercelEnv,
} from './classify.ts';
import {
  vercelAuth,
  vercelCredential,
  VERCEL_TEAM_ID_PATTERN,
  VERCEL_TOKENS_URL,
} from './credential.ts';
import { vercelDataModel } from './data-model.ts';
import {
  DISCOVERY_MAX_PAGES,
  DISCOVERY_PAGE_SIZE,
  discoverVercelResources,
  executeVercel,
  VERCEL_API_BASE,
  VERCEL_MCP_URL,
} from './execute.ts';
import { vercelTools } from './tools.ts';

// The YAML sits next to this module ; `catalogPathNextTo` keeps the path a
// filesystem path the bundler leaves alone (ADR plugin-catalog-path-and-standalone-tracing).
export const VERCEL_CATALOG_PATH = catalogPathNextTo(import.meta.url);

export const vercelCatalog = loadCatalogFile(VERCEL_CATALOG_PATH);

export const vercelPlugin = definePlugin({
  id: 'vercel',
  displayName: 'Vercel',
  version: '1.0.0',
  description:
    'Runtime hosting plane — projects, deployments, logs, env vars, custom domains, firewall, preview comments.',
  docsUrl:
    'https://github.com/sbw-vaubaan/vaubaan-gateway/blob/main/docs/handbook/providers/vercel.md',
  tools: vercelTools,
  dataModel: vercelDataModel,
  catalog: vercelCatalog.catalog,
  credential: vercelCredential,
  classify: classifyVercel,
  execute: executeVercel,
  discoverResources: discoverVercelResources,
  // The environment is the `env[<label>]` segment of the slice, not the
  // owner's label on the project resource (ADR fallback-risk-only-when-uncategorized D4).
  envOf: (slice) => vercelEnvOf(slice) ?? undefined,
});

export default vercelPlugin;

export {
  classifyVercel,
  discoverVercelResources,
  executeVercel,
  toVercelEnv,
  vercelAuth,
  vercelCredential,
  vercelDataModel,
  vercelEnvOf,
  vercelTools,
  DISCOVERY_MAX_PAGES,
  DISCOVERY_PAGE_SIZE,
  VERCEL_API_BASE,
  VERCEL_ENVS,
  VERCEL_MCP_URL,
  VERCEL_TEAM_ID_PATTERN,
  VERCEL_TOKENS_URL,
  type VercelEnv,
};

// ─── legacy v4, deleted in P1.6 ──────────────────────────────────────────────
// Same import paths as before so `apps/gateway` keeps compiling until the v4
// pipeline goes. Nothing new may import these.

/** @deprecated legacy v4, deleted in P1.6 — use `vercelPlugin`. */
export { VercelAdapter } from './vercel-adapter.ts';
/** @deprecated legacy v4, deleted in P1.6 — use `vercelPlugin.tools`. */
export { availableTools as vercelAvailableTools } from './tools.ts';
/** @deprecated legacy v4, deleted in P1.6 — use `vercelPlugin.catalog` (same object, loaded from the YAML). */
export const vercelRiskCatalog: RiskCatalog = vercelCatalog.catalog;
/** @deprecated legacy v4, deleted in P1.6 — use `vercelPlugin.classify(tool, args, resources)`. */
export { classifyVercelV4 } from './risk-classifier.ts';
/** @deprecated legacy v4, deleted in P1.6 — use `ClassifyOutcome` from the SDK. */
export type { ClassifyResult as VercelClassifyV4Result } from './risk-classifier.ts';
