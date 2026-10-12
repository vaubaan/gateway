/**
 * Vercel MCP tools — rewrap of the official Vercel MCP server at mcp.vercel.com,
 * plus a small set of custom REST-backed tools layered on top.
 *
 * Spec : docs/spec/vaubaan-gateway.md §7.4.
 * ADRs :
 *   - docs/decisions/rewrap-official-mcps.md          (upstream forward)
 *   - docs/decisions/vercel-augment-with-rest-tools.md (custom tools)
 *
 * 18 tools fetched from upstream on 2026-05-23 and frozen as upstream-tools.json.
 * Custom tools live in custom-tools.ts and are routed by execute.ts to
 * api.vercel.com instead of the JSON-RPC forward.
 *
 * Names are prefixed `vercel__` to match the Vaubaan policy DSL provider scoping
 * convention. Refresh procedure : POST tools/list to mcp.vercel.com, copy each
 * tool with the prefix added.
 */

import type { McpToolDeclaration } from '@vaubaan/shared';
import upstream from './upstream-tools.json' with { type: 'json' };
import { customTools, isCustomTool } from './custom-tools.ts';

const upstreamTools = upstream as ReadonlyArray<McpToolDeclaration>;

export const availableTools: readonly McpToolDeclaration[] = [...upstreamTools, ...customTools];

/** Strip the `vercel__` prefix to get the upstream tool name. */
export function toUpstreamName(toolName: string): string {
  return toolName.startsWith('vercel__') ? toolName.slice('vercel__'.length) : toolName;
}

export { isCustomTool };
