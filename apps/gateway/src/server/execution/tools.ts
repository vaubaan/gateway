/**
 * Tool discovery and the catalog document (spec §4.1 "Discovery", "Catalog").
 *
 * `tools/list` shows the tools a mission can potentially call: every tool of
 * a stable plugin for which the mission holds a connection AND accepts at
 * least one risk. The filter is per provider, not per tool: a plugin does not
 * declare which risks a tool can touch (that depends on the arguments —
 * the branch, the path, the environment), so a finer static filter would
 * either hide callable tools or need a contract the plugins do not have. A
 * listed tool can therefore still be refused `risk-not-accepted` at call time.
 * Experimental plugins list nothing (`ProviderPlugin.experimental`).
 *
 * `GET /mcp/catalog` is the agent's source of discovery for upstream refs: the
 * whole tool surface of the instance with a `callable` flag, the connections
 * and resources the mission may touch with their environment labels, what
 * is left of the budget per accepted risk in the current period, and whose
 * token the caller is using (`token`): an agent can then say "I am using
 * Xavier's token on mission X" (spec §0 "Mission token": the holder is
 * authenticated).
 */
import { tokenHolderLabel, type MissionContext } from '@vaubaan/gateway-core';
import type { PluginRegistry } from '@vaubaan/plugin-sdk';
import type {
  ConnectionStatus,
  Gate,
  McpToolDeclaration,
  MissionTokenKind,
  RiskId,
} from '@vaubaan/shared';
import { parseRiskId } from '@vaubaan/shared/risk-id';

import type { CurrentPeriod, MissionState } from '../budget';

/** Providers for which the mission holds a connection and accepts at least one risk. */
export function callableProviders(ctx: MissionContext): Set<string> {
  const accepted = new Set<string>();
  for (const entry of ctx.policy) {
    const parsed = parseRiskId(entry.risk_id);
    if (parsed) accepted.add(parsed.provider);
  }
  return new Set(ctx.connections.map((c) => c.provider).filter((p) => accepted.has(p)));
}

/** What `tools/list` returns for the mission. */
export function callableTools(ctx: MissionContext, registry: PluginRegistry): McpToolDeclaration[] {
  const providers = callableProviders(ctx);
  const tools: McpToolDeclaration[] = [];
  for (const { plugin } of registry.all()) {
    if (plugin.experimental || !providers.has(plugin.id)) continue;
    tools.push(...plugin.tools);
  }
  return tools;
}

export interface CatalogTool {
  readonly name: string;
  readonly provider: string;
  readonly description: string;
  /** True when `tools/list` shows it to this mission. */
  readonly callable: boolean;
}

export interface CatalogResource {
  readonly ref: string;
  readonly env: string | null;
  readonly display_name: string;
}

export interface CatalogConnection {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  readonly status: ConnectionStatus;
  readonly resources: readonly CatalogResource[];
}

export interface CatalogBudgetLine {
  readonly risk_id: RiskId;
  readonly quota: number;
  readonly consumed: number;
  readonly remaining: number;
  readonly rate_limit: { readonly max: number; readonly window_seconds: number };
  readonly gate: Gate;
}

/** Whose token authenticated the request. */
export interface CatalogToken {
  /** `member`: a person who generated it for themselves; `named`: a machine the creator named. */
  readonly kind: MissionTokenKind;
  /** The member's email, or the token's name. */
  readonly holder: string;
  /** Public prefix of the token, as the session and the audit show it. */
  readonly prefix: string;
}

export interface MissionCatalog {
  readonly mission: {
    readonly id: string;
    readonly name: string;
    /** Email of the mission's creator: the one who answers its requests. `null` if unknown. */
    readonly creator: string | null;
    /** `active`, or why calls are refused. */
    readonly state: MissionState['kind'];
    readonly expires_at: string | null;
    /** Current period; `end` is when the budget reloads, `null` for a one-off mission. */
    readonly period: { readonly start: string; readonly end: string | null } | null;
  };
  /** The token this request presented, and who it belongs to. */
  readonly token: CatalogToken;
  readonly tools: readonly CatalogTool[];
  readonly callable_tools: readonly string[];
  readonly connections: readonly CatalogConnection[];
  readonly budget: readonly CatalogBudgetLine[];
}

export function buildCatalog(
  ctx: MissionContext,
  registry: PluginRegistry,
  state: MissionState,
  people: { readonly creator: string | null } = { creator: null },
): MissionCatalog {
  const callable = new Set(callableTools(ctx, registry).map((t) => t.name));
  const tools: CatalogTool[] = [];
  for (const { plugin } of registry.all()) {
    if (plugin.experimental) continue;
    for (const tool of plugin.tools) {
      tools.push({
        name: tool.name,
        provider: plugin.id,
        description: tool.description,
        callable: callable.has(tool.name),
      });
    }
  }

  const period: CurrentPeriod | null = state.kind === 'active' ? state.period : null;
  const remaining = state.kind === 'active' ? state.remaining : null;
  return {
    mission: {
      id: ctx.mission.id,
      name: ctx.mission.name,
      creator: people.creator,
      state: state.kind,
      expires_at: ctx.mission.expires_at,
      period: period ? { start: period.start, end: period.end } : null,
    },
    token: {
      kind: ctx.token.holder.kind,
      holder: tokenHolderLabel(ctx.token.holder),
      prefix: ctx.token.prefix,
    },
    tools,
    callable_tools: [...callable],
    connections: ctx.connections.map((connection) => ({
      id: connection.id,
      provider: connection.provider,
      name: connection.display_name,
      status: connection.status,
      resources: ctx.resources
        .filter((r) => r.connection_id === connection.id)
        .map((r) => ({ ref: r.ref, env: r.env ?? null, display_name: r.displayName })),
    })),
    budget: ctx.policy.map((entry) => {
      // An inactive mission has nothing left to spend.
      const left = remaining ? (remaining[entry.risk_id] ?? entry.quota) : 0;
      return {
        risk_id: entry.risk_id,
        quota: entry.quota,
        consumed: Math.max(0, entry.quota - left),
        remaining: left,
        rate_limit: entry.rate_limit,
        gate: entry.gate,
      };
    }),
  };
}
