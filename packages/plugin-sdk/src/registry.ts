/**
 * `PluginRegistry` — the single provider list.
 *
 * Plan §3.7 ; memory rule "one source of truth for the provider list". The
 * host builds one registry from the plugins it ships ; every other list
 * (tool → provider, UI labels, validation enums, catalogs per provider) is
 * derived from it. Nothing else in the repository may enumerate providers.
 */

import { prepareCatalog, type IndexedRiskCatalog } from '@vaubaan/policy-engine';
import {
  splitToolName,
  toolPrefixFor,
  type McpToolDeclaration,
  type Preset,
} from '@vaubaan/shared';

import { pluginIssues } from './define-plugin.ts';
import type { ProviderPlugin } from './plugin.ts';

export interface RegisteredPlugin {
  readonly plugin: ProviderPlugin;
  /** `plugin.catalog`, patterns parsed once at registration. */
  readonly catalog: IndexedRiskCatalog;
  readonly toolPrefix: string;
  readonly toolNames: ReadonlySet<string>;
}

/** What the UI needs to list providers. */
export interface ProviderLabel {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly description: string | null;
  /** `ProviderPlugin.summary` : the plain-words paragraph of the provider reference. */
  readonly summary: string | null;
  /** `ProviderPlugin.experimental`, normalised to a boolean. */
  readonly experimental: boolean;
}

export class PluginRegistryError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid plugin registry:\n  - ${issues.join('\n  - ')}`);
    this.name = 'PluginRegistryError';
  }
}

export class PluginRegistry {
  private readonly byId: ReadonlyMap<string, RegisteredPlugin>;
  private readonly byToolName: ReadonlyMap<string, RegisteredPlugin>;

  /** Build a registry ; throws `PluginRegistryError` on any cross-plugin conflict or ill-formed plugin. */
  constructor(plugins: readonly ProviderPlugin[]) {
    const issues: string[] = [];
    const byId = new Map<string, RegisteredPlugin>();
    const byToolName = new Map<string, RegisteredPlugin>();
    for (const plugin of plugins) {
      const own = pluginIssues(plugin);
      if (own.length > 0) {
        issues.push(...own.map((m) => `plugin '${String(plugin.id)}': ${m}`));
        continue;
      }
      if (byId.has(plugin.id)) {
        issues.push(`plugin '${plugin.id}' is registered twice`);
        continue;
      }
      let catalog: IndexedRiskCatalog;
      try {
        catalog = prepareCatalog(plugin.catalog, { warn: () => undefined });
      } catch (e) {
        issues.push(`plugin '${plugin.id}': ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      const registered: RegisteredPlugin = {
        plugin,
        catalog,
        toolPrefix: toolPrefixFor(plugin.id),
        toolNames: new Set(plugin.tools.map((t) => t.name)),
      };
      byId.set(plugin.id, registered);
      // Tool names cannot collide across plugins : ids are unique and the
      // prefix rule (checked per plugin) is a bijection on ids.
      for (const tool of plugin.tools) byToolName.set(tool.name, registered);
    }
    if (issues.length > 0) throw new PluginRegistryError(issues);
    this.byId = byId;
    this.byToolName = byToolName;
  }

  /** Provider ids, in registration order. The only provider list. */
  get ids(): readonly string[] {
    return [...this.byId.keys()];
  }

  get size(): number {
    return this.byId.size;
  }

  all(): readonly RegisteredPlugin[] {
    return [...this.byId.values()];
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): RegisteredPlugin | undefined {
    return this.byId.get(id);
  }

  /** Like `get`, throws when the provider is unknown. */
  require(id: string): RegisteredPlugin {
    const found = this.byId.get(id);
    if (!found)
      throw new Error(`Unknown provider '${id}' (known: ${this.ids.join(', ') || 'none'})`);
    return found;
  }

  /**
   * Resolve a tool name to its plugin, or `null`. Exact-name lookup first
   * (a plugin may declare tools the prefix rule alone would not attribute),
   * then the prefix rule for tools a plugin classifies but does not list.
   */
  providerForTool(toolName: string): RegisteredPlugin | null {
    const exact = this.byToolName.get(toolName);
    if (exact) return exact;
    const split = splitToolName(toolName);
    if (!split) return null;
    return this.byId.get(split.providerId) ?? null;
  }

  /** The indexed catalog of a provider. */
  catalogOf(id: string): IndexedRiskCatalog {
    return this.require(id).catalog;
  }

  /** The presets a provider ships. */
  presetsOf(id: string): readonly Preset[] {
    return this.require(id).plugin.catalog.presets ?? [];
  }

  /** Every tool of every plugin, in registration order. */
  toolDeclarations(): readonly McpToolDeclaration[] {
    return this.all().flatMap((r) => r.plugin.tools);
  }

  /** Labels for the UI. */
  labels(): readonly ProviderLabel[] {
    return this.all().map(({ plugin }) => ({
      id: plugin.id,
      displayName: plugin.displayName,
      version: plugin.version,
      description: plugin.description ?? null,
      summary: plugin.summary ?? null,
      experimental: plugin.experimental ?? false,
    }));
  }

  /**
   * Provider ids as a non-empty tuple, the shape schema libraries want for
   * an enum. Throws on an empty registry : a validation enum with no member
   * would accept nothing and hide a boot-order bug.
   */
  idEnum(): readonly [string, ...string[]] {
    const ids = this.ids;
    if (ids.length === 0) throw new Error('PluginRegistry.idEnum(): the registry is empty');
    return ids as [string, ...string[]];
  }
}

/** Functional alias of `new PluginRegistry(plugins)`. */
export function createRegistry(plugins: readonly ProviderPlugin[]): PluginRegistry {
  return new PluginRegistry(plugins);
}
