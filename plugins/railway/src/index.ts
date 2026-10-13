/**
 * `@vaubaan/plugin-railway` — the Railway provider plugin.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADRs     : docs/decisions/railway-rewrap-remote-mcp.md ;
 *            docs/decisions/plugin-contract-and-credential-spec.md.
 * Handbook : docs/handbook/providers/railway.md ; guide : plugins/README.md.
 *
 * The plugin imports `@vaubaan/plugin-sdk` only. `definePlugin` validates the
 * definition at import time ; the YAML catalog is loaded here, once, when the
 * module is first imported (that is, at gateway boot).
 *
 * The legacy v4 exports at the bottom keep the v4 application compiling until
 * P1.6 replaces its last consumers with the registry.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';

import { classifyRailway, environmentsOf, isProjectScopedTool } from './classify.ts';
import {
  RAILWAY_APP_CONFIG_KEYS,
  RAILWAY_AUTHORIZATION_URL,
  RAILWAY_MCP_RESOURCE,
  RAILWAY_REFRESH_THRESHOLD_MS,
  RAILWAY_SCOPES,
  RAILWAY_TOKEN_URL,
  railwayCredentialSpec,
  railwayNeedsRefresh,
  refreshRailwayCredential,
} from './credential.ts';
import { railwayDataModel } from './data-model.ts';
import {
  RAILWAY_AGENT_HINT,
  RAILWAY_GRAPHQL_URL,
  RAILWAY_MCP_URL,
  discoverRailwayResources,
  executeRailway,
} from './execute.ts';
import { RAILWAY_TOOL_PREFIX, railwayTools, toUpstreamName } from './tools.ts';

// The path is built with `node:path` from `import.meta.url`, not with
// `new URL('./risk-catalog.yaml', import.meta.url)` : Turbopack (apps/gateway)
// rewrites that literal into a static asset URL and the YAML can no longer be
// read at boot. An SDK helper replaces this in P1.2-SDK.
export const railwayCatalog = loadCatalogFile(
  join(dirname(fileURLToPath(import.meta.url)), 'risk-catalog.yaml'),
);

export const railwayPlugin = definePlugin({
  id: 'railway',
  displayName: 'Railway',
  version: '1.0.0',
  description:
    'Deploy, redeploy, read logs and manage variables of Railway projects through the official Railway MCP server and GraphQL API.',
  docsUrl:
    'https://github.com/sbw-vaubaan/vaubaan-gateway/blob/main/docs/handbook/providers/railway.md',
  tools: railwayTools,
  dataModel: railwayDataModel,
  catalog: railwayCatalog.catalog,
  credential: railwayCredentialSpec,
  classify: classifyRailway,
  execute: executeRailway,
  discoverResources: discoverRailwayResources,
  refresh: (ctx) => refreshRailwayCredential(ctx),
});

export default railwayPlugin;

export {
  RAILWAY_AGENT_HINT,
  RAILWAY_APP_CONFIG_KEYS,
  RAILWAY_AUTHORIZATION_URL,
  RAILWAY_GRAPHQL_URL,
  RAILWAY_MCP_RESOURCE,
  RAILWAY_MCP_URL,
  RAILWAY_REFRESH_THRESHOLD_MS,
  RAILWAY_SCOPES,
  RAILWAY_TOKEN_URL,
  RAILWAY_TOOL_PREFIX,
  classifyRailway,
  discoverRailwayResources,
  environmentsOf,
  executeRailway,
  isProjectScopedTool,
  railwayCredentialSpec,
  railwayDataModel,
  railwayNeedsRefresh,
  railwayTools,
  refreshRailwayCredential,
  toUpstreamName,
};
export type { RailwayEnvironmentRef } from './classify.ts';

// ─────────────────────────────────────────────────────────────────────────────
// legacy v4, deleted in P1.6 — consumed by apps/gateway (build.ts, state.ts,
// risk-catalog/loader.ts, provider-info.ts, api/v1/catalog). No new import.
// ─────────────────────────────────────────────────────────────────────────────

/** @deprecated legacy v4, deleted in P1.6 — use `railwayPlugin`. */
export { RailwayAdapter } from './railway-adapter.ts';
/** @deprecated legacy v4, deleted in P1.6. */
export type { RailwayAdapterConfig, RailwayRefreshedTokens } from './railway-adapter.ts';
/** @deprecated legacy v4, deleted in P1.6 — use `railwayPlugin.tools`. */
export { availableTools as railwayAvailableTools } from './tools.ts';
/** @deprecated legacy v4, deleted in P1.6 — use `railwayPlugin.catalog` (the same object, loaded from YAML). */
export const railwayRiskCatalog = railwayCatalog.catalog;
/** @deprecated legacy v4, deleted in P1.6 — use `classifyRailway(tool, args, resources)`. */
export { classifyRailwayV4 } from './risk-classifier.ts';
/** @deprecated legacy v4, deleted in P1.6 — use `ClassifyOutcome` from the SDK. */
export type { RailwayClassifyResult } from './risk-classifier.ts';
