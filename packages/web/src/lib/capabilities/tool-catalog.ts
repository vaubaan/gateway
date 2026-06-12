/**
 * MCP tool catalog — aggregates, per provider, the static surface
 * `(tool name, description, env-less capabilities[])` exposed by each
 * provider package.
 *
 * Source of truth :
 *   - `<provider>AvailableTools`        — the MCP tool declarations
 *   - `<provider>ToolCapabilities(tool)` — the env-less capability surface
 *     a tool requires, as emitted by the provider classifier.
 *
 * Used by the provider rings page to show, under each plane, which MCP
 * tools live on that plane and which capability slug(s) they require.
 */

import type { Capability, McpToolDeclaration } from '@vaubaan/shared';
import { githubAvailableTools, githubToolCapabilities } from '@vaubaan/providers-github';
import { vercelAvailableTools, vercelToolCapabilities } from '@vaubaan/providers-vercel';
import { supabaseAvailableTools, supabaseToolCapabilities } from '@vaubaan/providers-supabase';
import { railwayAvailableTools, railwayToolCapabilities } from '@vaubaan/providers-railway';
import { sshAvailableTools, sshToolCapabilities } from '@vaubaan/providers-ssh';

export interface ToolEntry {
  /** Full MCP tool name (e.g. `github__list_branches`). */
  name: string;
  /** Plain-language description from the tool declaration. */
  description: string;
  /** Env-less capability surface the tool requires. May be empty for
   *  unknown tools, but for catalog entries it is always non-empty. */
  capabilities: readonly Capability[];
}

interface ProviderToolSource {
  tools: ReadonlyArray<McpToolDeclaration>;
  capabilitiesOf: (tool: string) => readonly Capability[];
}

const SOURCES: Record<string, ProviderToolSource> = {
  github: { tools: githubAvailableTools, capabilitiesOf: githubToolCapabilities },
  vercel: { tools: vercelAvailableTools, capabilitiesOf: vercelToolCapabilities },
  supabase: { tools: supabaseAvailableTools, capabilitiesOf: supabaseToolCapabilities },
  railway: { tools: railwayAvailableTools, capabilitiesOf: railwayToolCapabilities },
  ssh: { tools: sshAvailableTools, capabilitiesOf: sshToolCapabilities },
};

/** All MCP tool entries declared by a provider package, in declaration order.
 *  Returns [] when the slug has no provider package wired (e.g. catalog-only
 *  entries with no live classifier). */
export function providerToolEntries(providerSlug: string): readonly ToolEntry[] {
  const src = SOURCES[providerSlug];
  if (!src) return [];
  return src.tools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    capabilities: src.capabilitiesOf(t.name),
  }));
}

/** Filter the provider's tool entries to those that touch a given plane. */
export function providerPlaneTools(providerSlug: string, planeSlug: string): readonly ToolEntry[] {
  return providerToolEntries(providerSlug).filter((e) =>
    e.capabilities.some((c) => c.plane === planeSlug),
  );
}
