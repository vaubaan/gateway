/**
 * Plugin registry wiring — where the single provider list reaches the root.
 *
 * The registry itself is `@vaubaan/plugin-sdk`'s `PluginRegistry` (ADR
 * plugin-contract-and-credential-spec D6): the root builds it once from the
 * plugins the image ships (`shipped-plugins.ts`, the default
 * `RootDeps.buildRegistry`) and derives everything else from it.
 *
 * Two derivations live here because they bridge the registry with another
 * port of the root:
 *   - `RegistryCatalogIndex` answers the store's "does this RiskId exist?"
 *     from the loaded catalogs, env-qualified ids included;
 *   - `checkProviderApps` compares the `providers.<id>` blocks of the
 *     configuration with the registered ids.
 */
import { PluginRegistry } from '@vaubaan/plugin-sdk';
import { findRiskEntry, isAcceptableInEnv, isEnvScopedEntry } from '@vaubaan/policy-engine';
import { baseRiskId, parseRiskId, type RiskId } from '@vaubaan/shared';

import { ConfigError, providerEnvName, type ConfigIssue, type InstanceConfig } from '../config';
import type { Logger } from '../logging';
import type { CatalogIndex } from '../store';

/** A registry with no plugin — tests of the root that need no provider. */
export async function buildEmptyRegistry(): Promise<PluginRegistry> {
  return new PluginRegistry([]);
}

/**
 * `CatalogIndex` over the registry's catalogs. A base id (`acme.thing-write`)
 * exists when its provider is registered and its catalog has the entry; an
 * env-qualified id (`acme[prod].thing-write`) exists when, in addition, the
 * entry is env-scoped and lists that environment in `acceptable_in_envs`.
 * Anything else — unknown provider, wildcard, sentinel, malformed id — does
 * not exist, so the store refuses to persist it (spec §10).
 */
export class RegistryCatalogIndex implements CatalogIndex {
  constructor(private readonly registry: PluginRegistry) {}

  has(riskId: RiskId): boolean {
    const parsed = parseRiskId(riskId);
    if (!parsed) return false;
    const registered = this.registry.get(parsed.provider);
    if (!registered) return false;
    const entry = findRiskEntry(registered.catalog, baseRiskId(riskId));
    if (!entry) return false;
    if (parsed.env === null) return true;
    return isEnvScopedEntry(entry) && isAcceptableInEnv(entry, parsed.env);
  }
}

/**
 * Every `providers.<id>` block must name a registered plugin. While the
 * registry is empty (no plugin shipped yet) the mismatch is only logged;
 * once plugins are registered it is a configuration error, reported like
 * any other invalid key (exit 78 at boot).
 */
export function checkProviderApps(
  config: InstanceConfig,
  registry: PluginRegistry,
  logger: Logger,
): void {
  const unknown = [...config.providers.keys()].filter((id) => !registry.has(id));
  if (unknown.length === 0) return;

  if (registry.size === 0) {
    for (const id of unknown) {
      logger.warn('provider app configured but no plugin is registered yet', {
        key: `providers.${id}`,
      });
    }
    return;
  }

  const known = registry.ids.join(', ');
  const issues: ConfigIssue[] = unknown.map((id) => ({
    path: `providers.${id}`,
    env: [providerEnvName(id, '*')],
    message: `no registered plugin has id '${id}' (registered: ${known})`,
  }));
  throw new ConfigError(issues);
}
