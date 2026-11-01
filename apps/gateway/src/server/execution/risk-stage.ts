/**
 * Risk stage — the unchanged decision core over the plugin registry
 * (spec §4.1 "classification by the plugin, intersection with the catalog,
 * check `risks_touched ⊆ accepted_risks`"), once per resource set the call is
 * judged against (risk model §4.7).
 *
 * The classifier, the catalog and the environment derivation all come from
 * the registered plugin of the target connection's provider; the resources
 * are the mission's on that connection, every set together, so an
 * env-qualified risk the mission accepted (`supabase[staging].bulk-row-write`)
 * matches through the label of the resource the call touches (`envResolverFor`,
 * gateway-core's default). The sets choose only the policy: the call goes to
 * the set of the resource each slice names, and a call that cannot be placed in
 * one set must be accepted in every candidate set
 * (`evaluateCallForResourceSets`).
 */
import {
  evaluateCallForResourceSets,
  type CallVerdict,
  type MissionContext,
  type ResourceSetToJudge,
  type RiskStage,
} from '@vaubaan/gateway-core';
import type { PluginRegistry } from '@vaubaan/plugin-sdk';

import { classifyConnectionOf } from './resource-stage';

/** The sets of one connection of the mission, each with its refs and its accepted risks. */
export function resourceSetsToJudge(
  ctx: Pick<MissionContext, 'resource_sets' | 'resources' | 'policy'>,
  connectionId: string,
): ResourceSetToJudge[] {
  const refOf = new Map(ctx.resources.map((r) => [r.id, r.ref]));
  return ctx.resource_sets
    .filter((set) => set.connection_id === connectionId)
    .sort((a, b) => a.position - b.position)
    .map((set) => ({
      id: set.id,
      position: set.position,
      refs: set.resource_ids.flatMap((id) => {
        const ref = refOf.get(id);
        return ref === undefined ? [] : [ref];
      }),
      accepted_risks: ctx.policy
        .filter((entry) => entry.resource_set_id === set.id)
        .map((entry) => entry.risk_id),
    }));
}

export function createRiskStage(deps: { readonly registry: PluginRegistry }): RiskStage {
  return {
    async evaluate(ctx, call, target): Promise<CallVerdict> {
      const registered = deps.registry.get(target.connection.provider);
      if (!registered) return { kind: 'no-catalog', provider: target.connection.provider };
      return evaluateCallForResourceSets({
        tool: call.tool,
        args: call.args,
        resources: ctx.resources.filter((r) => r.connection_id === target.connection.id),
        connection: classifyConnectionOf(target.connection),
        // v5 missions carry no explicit denies: each set's policy is the enumeration.
        sets: resourceSetsToJudge(ctx, target.connection.id),
        adapter: registered.plugin,
        catalog: registered.catalog,
      });
    },
  };
}
