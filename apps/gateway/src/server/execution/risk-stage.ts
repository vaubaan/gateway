/**
 * Risk stage — the unchanged decision core over the plugin registry
 * (spec §4.1 "classification by the plugin, intersection with the catalog,
 * check `risks_touched ⊆ accepted_risks`").
 *
 * The classifier, the catalog and the environment derivation all come from
 * the registered plugin of the target connection's provider; the resources
 * are the mission's on that connection, so an env-qualified risk the mission
 * accepted (`supabase[staging].bulk-row-write`) matches through the label of
 * the resource the call touches (`envResolverFor`, gateway-core's default).
 */
import {
  acceptedRisksOf,
  evaluateCallForToken,
  type CallVerdict,
  type RiskStage,
} from '@vaubaan/gateway-core';
import type { PluginRegistry } from '@vaubaan/plugin-sdk';

export function createRiskStage(deps: { readonly registry: PluginRegistry }): RiskStage {
  return {
    async evaluate(ctx, call, target): Promise<CallVerdict> {
      const registered = deps.registry.get(target.connection.provider);
      if (!registered) return { kind: 'no-catalog', provider: target.connection.provider };
      return evaluateCallForToken({
        tool: call.tool,
        args: call.args,
        resources: ctx.resources.filter((r) => r.connection_id === target.connection.id),
        // v5 missions carry no explicit denies: the policy is the enumeration.
        token: { id: ctx.token.id, accepted_risks: acceptedRisksOf(ctx) },
        adapter: registered.plugin,
        catalog: registered.catalog,
      });
    },
  };
}
