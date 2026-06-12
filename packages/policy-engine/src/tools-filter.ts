/**
 * Static filter for `tools/list` discovery.
 *
 * Spec : docs/spec/gateway-capability-model.md §3, §7.
 *
 * The MCP gateway responds to `tools/list` by enumerating only the tools the
 * access token *could potentially call*. Whether a tool is callable depends on
 * its `EnvResolution` mode :
 *
 *   - `static`  : the runtime requires an env-less grant exactly matching the
 *                 env-less surface ; the filter must enforce the same exact
 *                 match, otherwise a `@prod` grant would be advertised as
 *                 callable for a tool that ends up 403-ing at call time.
 *   - `runtime` : env is resolved from args (or from the matched binding) ;
 *                 the filter only checks (provider, plane, level, action) —
 *                 the env defensive filter at `tools/call` blocks the wrong
 *                 env at execution time.
 *
 * Both `tools/list` and the catalog's `callable` flag MUST use the same
 * predicate so they stay in lockstep with the hot-path `covers()` check.
 */

import {
  covers,
  type Capability,
  type EnvResolution,
  type McpToolDeclaration,
} from '@vaubaan/shared';

/** Provider plugin shape needed for filtering — a subset of ProviderAdapter. */
export interface ToolSurfaceProvider {
  readonly availableTools: ReadonlyArray<McpToolDeclaration>;
  toolCapabilities(tool: string): readonly Capability[];
  toolEnvResolution(tool: string): EnvResolution;
}

/** Low-level predicate : does `granted` cover `surface` if we strip env from
 *  both sides ? Used only as a building block for `isToolPotentiallyCallable`
 *  in the `runtime` mode ; runtime enforcement uses the strict 5-tuple
 *  `covers()` from `@vaubaan/shared`. */
export function coversIgnoringEnv(granted: Capability, surface: Capability): boolean {
  return (
    granted.provider === surface.provider &&
    granted.plane === surface.plane &&
    granted.level === surface.level &&
    granted.action === surface.action
  );
}

/** True when at least one capability in `surface` could plausibly be reached
 *  by the granted set under the tool's env-resolution mode. */
export function isToolPotentiallyCallable(
  granted: readonly Capability[],
  surface: readonly Capability[],
  envResolution: EnvResolution,
): boolean {
  if (envResolution === 'static') {
    // The runtime requires exact match incl. env (an env-less surface needs an
    // env-less grant). The filter mirrors that — otherwise `callable: true`
    // would lie.
    return surface.some((s) => granted.some((g) => covers(g, s)));
  }
  // env-resolved at call time : any env-qualified grant on the same 4-tuple is
  // a potential match. The env defensive filter at `tools/call` will reject
  // mismatched envs.
  return surface.some((s) => granted.some((g) => coversIgnoringEnv(g, s)));
}

export function filterAvailableTools(
  granted: readonly Capability[],
  provider: ToolSurfaceProvider,
): McpToolDeclaration[] {
  return provider.availableTools.filter((tool) => {
    const surface = provider.toolCapabilities(tool.name);
    const envResolution = provider.toolEnvResolution(tool.name);
    return isToolPotentiallyCallable(granted, surface, envResolution);
  });
}
