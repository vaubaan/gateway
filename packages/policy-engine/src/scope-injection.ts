/**
 * QUARANTINED — scope injection (v4), kept behind a flag that defaults to off.
 *
 * Plan §8-Q4 leaves open whether v5 keeps auto-filling arguments the
 * mission has no choice over (owner/repo when the mission touches one
 * repository, project id when it touches one project). Two reasons to
 * doubt it : the v4 implementation is hard-coded to four SaaS providers and
 * to `vercelTeamId`, and v5 missions may select several resources of one
 * connection, which makes the "exactly one binding" premise rare.
 *
 * Until the question is settled the module compiles, its tests run, and
 * `injectionPlanFor` returns `null` unless the caller passes
 * `{ enabled: true }`. The v5 replacement, if any, is the plugin hook
 * `normalizeArgs(args, resources)` in `@vaubaan/plugin-sdk`, itself behind
 * the host flag `argNormalization` (also default off). Nothing else in v5
 * may depend on this module.
 *
 * Premise of the v4 behaviour : if a token's project has exactly one
 * binding for a provider, then any tool argument that identifies that
 * resource is fully determined. At `tools/list` time the args are stripped
 * from each tool's inputSchema ; at `tools/call` time they are auto-injected
 * server-side before forwarding.
 */

import type { McpToolDeclaration, Provider, ProviderBinding } from '@vaubaan/shared';

/** The quarantine flag. Defaults to off (plan §8-Q4 undecided). */
export interface ScopeInjectionFlags {
  readonly enabled: boolean;
}

export const SCOPE_INJECTION_DEFAULT_FLAGS: ScopeInjectionFlags = { enabled: false };

export interface InjectionPlan {
  /** owner + repo built from `binding.resource_ref` shaped as `owner/repo`. */
  owner?: string;
  repo?: string;
  /** Vercel + Railway project id (both upstreams name the arg `projectId`). */
  projectId?: string;
  /** Vercel team id (lives on the connection's credential metadata ; the caller passes it). */
  teamId?: string;
  /** Supabase project ref. */
  project_ref?: string;
}

export interface ScopeContext {
  bindings: ProviderBinding[];
  /** Vercel team id, when the connection carries one. */
  vercelTeamId?: string | null;
}

/**
 * Compute which arguments are determined for a given provider. Returns null
 * when the flag is off, or when the args are NOT fully determined (zero or
 * 2+ bindings) — in which case the agent must keep providing them.
 */
export function injectionPlanFor(
  provider: Provider,
  scope: ScopeContext,
  flags: ScopeInjectionFlags = SCOPE_INJECTION_DEFAULT_FLAGS,
): InjectionPlan | null {
  if (!flags.enabled) return null;
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
 * take precedence (so a human can still override in MCP Inspector while
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
