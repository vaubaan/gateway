/**
 * Railway MCP tools — rewrap of the official Railway MCP server at mcp.railway.com.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5, §7.4.
 * ADR  : docs/decisions/railway-rewrap-remote-mcp.md.
 *
 * 10 tools fetched from upstream during the POC (2026-05-29). Names are
 * prefixed `railway__` to match the Vaubaan policy DSL provider-scoping
 * convention (the upstream names are kebab-case, e.g. `list-projects`, so the
 * prefixed name is `railway__list-projects`).
 *
 * Tool list cross-checked against `docs.railway.com/ai/mcp-server`. Argument
 * names follow Railway's public GraphQL convention (camelCase : `projectId`,
 * `environmentId`, `serviceId`) per `docs.railway.com/reference/public-api`.
 * The required/optional flags are best-effort ; the upstream will return a
 * clear JSON-RPC error if we mis-marked one — fix = re-fetch tools/list with
 * a live Bearer + commit.
 *
 * Refresh procedure : POST tools/list to mcp.railway.com with a Bearer scoped
 * to `resource=https://mcp.railway.com`, copy each tool with the prefix added.
 */

import type { McpToolDeclaration } from '@vaubaan/shared';
import upstream from './upstream-tools.json' with { type: 'json' };

export const availableTools: readonly McpToolDeclaration[] =
  upstream as ReadonlyArray<McpToolDeclaration>;

/** Strip the `railway__` prefix to get the upstream tool name. */
export function toUpstreamName(toolName: string): string {
  return toolName.startsWith('railway__') ? toolName.slice('railway__'.length) : toolName;
}
