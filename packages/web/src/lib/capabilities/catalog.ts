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
 * The `callable` predicate matches `coversIgnoringEnv` from
 * `@vaubaan/policy-engine/tools-filter` exactly — both paths must stay in
 * lockstep so a tool listed by `tools/list` is `callable: true` here and
 * vice-versa.
 */

import { formatCapability, type Capability, type McpToolDeclaration } from '@vaubaan/shared';
import { coversIgnoringEnv } from '@vaubaan/policy-engine';

export interface ProviderSource {
  slug: string;
  displayName: string;
  tools: ReadonlyArray<McpToolDeclaration>;
  capabilitiesOf: (tool: string) => readonly Capability[];
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
    const callable = surface.some((s) => granted.some((g) => coversIgnoringEnv(g, s)));
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
    tools: src.tools.map((t) => buildToolEntry(t, src.capabilitiesOf(t.name), granted)),
  }));
}
