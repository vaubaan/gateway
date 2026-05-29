/**
 * Vercel MCP tools — rewrap of the official Vercel MCP server at mcp.vercel.com.
 *
 * Spec : docs/spec/vaubaan-gateway.md §7.4.
 * ADR  : docs/decisions/rewrap-official-mcps.md.
 *
 * 18 tools fetched from upstream on 2026-05-23 and frozen as upstream-tools.json.
 * Names are prefixed `vercel__` to match the Vaubaan policy DSL provider scoping
 * convention. Refresh procedure : POST tools/list to mcp.vercel.com, copy each
 * tool with the prefix added.
 */

import type { McpToolDeclaration } from '@vaubaan/shared';
import upstream from './upstream-tools.json' with { type: 'json' };

export const availableTools: readonly McpToolDeclaration[] =
  upstream as ReadonlyArray<McpToolDeclaration>;

/** Strip the `vercel__` prefix to get the upstream tool name. */
export function toUpstreamName(toolName: string): string {
  return toolName.startsWith('vercel__') ? toolName.slice('vercel__'.length) : toolName;
}
