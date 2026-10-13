/**
 * MCP tools of the `railway` provider — rewrap of the official Railway MCP
 * server at mcp.railway.com, plus four GraphQL-backed variable tools.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5.
 * ADR  : docs/decisions/railway-rewrap-remote-mcp.md.
 *
 * The 10 upstream tools were fetched verbatim from `mcp.railway.com
 * tools/list` on 2026-05-30 (with a Bearer scoped to
 * `resource=https://mcp.railway.com`). Names are prefixed `railway__` ; the
 * upstream names are kebab-case (`list-projects`), so the prefixed name is
 * `railway__list-projects`. Input schemas are the real ones (`required[]`,
 * enums, `additionalProperties: false`) — no guesses.
 *
 * Refresh procedure : POST `tools/list` to mcp.railway.com with a Bearer
 * scoped to `resource=https://mcp.railway.com`, prefix each name with
 * `railway__`, commit `upstream-tools.json`, bump the plugin version.
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

import { customTools } from './custom-tools.ts';
import upstream from './upstream-tools.json' with { type: 'json' };

export const RAILWAY_TOOL_PREFIX = 'railway__';

export const railwayTools: readonly McpToolDeclaration[] = [
  ...(upstream as ReadonlyArray<McpToolDeclaration>),
  ...customTools,
];

/**
 * @deprecated legacy v4 name, deleted in P1.6 — use `railwayTools`.
 */
export const availableTools = railwayTools;

/** Strip the `railway__` prefix to get the upstream tool name. */
export function toUpstreamName(toolName: string): string {
  return toolName.startsWith(RAILWAY_TOOL_PREFIX)
    ? toolName.slice(RAILWAY_TOOL_PREFIX.length)
    : toolName;
}
