/**
 * Identity of the `context7` service — the one place its ids are written.
 *
 * The plugin id, the data-model service, the tool names, the resource
 * `discoverResources` returns and the credential field are derived from this
 * module, so a classifier can never emit slices under one service while the
 * executor reads resources under another. `service:` and the ids of
 * `risk-catalog.yaml`, and the package name in `package.json`, are the other
 * places the id is written.
 */

import { toolPrefixFor, type UpstreamMcpServer } from '@vaubaan/plugin-sdk';

/** The service id. */
export const SERVICE_ID = 'context7';

/** Sent on every request, to the MCP server and to the REST API alike. */
export const CONTEXT7_USER_AGENT = 'vaubaan-gateway';

/** Context7's official MCP server (Streamable HTTP, SSE-framed JSON-RPC). */
export const CONTEXT7_MCP_URL = 'https://mcp.context7.com/mcp';

/**
 * Context7's MCP server for the SDK's client. It is stateless (no
 * `Mcp-Session-Id`, no `initialize` before `tools/call`, checked live on
 * 2026-10-16), so `session: 'never'` : each call stays the one request it
 * always was, and a 400 or 404 is the failure it says, not a cue to open a
 * session.
 */
export const CONTEXT7_MCP_SERVER: UpstreamMcpServer = {
  url: CONTEXT7_MCP_URL,
  name: 'Context7 MCP server',
  headers: { 'user-agent': CONTEXT7_USER_AGENT },
  session: 'never',
};

/** Name of the secret field of the `api-key` credential, declared in `credential.ts`, read in `usage.ts`. */
export const API_KEY_FIELD = 'api_key';

/** `context7__` : prepended to the upstream tool names. */
export const TOOL_PREFIX = toolPrefixFor(SERVICE_ID);

/**
 * The upstream tool names, as `tools/list` of `mcp.context7.com` answers
 * them (`upstream-tools.json`). The gateway's names are these, prefixed.
 */
export const UPSTREAM_TOOL = {
  resolveLibraryId: 'resolve-library-id',
  queryDocs: 'query-docs',
} as const;

/** The MCP tool names of the plugin : the upstream spelling after the prefix, as Railway does. */
export const TOOL = {
  resolveLibraryId: `${TOOL_PREFIX}${UPSTREAM_TOOL.resolveLibraryId}`,
  queryDocs: `${TOOL_PREFIX}${UPSTREAM_TOOL.queryDocs}`,
} as const;

/**
 * The ref of the one resource of an account : the library index its key
 * can query. A constant, because no answer of Context7 identifies the
 * teamspace a key belongs to (handbook) ; resources are unique per
 * account, so two accounts each have their own.
 */
export const INDEX_REF = 'docs';
