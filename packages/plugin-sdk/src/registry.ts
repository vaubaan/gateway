/**
 * `PluginRegistry` — the single service list.
 *
 * Plan §3.7 ; memory rule "one source of truth for the service list". The
 * host builds one registry from the plugins it ships ; every other list
 * (tool → service, UI labels, validation enums, catalogs per service) is
 * derived from it. Nothing else in the repository may enumerate services.
 */

import { prepareCatalog, type IndexedRiskCatalog } from '@vaubaan/policy-engine';
import { splitToolName, toolPrefixFor, type McpToolDeclaration } from '@vaubaan/shared';

import { isBrokeredSpec } from './credential.ts';
import { pluginIssues } from './define-plugin.ts';
import type { ServicePlugin } from './plugin.ts';

export interface RegisteredPlugin {
  readonly plugin: ServicePlugin;
  /** `plugin.catalog`, patterns parsed once at registration. */
  readonly catalog: IndexedRiskCatalog;
  readonly toolPrefix: string;
  readonly toolNames: ReadonlySet<string>;
}

/**
 * The mark of a service as the interface draws it : the path data of its
 * icon (`ServicePlugin.icon`) and the colour it is drawn in
 * (`ServicePlugin.iconColor`, `null` when the plugin declares none).
 */
export interface ServiceIcon {
  readonly path: string;
  readonly color: string | null;
}

/** The `ServiceIcon` of a plugin, or `null` when it declares no icon (a colour alone draws nothing). */
export function serviceIconOf(
  plugin: Pick<ServicePlugin, 'icon' | 'iconColor'>,
): ServiceIcon | null {
  return plugin.icon ? { path: plugin.icon, color: plugin.iconColor ?? null } : null;
}

/** What the UI needs to list services. */
export interface ServiceLabel {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly description: string | null;
  /** The service's mark, path and colour (`serviceIconOf`) ; `null` when the plugin declares no icon. */
  readonly icon: ServiceIcon | null;
  /** `ServicePlugin.summary` : the plain-words paragraph of the service reference. */
  readonly summary: string | null;
}

/**
 * @deprecated Renamed `ServiceLabel` (ADR one-word-per-thing-account-service-plugin, R2);
 * kept for one minor. Removed in 0.10.
 */
export type ProviderLabel = ServiceLabel;

export class PluginRegistryError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid plugin registry:\n  - ${issues.join('\n  - ')}`);
    this.name = 'PluginRegistryError';
  }
}

export class PluginRegistry {
  private readonly byId = new Map<string, RegisteredPlugin>();
  private readonly byToolName = new Map<string, RegisteredPlugin>();

  /** Build a registry ; throws `PluginRegistryError` on any cross-plugin conflict or ill-formed plugin. */
  constructor(plugins: readonly ServicePlugin[]) {
    const issues: string[] = [];
    for (const plugin of plugins) {
      const prepared = this.prepare(plugin);
      if ('issues' in prepared) issues.push(...prepared.issues);
      else this.add(prepared.registered);
    }
    if (issues.length > 0) throw new PluginRegistryError(issues);
  }

  /** A plugin checked against itself and the registry, ready to add; never adds. */
  private prepare(
    plugin: ServicePlugin,
    { replacing = false }: { readonly replacing?: boolean } = {},
  ): { readonly registered: RegisteredPlugin } | { readonly issues: readonly string[] } {
    const own = pluginIssues(plugin);
    if (own.length > 0) return { issues: own.map((m) => `plugin '${String(plugin.id)}': ${m}`) };
    if (!replacing && this.byId.has(plugin.id)) {
      return { issues: [`plugin '${plugin.id}' is registered twice`] };
    }
    let catalog: IndexedRiskCatalog;
    try {
      catalog = prepareCatalog(plugin.catalog, { warn: () => undefined });
    } catch (e) {
      return { issues: [`plugin '${plugin.id}': ${e instanceof Error ? e.message : String(e)}`] };
    }
    return {
      registered: {
        plugin,
        catalog,
        toolPrefix: toolPrefixFor(plugin.id),
        toolNames: new Set(plugin.tools.map((t) => t.name)),
      },
    };
  }

  private add(registered: RegisteredPlugin): void {
    this.byId.set(registered.plugin.id, registered);
    // Tool names cannot collide across plugins : ids are unique and the
    // prefix rule (checked per plugin) is a bijection on ids.
    for (const tool of registered.plugin.tools) this.byToolName.set(tool.name, registered);
  }

  /**
   * Adds a plugin to a running registry (ADR plugins-installed-when-first-needed): the
   * same checks as the constructor; an id it holds is refused (`replace` swaps a version)
   * and nothing is ever removed. Throws `PluginRegistryError` and leaves the registry as it was.
   */
  register(plugin: ServicePlugin): RegisteredPlugin {
    const prepared = this.prepare(plugin);
    if ('issues' in prepared) throw new PluginRegistryError(prepared.issues);
    this.add(prepared.registered);
    return prepared.registered;
  }

  /**
   * Replaces the registered version of a plugin by another of the same id (ADR
   * plugins-activated-by-an-administrator-on-trial, amendment 2026-11-19): the same checks
   * as `register`, then the entry and its tool names swapped at once, in place in the
   * registration order. Throws `PluginRegistryError` and leaves the registry as it was,
   * also when no plugin of that id is registered.
   */
  replace(plugin: ServicePlugin): RegisteredPlugin {
    const previous = this.byId.get(plugin.id);
    if (!previous) {
      throw new PluginRegistryError([`plugin '${String(plugin.id)}' is not registered`]);
    }
    const prepared = this.prepare(plugin, { replacing: true });
    if ('issues' in prepared) throw new PluginRegistryError(prepared.issues);
    for (const tool of previous.plugin.tools) {
      if (this.byToolName.get(tool.name) === previous) this.byToolName.delete(tool.name);
    }
    // `Map.set` on a key it holds keeps its place: the registration order stays.
    this.add(prepared.registered);
    return prepared.registered;
  }

  /** Service ids, in registration order. The only service list. */
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

  /** Like `get`, throws when the service is unknown. */
  require(id: string): RegisteredPlugin {
    const found = this.byId.get(id);
    if (!found)
      throw new Error(`Unknown service '${id}' (known: ${this.ids.join(', ') || 'none'})`);
    return found;
  }

  /**
   * Resolve a tool name to its plugin, or `null`. Exact-name lookup first
   * (a plugin may declare tools the prefix rule alone would not attribute),
   * then the prefix rule for tools a plugin classifies but does not list.
   */
  serviceForTool(toolName: string): RegisteredPlugin | null {
    const exact = this.byToolName.get(toolName);
    if (exact) return exact;
    const split = splitToolName(toolName);
    if (!split) return null;
    return this.byId.get(split.serviceId) ?? null;
  }

  /** @deprecated Renamed `serviceForTool` (rename R2); kept for one minor. Removed in 0.10. */
  providerForTool(toolName: string): RegisteredPlugin | null {
    return this.serviceForTool(toolName);
  }

  /**
   * The plugin `id` names when it declares a git remote
   * (`ServicePlugin.gitRemote`), or `null`: an unknown id, or a plugin
   * without one. The git door resolves the `<service>` segment of its path
   * here (ADR protocol-doors-belong-to-the-host).
   */
  gitRemoteOf(id: string): RegisteredPlugin | null {
    const registered = this.byId.get(id);
    return registered?.plugin.gitRemote !== undefined ? registered : null;
  }

  /** Every plugin that declares a git remote, in registration order; any number may. */
  gitRemotes(): readonly RegisteredPlugin[] {
    return this.all().filter((r) => r.plugin.gitRemote !== undefined);
  }

  /**
   * The broker provider a plugin's `oauth2` spec takes its client from
   * (`OAuth2BrokeredSpec.broker.provider`), or `null` when the plugin needs no
   * OAuth broker. Throws when the service is unknown.
   */
  brokerProviderOf(id: string): string | null {
    const spec = this.require(id).plugin.credential;
    return spec.kind === 'oauth2' && isBrokeredSpec(spec) ? spec.broker.provider : null;
  }

  /**
   * Every broker provider some registered plugin needs, once each, in
   * registration order: what the configuration's `oauth_brokers` should serve.
   */
  brokerProviders(): readonly string[] {
    const out = new Set<string>();
    for (const id of this.ids) {
      const service = this.brokerProviderOf(id);
      if (service !== null) out.add(service);
    }
    return [...out];
  }

  /** The indexed catalog of a service. */
  catalogOf(id: string): IndexedRiskCatalog {
    return this.require(id).catalog;
  }

  /** Every tool of every plugin, in registration order. */
  toolDeclarations(): readonly McpToolDeclaration[] {
    return this.all().flatMap((r) => r.plugin.tools);
  }

  /** Labels for the UI. */
  labels(): readonly ServiceLabel[] {
    return this.all().map(({ plugin }) => ({
      id: plugin.id,
      displayName: plugin.displayName,
      version: plugin.version,
      description: plugin.description ?? null,
      icon: serviceIconOf(plugin),
      summary: plugin.summary ?? null,
    }));
  }

  /**
   * Service ids as a non-empty tuple, the shape schema libraries want for
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
export function createRegistry(plugins: readonly ServicePlugin[]): PluginRegistry {
  return new PluginRegistry(plugins);
}
