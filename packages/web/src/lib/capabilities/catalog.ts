/**
 * Pure catalog builder for `GET /api/v1/catalog`.
 *
 * Spec : docs/spec/vaubaan-gateway.md §7 (gateway surface).
 *
 * No I/O, no auth — takes the static provider surfaces + an optional granted
 * capability set, returns a JSON-serializable catalog. Kept separate from
 * `app/api/v1/catalog/route.ts` so the logic is unit-testable without a
 * live gateway / Supabase context.
 *
 * The `callable` predicate uses `isToolPotentiallyCallable` from
 * `@vaubaan/policy-engine/tools-filter` — the same predicate that filters
 * `tools/list`. It switches on the tool's `EnvResolution` so it stays in
 * lockstep with the runtime `covers()` enforcement (an env-less surface for
 * a `static` tool requires an env-less grant ; for `runtime` tools env is
 * ignored at this layer and the env defensive filter fires at call time).
 */

import {
  formatCapability,
  type Capability,
  type EnvResolution,
  type McpToolDeclaration,
  type ProviderBinding,
} from '@vaubaan/shared';
import { isToolPotentiallyCallable } from '@vaubaan/policy-engine';

export interface ProviderSource {
  slug: string;
  displayName: string;
  tools: ReadonlyArray<McpToolDeclaration>;
  capabilitiesOf: (tool: string) => readonly Capability[];
  envResolutionOf: (tool: string) => EnvResolution;
}

export interface ToolCatalogEntry {
  name: string;
  description: string;
  inputSchema: unknown;
  /** Env-less capability surface, formatted as slugs (`provider:plane/level:action`). */
  requiredCapabilities: string[];
  /** Only present when the caller is a `vbn_live_*` token (we know the
   *  granted set). True when at least one surface capability is covered by
   *  the granted set, env ignored. */
  callable?: boolean;
  /** Only present when `callable === false` — the surface caps the token
   *  doesn't carry. Mint a new token with any of these to unlock the tool. */
  missingCapabilities?: string[];
}

export interface ProviderCatalogEntry {
  slug: string;
  displayName: string;
  tools: ToolCatalogEntry[];
}

export function buildToolEntry(
  tool: McpToolDeclaration,
  surface: readonly Capability[],
  envResolution: EnvResolution,
  granted: readonly Capability[] | null,
): ToolCatalogEntry {
  const required = surface.map(formatCapability);
  const entry: ToolCatalogEntry = {
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema,
    requiredCapabilities: required,
  };
  if (granted) {
    const callable = isToolPotentiallyCallable(granted, surface, envResolution);
    entry.callable = callable;
    if (!callable) entry.missingCapabilities = required;
  }
  return entry;
}

export function buildProviderCatalog(
  sources: readonly ProviderSource[],
  granted: readonly Capability[] | null,
): ProviderCatalogEntry[] {
  return sources.map((src) => ({
    slug: src.slug,
    displayName: src.displayName,
    tools: src.tools.map((t) =>
      buildToolEntry(t, src.capabilitiesOf(t.name), src.envResolutionOf(t.name), granted),
    ),
  }));
}

/** One upstream resource the project is bound to (e.g. a Vercel projectId, a
 *  Supabase project_ref). Surfaced on the catalog so agents can discover the
 *  refs they need to pass at `tools/call` time. Without this, the gateway is
 *  the only thing that knows the binding — chicken-and-egg : the agent needs
 *  the ref to call, but cannot learn it from anywhere. */
export interface BindingDescriptor {
  resourceRef: string;
  environment: string | null;
  displayName: string | null;
}

/** Group provider bindings by provider slug. Empty providers are not emitted. */
export function groupBindings(
  bindings: readonly ProviderBinding[],
): Record<string, BindingDescriptor[]> {
  const out: Record<string, BindingDescriptor[]> = {};
  for (const b of bindings) {
    (out[b.provider] ??= []).push({
      resourceRef: b.resource_ref,
      environment: b.environment ?? null,
      displayName: b.display_name,
    });
  }
  return out;
}
