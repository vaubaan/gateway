/**
 * The "Git" block of a mission page (spec §4.1 ter, §4.4): where the agent's
 * git remote is and what git may do with it under this mission. Pure.
 *
 * What each permission means for git is the plugin's declaration
 * (`GitRemoteCapability.abilities`); whether the mission holds it, and
 * whether it asks first, is the mission's policy. A tool that hands a raw
 * provider token (`tokenHandouts`) is named apart: during that token's life
 * the rules above do not apply.
 */
import type { PluginRegistry } from '@vaubaan/plugin-sdk';
import type { MissionPolicyEntry } from '@vaubaan/shared';

import { gitRemoteBase } from '../git/paths';

export interface MissionGitView {
  /** `<public_url>/git/<ref>.git`, one per repository of the mission. */
  readonly remotes: readonly string[];
  readonly can: readonly string[];
  readonly asks: readonly string[];
  readonly cannot: readonly string[];
  /** The tools of the provider that hand a raw token, when the mission holds one of their permissions. */
  readonly rawTokenTools: readonly string[];
  /** The provider's name (`GitHub`). */
  readonly provider: string;
}

export function missionGitView(input: {
  readonly registry: PluginRegistry;
  readonly publicUrl: URL;
  readonly connections: readonly {
    readonly provider: string;
    readonly resources: readonly { readonly ref: string }[];
  }[];
  readonly policy: readonly Pick<MissionPolicyEntry, 'risk_id' | 'gate'>[];
}): MissionGitView | null {
  const registered = input.registry.gitRemote();
  const remote = registered?.plugin.gitRemote;
  if (!registered || !remote) return null;
  const refs = [
    ...new Set(
      input.connections
        .filter((c) => c.provider === registered.plugin.id)
        .flatMap((c) => c.resources.map((r) => r.ref)),
    ),
  ];
  if (refs.length === 0) return null;
  const base = gitRemoteBase(input.publicUrl);
  const gateOf = new Map(input.policy.map((entry) => [entry.risk_id, entry.gate]));
  const can: string[] = [];
  const asks: string[] = [];
  const cannot: string[] = [];
  for (const ability of remote.abilities ?? []) {
    const gate = gateOf.get(ability.risk_id);
    if (gate === undefined) cannot.push(ability.words);
    else if (gate === 'approval') asks.push(ability.words);
    else can.push(ability.words);
  }
  const rawTokenTools = (registered.plugin.tokenHandouts ?? [])
    .filter((handout) => handout.riskIds.some((risk) => gateOf.has(risk)))
    .map((handout) => handout.tool);
  return {
    remotes: refs.map((ref) => `${base}${ref}.git`),
    can,
    asks,
    cannot,
    rawTokenTools,
    provider: registered.plugin.displayName,
  };
}
