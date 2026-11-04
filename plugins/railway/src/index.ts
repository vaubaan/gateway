/**
 * `@vaubaan/plugin-railway` — the Railway provider plugin.
 *
 * Spec     : docs/spec/vaubaan-gateway.md §5 (plugins) ; docs/spec/gateway-risk-model.md §7.
 * ADRs     : docs/decisions/rewrap-official-mcps.md ;
 *            docs/decisions/plugin-contract-and-credential-spec.md.
 * Handbook : docs/handbook/providers/railway.md ; guide : plugins/README.md.
 *
 * The plugin imports `@vaubaan/plugin-sdk` only. `definePlugin` validates the
 * definition at import time ; the YAML catalog is loaded here, once, when the
 * module is first imported (that is, at gateway boot).
 */

import { catalogPathNextTo, definePlugin, loadCatalogFile } from '@vaubaan/plugin-sdk';

import { classifyRailway, environmentsOf, isProjectScopedTool } from './classify.ts';
import { railwayDataModel } from './data-model.ts';
import { RAILWAY_AGENT_HINT, discoverRailwayResources, executeRailway } from './execute.ts';
import { createdRailwayResources } from './created.ts';
import { railwayCredential } from './credential.ts';
import { RAILWAY_ICON, RAILWAY_ICON_COLOR } from './icon.ts';
import {
  PROVIDER_ID,
  RAILWAY_GRAPHQL_URL,
  RAILWAY_MCP_SERVER,
  RAILWAY_MCP_URL,
  TOOL,
  TOOL_PREFIX,
} from './identity.ts';
import { railwayToolTitles } from './tool-titles.ts';
import { railwayTools, toUpstreamName } from './tools.ts';

// The YAML sits next to this module ; `catalogPathNextTo` keeps the path a
// filesystem path the bundler leaves alone (docs/handbook/plugin-sdk.md).
export const railwayCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));

export const railwayPlugin = definePlugin({
  id: PROVIDER_ID,
  displayName: 'Railway',
  icon: RAILWAY_ICON,
  iconColor: RAILWAY_ICON_COLOR,
  resourceNoun: { one: 'project', other: 'projects' },
  // Always equal to `version` in this plugin's package.json (a test checks it).
  version: '6.0.0',
  description:
    'Deploy, redeploy, read logs and manage variables of Railway projects through the official Railway MCP server and GraphQL API.',
  summary:
    'One account is one workspace token (or an account token) pasted by hand; every tool runs with it. One resource is one project. Its owner labels each project with an environment (prod, staging, preview or dev); deploys and variable changes are held per label, and a project without a label can only be inspected.',
  manualRevocation:
    'Delete the token in Railway, signed in as the account that created it: Account settings, Tokens.',
  docsUrl: 'https://github.com/vaubaan/gateway/blob/main/docs/handbook/providers/railway.md',
  tools: railwayTools,
  toolTitles: railwayToolTitles,
  // A project is what a Railway connection lists : a created project is
  // discovered at once (ADR created-resources-join-the-mission).
  resourceCreatingTools: [TOOL.createProject],
  // Read from the call's answer: the mission that created it reaches it at once
  // (ADR created-resources-join-the-mission).
  createdResources: createdRailwayResources,
  dataModel: railwayDataModel,
  catalog: railwayCatalog.catalog,
  credential: railwayCredential,
  // Railway's agent takes a free-text request and acts with the whole
  // credential: no resource check can keep it off the project hosting the
  // gateway (SEC 2026-10-15 re-check M-1).
  unboundTools: {
    [TOOL.railwayAgent]:
      "Railway's agent acts on a free-text request with the whole credential, so it cannot be kept away from the project that hosts this gateway.",
  },
  classify: classifyRailway,
  execute: executeRailway,
  discoverResources: discoverRailwayResources,
});

export default railwayPlugin;

export {
  PROVIDER_ID,
  RAILWAY_AGENT_HINT,
  RAILWAY_GRAPHQL_URL,
  RAILWAY_MCP_SERVER,
  RAILWAY_MCP_URL,
  TOOL,
  TOOL_PREFIX,
  classifyRailway,
  discoverRailwayResources,
  environmentsOf,
  executeRailway,
  isProjectScopedTool,
  railwayCredential,
  railwayDataModel,
  railwayTools,
  toUpstreamName,
};
export type { RailwayEnvironmentRef } from './classify.ts';
export {
  explainMcpRefusal,
  probeRailwayToken,
  RAILWAY_TOKEN_FIELD,
  RAILWAY_TOKEN_KINDS,
  verifyRailwayToken,
} from './credential.ts';
export type { RailwayTokenKind, RailwayTokenProbe } from './credential.ts';
