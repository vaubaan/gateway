/**
 * The "Git" block of a mission page (spec §4.1 ter, §4.4): where the agent's
 * git remotes are and what git may do with them under this mission. Pure.
 *
 * What each permission means for git is the plugin's declaration
 * (`GitRemoteCapability.abilities`); whether the mission holds it, and
 * whether it asks first, is the mission's policy.
 */
import type { PluginRegistry } from '@vaubaan/plugin-sdk';
import type { MissionPolicyEntry } from '@vaubaan/shared';

import { gitRemoteUrl } from '../git/paths';

/** The git remote of one service of the mission. */
export interface MissionGitView {
  /** `<public_url>/git/<service>/<ref>.git`, one per repository of the mission on it. */
  readonly remotes: readonly string[];
  readonly can: readonly string[];
  readonly asks: readonly string[];
  readonly cannot: readonly string[];
  /** The service's name (`GitHub`). */
  readonly service: string;
}

/**
 * One view per service of the mission whose plugin declares a git remote and
 * on which the mission has repositories, in the order of the accounts.
 */
export function missionGitViews(input: {
  readonly registry: PluginRegistry;
  readonly publicUrl: URL;
  readonly accounts: readonly {
    readonly service: string;
    readonly resources: readonly { readonly ref: string }[];
  }[];
  readonly policy: readonly Pick<MissionPolicyEntry, 'risk_id' | 'gate'>[];
}): readonly MissionGitView[] {
  const gateOf = new Map(input.policy.map((entry) => [entry.risk_id, entry.gate]));
  const services = [...new Set(input.accounts.map((c) => c.service))];
  return services.flatMap((serviceId) => {
    const registered = input.registry.gitRemoteOf(serviceId);
    const remote = registered?.plugin.gitRemote;
    if (!registered || !remote) return [];
    const refs = [
      ...new Set(
        input.accounts
          .filter((c) => c.service === serviceId)
          .flatMap((c) => c.resources.map((r) => r.ref)),
      ),
    ];
    if (refs.length === 0) return [];
    const can: string[] = [];
    const asks: string[] = [];
    const cannot: string[] = [];
    for (const ability of remote.abilities ?? []) {
      const gate = gateOf.get(ability.risk_id);
      if (gate === undefined) cannot.push(ability.words);
      else if (gate === 'approval') asks.push(ability.words);
      else can.push(ability.words);
    }
    return [
      {
        remotes: refs.map((ref) => gitRemoteUrl(input.publicUrl, serviceId, ref)),
        can,
        asks,
        cannot,
        service: registered.plugin.displayName,
      },
    ];
  });
}
