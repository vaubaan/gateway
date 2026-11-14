/**
 * Plugin registry wiring — where the single provider list reaches the root.
 *
 * The registry itself is `@vaubaan/plugin-sdk`'s `PluginRegistry` (ADR
 * plugin-contract-and-credential-spec D6): the root builds it once from the
 * plugins the image bundles (`shipped-plugins.ts`) and the ones the operator
 * pins (`server/plugins`), and derives everything else from it.
 *
 * Two derivations live here because they bridge the registry with another
 * port of the root:
 *   - `RegistryCatalogIndex` answers the store's "does this RiskId exist?"
 *     from the loaded catalogs, env-qualified ids included;
 *   - `checkSelfResources` compares the configured self resources with the
 *     registered ids;
 *   - `checkBrokeredPlugins` compares each brokered plugin with the OAuth
 *     provider table the broker compiles in (`@vaubaan/oauth-providers`);
 *   - `checkHostToolNames` refuses a plugin tool named like one of the host's
 *     own tools (`vaubaan__request_permission`), which the door routes first.
 */
import { PROVIDERS, type ProviderTable } from '@vaubaan/oauth-providers';
import {
  isBrokeredSpec,
  PluginRegistry,
  PluginRegistryError,
  type ProviderPlugin,
} from '@vaubaan/plugin-sdk';
import { findRiskEntry, isAcceptableInEnv, isEnvScopedEntry } from '@vaubaan/policy-engine';
import { baseRiskId, parseRiskId, type RiskId } from '@vaubaan/shared';

import { ConfigError, type InstanceConfig } from '../config';
import { permissionRequestTool } from '../execution/permission-request';
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
 * Every configured self resource (`self_resources`) names a registered plugin: an entry
 * of an unknown provider (a typo, `Railway` for `railway`) would match nothing and
 * protect nothing, silently (SEC 2026-10-15 re-check L-1). Exit 78 like any invalid key.
 */
export function checkSelfResources(config: InstanceConfig, registry: PluginRegistry): void {
  if (registry.size === 0) return;
  const unknown = config.selfResources.filter((self) => !registry.has(self.provider));
  if (unknown.length === 0) return;
  const known = registry.ids.join(', ');
  throw new ConfigError(
    unknown.map((self) => ({
      path: 'self_resources',
      env: ['VAUBAAN_SELF_RESOURCES'],
      message: `'${self.provider}' is not a registered plugin id (registered: ${known}); the entry would protect nothing`,
    })),
  );
}

/**
 * What a brokered plugin asks of the OAuth provider table (spec oauth-broker
 * §4): its `broker.provider` is a provider of the table, and every one of its
 * `scopes` is in that provider's `allowedScopes`. The broker refuses anything
 * else at the first flow; the gateway says it at boot, naming the plugin.
 * Empty when every brokered plugin fits.
 */
export function brokeredPluginProblems(
  plugins: readonly ProviderPlugin[],
  providers: ProviderTable = PROVIDERS,
): string[] {
  const problems: string[] = [];
  for (const plugin of plugins) {
    const spec = plugin.credential;
    if (spec.kind !== 'oauth2' || !isBrokeredSpec(spec)) continue;
    const provider = providers.get(spec.broker.provider);
    if (provider === undefined) {
      const known = [...providers.keys()].join(', ');
      problems.push(
        `plugin '${plugin.id}' is brokered by provider '${spec.broker.provider}', which the OAuth provider table does not list (listed: ${known})`,
      );
      continue;
    }
    const refused = spec.scopes.filter((scope) => !provider.allowedScopes.has(scope));
    if (refused.length > 0) {
      problems.push(
        `plugin '${plugin.id}' asks provider '${provider.id}' for scopes the OAuth provider table does not allow: ${refused.join(', ')}`,
      );
    }
  }
  return problems;
}

/**
 * The tools the host itself answers on the execution door, by exact name, before
 * the registry (ADR platform-management-is-a-plugin-on-the-execution-door): they
 * share the prefix `vaubaan__` with the `vaubaan` plugin's tools.
 */
export const HOST_TOOL_NAMES: readonly string[] = [permissionRequestTool.name];

/**
 * The plugin tools named like a host tool: the door would answer the host's and
 * the plugin's would never run, so a plugin may not take one of those names.
 */
export function hostToolNameProblems(
  plugins: readonly ProviderPlugin[],
  hostTools: readonly string[] = HOST_TOOL_NAMES,
): string[] {
  const taken = new Set(hostTools);
  return plugins.flatMap((plugin) =>
    plugin.tools
      .filter((tool) => taken.has(tool.name))
      .map(
        (tool) =>
          `plugin '${plugin.id}' declares the tool '${tool.name}', which the gateway itself answers: rename it`,
      ),
  );
}

/** Stops the boot on a plugin tool named like a host tool (`hostToolNameProblems`). */
export function checkHostToolNames(registry: PluginRegistry): void {
  const problems = hostToolNameProblems(registry.all().map((r) => r.plugin));
  if (problems.length > 0) throw new PluginRegistryError(problems);
}

/**
 * Stops the boot when a brokered plugin does not fit the OAuth provider table:
 * a plugin and a broker released apart (a scope added to one and not the
 * other) would otherwise fail only when someone connects an account.
 */
export function checkBrokeredPlugins(registry: PluginRegistry): void {
  const problems = brokeredPluginProblems(registry.all().map((r) => r.plugin));
  if (problems.length > 0) throw new PluginRegistryError(problems);
}
