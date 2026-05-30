/**
 * Scope injection — hide and auto-fill arguments the access token has no choice over.
 *
 * Spec : docs/spec/vaubaan-gateway.md §7.2 (filtered tools/list) + spec §6.4
 *        (resource_ref resolution).
 *
 * Premise : if an access token's Project has exactly one ProviderBinding for a given
 * provider, then any tool argument that identifies that resource (owner+repo
 * for GitHub, project_id for Vercel, project_ref for Supabase, projectId for
 * Railway, teamId for Vercel team) is already fully determined. Exposing it to the agent is
 * worse than useless :
 *   - the agent might pass the wrong value (which we'd deny via policy
 *     anyway, but with confusing feedback),
 *   - it leaks resource identifiers that the agent didn't need to know.
 *
 * Solution : at `tools/list` time, strip those args from each tool's
 * inputSchema. At `tools/call` time, auto-inject them server-side before
 * forwarding to the upstream adapter.
 *
 * The mapping is keyed by `<provider>` + `<arg-name>` — kept here as a
 * single source of truth instead of scattered across each adapter.
 */

import type { McpToolDeclaration, Provider, ProviderBinding } from '@vaubaan/shared';

interface InjectionPlan {
  /** owner + repo built from `binding.resource_ref` shaped as `owner/repo`. */
  owner?: string;
  repo?: string;
  /** Vercel + Railway project id (both upstreams name the arg `projectId`). */
  projectId?: string;
  /** Vercel team id (lives on `provider_admins.team_id` ; the caller passes it). */
  teamId?: string;
  /** Supabase project ref. */
  project_ref?: string;
}

export interface ScopeContext {
  bindings: ProviderBinding[];
  /** team_id of the matching ProviderAdmin row, when available. */
  vercelTeamId?: string | null;
}

/**
 * Compute which arguments are determined for a given provider in this access token's
 * project. Returns null if the args are NOT fully determined (zero or 2+
 * bindings) — in which case the agent must keep providing them.
 */
export function injectionPlanFor(provider: Provider, scope: ScopeContext): InjectionPlan | null {
  const matching = scope.bindings.filter((b) => b.provider === provider);
  if (matching.length !== 1) return null;
  const binding = matching[0]!;

  if (provider === 'github') {
    const m = binding.resource_ref.match(/^([^/]+)\/([^/]+)$/);
    if (!m) return null;
    return { owner: m[1]!, repo: m[2]! };
  }
  if (provider === 'vercel') {
    const plan: InjectionPlan = { projectId: binding.resource_ref };
    if (scope.vercelTeamId) plan.teamId = scope.vercelTeamId;
    return plan;
  }
  if (provider === 'supabase') {
    return { project_ref: binding.resource_ref };
  }
  if (provider === 'railway') {
    return { projectId: binding.resource_ref };
  }
  return null;
}

/**
 * Strip the injected args from a tool's inputSchema. The result has the
 * properties removed AND the required[] cleaned, so the agent's tool
 * picker doesn't think they're missing.
 */
export function stripInjectedArgs(
  tool: McpToolDeclaration,
  plan: InjectionPlan,
): McpToolDeclaration {
  const props = tool.inputSchema.properties ?? {};
  const required = tool.inputSchema.required ?? [];
  const injected = Object.keys(plan).filter((k) => plan[k as keyof InjectionPlan] !== undefined);
  if (injected.length === 0) return tool;

  const nextProps: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (!injected.includes(k)) nextProps[k] = v;
  }
  const nextRequired = required.filter((r) => !injected.includes(r));
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: nextProps,
      required: nextRequired,
    },
  };
}

/**
 * Merge the injection plan into the call arguments. Caller-provided values
 * take precedence (so an admin can still override in MCP Inspector while
 * normal agents get the auto-fill).
 */
export function mergeInjectedArgs(
  args: Record<string, unknown>,
  plan: InjectionPlan,
): Record<string, unknown> {
  const out = { ...args };
  for (const [k, v] of Object.entries(plan)) {
    if (v === undefined) continue;
    if (out[k] === undefined || out[k] === null || out[k] === '') {
      out[k] = v;
    }
  }
  return out;
}
