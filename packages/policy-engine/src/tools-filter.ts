/**
 * Static filter for `tools/list` discovery.
 *
 * Spec : docs/spec/gateway-capability-model.draft.md §3.
 *
 * The MCP gateway responds to `tools/list` by enumerating only the tools the
 * access token *could potentially call*. The filter is static : it compares the
 * tool's env-less capability surface against the granted set, ignoring env (env
 * depends on runtime args). A tool is listed when the granted set covers any of
 * its surface capabilities on (provider, plane, level, action).
 */

import type { Capability, McpToolDeclaration } from '@vaubaan/shared';

/** Provider plugin shape needed for filtering — a subset of ProviderAdapter. */
export interface ToolSurfaceProvider {
  readonly availableTools: ReadonlyArray<McpToolDeclaration>;
  toolCapabilities(tool: string): readonly Capability[];
}

function coversIgnoringEnv(granted: Capability, surface: Capability): boolean {
  return (
    granted.provider === surface.provider &&
    granted.plane === surface.plane &&
    granted.level === surface.level &&
    granted.action === surface.action
  );
}

export function filterAvailableTools(
  granted: readonly Capability[],
  provider: ToolSurfaceProvider,
): McpToolDeclaration[] {
  return provider.availableTools.filter((tool) => {
    const surface = provider.toolCapabilities(tool.name);
    return surface.some((s) => granted.some((g) => coversIgnoringEnv(g, s)));
  });
}
