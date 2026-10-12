/**
 * Railway MCP tools — rewrap of the official Railway MCP server at mcp.railway.com.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5, §7.4.
 * ADR  : docs/decisions/railway-rewrap-remote-mcp.md.
 *
 * 10 tools fetched verbatim from `mcp.railway.com tools/list` on 2026-05-30
 * (using a Bearer scoped to `resource=https://mcp.railway.com`). Names are
 * prefixed `railway__` to match the Vaubaan policy DSL provider-scoping
 * convention (the upstream names are kebab-case, e.g. `list-projects`, so the
 * prefixed name is `railway__list-projects`). inputSchemas are real (including
 * `required[]`, enums, and additionalProperties:false) — no guesses.
 *
 * Refresh procedure : POST tools/list to mcp.railway.com with a Bearer scoped
 * to `resource=https://mcp.railway.com`, prefix each name with `railway__`,
 * commit.
 */

import type { McpToolDeclaration } from '@vaubaan/shared';
import upstream from './upstream-tools.json' with { type: 'json' };
import { customTools } from './custom-tools.ts';

export const availableTools: readonly McpToolDeclaration[] = [
  ...(upstream as ReadonlyArray<McpToolDeclaration>),
  ...customTools,
];

/** Strip the `railway__` prefix to get the upstream tool name. */
export function toUpstreamName(toolName: string): string {
  return toolName.startsWith('railway__') ? toolName.slice('railway__'.length) : toolName;
}
