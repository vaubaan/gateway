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
 */

import { catalogPathNextTo, definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';

import { classifyRailway, environmentsOf, isProjectScopedTool } from './classify.ts';
import {
  RAILWAY_APP_CONFIG_KEYS,
  RAILWAY_AUTHORIZATION_URL,
  RAILWAY_MCP_RESOURCE,
  RAILWAY_SCOPES,
  RAILWAY_TOKEN_URL,
  railwayCredentialSpec,
} from './credential.ts';
import { railwayDataModel } from './data-model.ts';
import {
  RAILWAY_AGENT_HINT,
  RAILWAY_GRAPHQL_URL,
  RAILWAY_MCP_URL,
  discoverRailwayResources,
  executeRailway,
} from './execute.ts';
import { railwayTokenCredential } from './token.ts';
import { railwayToolTitles } from './tool-titles.ts';
import { RAILWAY_TOOL_PREFIX, railwayTools, toUpstreamName } from './tools.ts';

// The YAML sits next to this module ; `catalogPathNextTo` keeps the path a
// filesystem path the bundler leaves alone (ADR plugin-catalog-path-and-standalone-tracing).
export const railwayCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export const railwayPlugin = definePlugin({
  id: 'railway',
  displayName: 'Railway',
  version: '4.2.0',
  description:
    'Deploy, redeploy, read logs and manage variables of Railway projects through the official Railway MCP server and GraphQL API.',
  summary:
    'One account is one Railway account reached through the company Railway app, or a workspace token (or an account token) pasted by hand; every tool runs either way. One resource is one project. Its owner labels each project with an environment (prod, staging, preview or dev); deploys and variable changes are held per label, and a project without a label can only be inspected.',
  manualRevocation:
    "In your Railway account settings, open Authorized Apps, select your company's app and choose Revoke Access: every token it holds stops working at once.",
  docsUrl: 'https://github.com/vaubaan/gateway/blob/main/docs/handbook/providers/railway.md',
  tools: railwayTools,
  toolTitles: railwayToolTitles,
  dataModel: railwayDataModel,
  catalog: railwayCatalog.catalog,
  credential: railwayCredentialSpec,
  // Beside the OAuth app : a workspace or account token pasted by hand, for
  // every tool (ADR token-connections-beside-the-integration-app, amended).
  alternativeCredentials: [railwayTokenCredential],
  // Railway's agent takes a free-text request and acts with the whole
  // credential: no resource check can keep it off the project hosting the
  // gateway (SEC 2026-10-15 re-check M-1).
  unboundTools: {
    'railway__railway-agent':
      "Railway's agent acts on a free-text request with the whole credential, so it cannot be kept away from the project that hosts this gateway.",
  },
  classify: classifyRailway,
  execute: executeRailway,
  discoverResources: discoverRailwayResources,
});

export default railwayPlugin;

export {
  RAILWAY_AGENT_HINT,
  RAILWAY_APP_CONFIG_KEYS,
  RAILWAY_AUTHORIZATION_URL,
  RAILWAY_GRAPHQL_URL,
  RAILWAY_MCP_RESOURCE,
  RAILWAY_MCP_URL,
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
  railwayTools,
  toUpstreamName,
};
export type { RailwayEnvironmentRef } from './classify.ts';
export {
  explainMcpRefusal,
  probeRailwayToken,
  railwayTokenCredential,
  RAILWAY_TOKEN_FIELD,
  RAILWAY_TOKEN_KINDS,
  verifyRailwayToken,
} from './token.ts';
export type { RailwayTokenKind, RailwayTokenProbe } from './token.ts';
