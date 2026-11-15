/**
 * Identity of the `railway` service — the one place its ids and Railway's
 * own names are written.
 *
 * Handbook : docs/handbook/services/railway.md.
 *
 * `SERVICE_ID` is also written as `service:` and as the prefix of every id
 * in `risk-catalog.yaml`, and in the package name. Everything else — the
 * plugin id, the data-model service, the tool names, the resources
 * discovery returns — is derived from this module.
 */

import { toolPrefixFor, type UpstreamMcpServer } from '@vaubaan/plugin-sdk';

/** The service id. */
export const SERVICE_ID = 'railway';

/** `railway__` : prepended to the upstream tool names. */
export const TOOL_PREFIX = toolPrefixFor(SERVICE_ID);

/**
 * The MCP tool names of the plugin. Railway's upstream names are kebab-case
 * (`list-projects`) and are kept as they are after the prefix
 * (`railway__list-projects`) ; the last four are the plugin's own
 * GraphQL-backed variable tools (`custom-tools.ts`).
 */
export const TOOL = {
  whoami: `${TOOL_PREFIX}whoami`,
  listProjects: `${TOOL_PREFIX}list-projects`,
  createProject: `${TOOL_PREFIX}create-project`,
  listServices: `${TOOL_PREFIX}list-services`,
  listDeployments: `${TOOL_PREFIX}list-deployments`,
  getStatus: `${TOOL_PREFIX}get-status`,
  getLogs: `${TOOL_PREFIX}get-logs`,
  redeploy: `${TOOL_PREFIX}redeploy`,
  acceptDeploy: `${TOOL_PREFIX}accept-deploy`,
  railwayAgent: `${TOOL_PREFIX}railway-agent`,
  listVariables: `${TOOL_PREFIX}list-variables`,
  upsertVariable: `${TOOL_PREFIX}upsert-variable`,
  upsertVariables: `${TOOL_PREFIX}upsert-variables`,
  deleteVariable: `${TOOL_PREFIX}delete-variable`,
} as const;

/**
 * The `User-Agent` of every request to Railway. Cloudflare in front of
 * `mcp.railway.com` refuses some default user agents (error 1010, seen on
 * 2026-10-14) ; a named one is sent on the MCP server and the GraphQL API alike.
 */
export const RAILWAY_USER_AGENT = 'vaubaan-gateway';

/** Railway's official MCP server (Streamable HTTP, SSE-framed JSON-RPC). */
export const RAILWAY_MCP_URL = 'https://mcp.railway.com/';

/** Railway's public GraphQL API : the variable tools, discovery and the token checks. */
export const RAILWAY_GRAPHQL_URL = 'https://backboard.railway.com/graphql/v2';

/**
 * Railway's MCP server for the SDK's client. It is stateless per Bearer (no
 * `Mcp-Session-Id`, no `initialize` before `tools/call`, checked live on
 * 2026-10-14), so `session: 'never'` : each call stays the one request it
 * always was, and a 400 or 404 is the failure it says, not a cue to open a
 * session.
 */
export const RAILWAY_MCP_SERVER: UpstreamMcpServer = {
  url: RAILWAY_MCP_URL,
  name: 'Railway MCP server',
  headers: { 'user-agent': RAILWAY_USER_AGENT },
  session: 'never',
};
