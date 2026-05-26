/**
 * Static filter for `tools/list` discovery.
 *
 * Spec : docs/spec/mcp-proxy.md §7.2.
 *
 * The MCP gateway responds to `tools/list` by enumerating only the tools the
 * access token *could potentially call* (no evaluation of constraints, which depend on
 * runtime arguments). This narrows the agent's surface and reduces confusion.
 */

import { minimatch } from 'minimatch';
import type { McpToolDeclaration, Role } from '@vaubaan/shared';

export function filterAvailableTools(
  roles: Role[],
  availableTools: ReadonlyArray<McpToolDeclaration>,
): McpToolDeclaration[] {
  const out: McpToolDeclaration[] = [];
  for (const tool of availableTools) {
    if (toolIsReachable(tool.name, roles)) out.push(tool);
  }
  return out;
}

function toolIsReachable(toolName: string, roles: Role[]): boolean {
  for (const role of roles) {
    for (const rule of role.permissions.rules) {
      if (rule.effect !== 'allow') continue;
      if (rule.tool !== undefined && rule.tool === toolName) return true;
      if (rule.tool_matches && rule.tool_matches.some((p) => minimatch(toolName, p))) return true;
    }
  }
  return false;
}
