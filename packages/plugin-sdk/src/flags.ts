/**
 * Host flags — behaviours the plan leaves undecided, shipped off.
 *
 * Plan §8-Q4 : whether v5 keeps auto-filling arguments the mission leaves
 * no choice over. The plugin hook `normalizeArgs` exists so the answer can
 * be "yes" without a contract change ; until then the host does not call
 * it. (The v4 scope-injection module of the policy engine, which did the
 * same from project bindings, was deleted with the v4 application.)
 */

import type { Resource } from '@vaubaan/shared';

import type { ProviderPlugin } from './plugin.ts';

export interface PluginHostFlags {
  /** Call `plugin.normalizeArgs` before classification. Default off. */
  readonly argNormalization: boolean;
}

export const DEFAULT_HOST_FLAGS: PluginHostFlags = { argNormalization: false };

/**
 * Apply `normalizeArgs` when the flag is on and the plugin implements it ;
 * return the input untouched otherwise. The host calls this once, before
 * `classify`, so the classifier and `execute` see the same arguments.
 */
export function normalizeArgsIfEnabled(
  plugin: Pick<ProviderPlugin, 'normalizeArgs'>,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
  flags: PluginHostFlags = DEFAULT_HOST_FLAGS,
): Readonly<Record<string, unknown>> {
  if (!flags.argNormalization || !plugin.normalizeArgs) return args;
  return plugin.normalizeArgs(args, resources);
}
