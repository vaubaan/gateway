/**
 * The plugins an instance knows and the ones it registers (ADR
 * plugins-bundled-or-pinned-by-the-operator). Pure: the bundled plugins of the image,
 * the pins read from the plugins directory (`loader.ts`) and `plugins.enabled` in,
 * the list to register and the inventory Administration shows out.
 *
 * - **The pin wins**: a pinned plugin with the id of a bundled one takes its place in
 *   the registration order, and the inventory keeps the bundled version it replaces.
 * - **`plugins.enabled`** filters what is registered; an id no plugin has stops the boot.
 * - **Accounts are served**: a service the store holds accounts for and no registered
 *   plugin serves stops the boot, naming the service and the count.
 */
import type { ServicePlugin } from '@vaubaan/plugin-sdk';

import { ConfigError, envNamesFor, type ConfigIssue } from '../config';
import type { PinnedPlugin } from './loader';

/**
 * Where the version loaded comes from: the image (`bundled`, its preinstalled version),
 * an archive an administrator installed (`installed`), or the operator's plugins
 * directory (`pinned`). The pin wins over an installed version, which wins over the
 * image's (spec §5).
 */
export type PluginOrigin = 'bundled' | 'installed' | 'pinned';

/** One plugin the instance knows, registered or not: a line of Administration › Plugins. */
export interface PluginInventoryEntry {
  readonly id: string;
  /** `displayName` of the plugin. */
  readonly name: string;
  /** The version loaded: the pin's when pinned. */
  readonly version: string;
  readonly origin: PluginOrigin;
  /** The image's version a pin or an installed version replaces; `null` for the image's own, or a plugin the image does not bundle. */
  readonly replaces: string | null;
  /** Registered: `plugins.enabled` is unset or names it. */
  readonly enabled: boolean;
  /** The pin's or the installed version's directory; `null` for a bundled plugin. */
  readonly path: string | null;
}

/** What the boot registers and what it shows. */
export interface PluginSet {
  /** The plugins to register, in registration order: bundled order, then the pins of new ids. */
  readonly plugins: readonly ServicePlugin[];
  /** Every plugin known, registered or not, in the same order. */
  readonly inventory: readonly PluginInventoryEntry[];
}

export interface PluginSetInput {
  readonly bundled: readonly ServicePlugin[];
  readonly pinned: readonly PinnedPlugin[];
  /** The installed versions this start loads, one per id (`loadInstalled`). */
  readonly installed?: readonly PinnedPlugin[];
  /** `plugins.enabled`; `null`: every plugin. */
  readonly enabled: readonly string[] | null;
}

interface Known {
  readonly plugin: ServicePlugin;
  readonly entry: Omit<PluginInventoryEntry, 'enabled'>;
}

function bundledEntry(plugin: ServicePlugin): Known {
  return {
    plugin,
    entry: {
      id: plugin.id,
      name: plugin.displayName,
      version: plugin.version,
      origin: 'bundled',
      replaces: null,
      path: null,
    },
  };
}

function pinnedEntry(
  pin: PinnedPlugin,
  replaced: ServicePlugin | undefined,
  origin: 'pinned' | 'installed' = 'pinned',
): Known {
  return {
    plugin: pin.plugin,
    entry: {
      id: pin.id,
      name: pin.plugin.displayName,
      version: pin.version,
      origin,
      replaces: replaced?.version ?? null,
      path: pin.path,
    },
  };
}

/**
 * Composes the bundled plugins, the pins and `plugins.enabled`. Throws a `ConfigError`
 * on two pins of one id (the loader refuses it first; checked again here since the
 * input may come from elsewhere) or an enabled id no plugin has.
 */
export function composePlugins(input: PluginSetInput): PluginSet {
  const pins = new Map<string, PinnedPlugin>();
  const duplicates: ConfigIssue[] = [];
  for (const pin of input.pinned) {
    const first = pins.get(pin.id);
    if (first) {
      duplicates.push({
        path: 'plugins.dir',
        env: envNamesFor('plugins.dir'),
        message: `${pin.path}: pins plugin '${pin.id}' again (also in ${first.path})`,
      });
    } else pins.set(pin.id, pin);
  }
  if (duplicates.length > 0) throw new ConfigError(duplicates);

  const installed = new Map<string, PinnedPlugin>();
  for (const version of input.installed ?? []) {
    if (!pins.has(version.id)) installed.set(version.id, version);
  }
  const bundledIds = new Set(input.bundled.map((plugin) => plugin.id));
  const added = [
    ...[...pins.values()].map((pin) => ({ pin, origin: 'pinned' as const })),
    ...[...installed.values()].map((pin) => ({ pin, origin: 'installed' as const })),
  ];
  const known: Known[] = [
    ...input.bundled.map((plugin) => {
      const pin = pins.get(plugin.id);
      if (pin) return pinnedEntry(pin, plugin);
      const version = installed.get(plugin.id);
      return version ? pinnedEntry(version, plugin, 'installed') : bundledEntry(plugin);
    }),
    ...added
      .filter(({ pin }) => !bundledIds.has(pin.id))
      .sort((a, b) => a.pin.id.localeCompare(b.pin.id))
      .map(({ pin, origin }) => pinnedEntry(pin, undefined, origin)),
  ];

  const enabled = input.enabled === null ? null : new Set(input.enabled);
  if (enabled !== null) {
    const ids = new Set(known.map((k) => k.entry.id));
    const unknown = [...enabled].filter((id) => !ids.has(id));
    if (unknown.length > 0) {
      throw new ConfigError([
        {
          path: 'plugins.enabled',
          env: envNamesFor('plugins.enabled'),
          message: `${unknown.map((id) => `'${id}'`).join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not a plugin of this instance (known: ${[...ids].join(', ') || 'none'})`,
        },
      ]);
    }
  }
  const isEnabled = (id: string): boolean => enabled === null || enabled.has(id);
  return {
    plugins: known.filter((k) => isEnabled(k.entry.id)).map((k) => k.plugin),
    inventory: known.map((k) => ({ ...k.entry, enabled: isEnabled(k.entry.id) })),
  };
}

/** The inventory of a registry built without the loader (tests, tools): every plugin bundled and enabled. */
export function bundledInventory(plugins: readonly ServicePlugin[]): PluginInventoryEntry[] {
  return plugins.map((plugin) => ({ ...bundledEntry(plugin).entry, enabled: true }));
}

/** A service the store holds accounts for that no registered plugin serves. */
export interface UnservedService {
  readonly service: string;
  readonly accounts: number;
  /** Known but left out of `plugins.enabled`, or known to no source at all. */
  readonly cause: 'disabled' | 'missing';
}

/** The services with accounts and no registered plugin, by service id. Pure. */
export function unservedServices(
  accountsByService: Readonly<Record<string, number>>,
  registered: ReadonlySet<string>,
  inventory: readonly PluginInventoryEntry[],
): UnservedService[] {
  const known = new Set(inventory.map((entry) => entry.id));
  return Object.entries(accountsByService)
    .filter(([service, accounts]) => accounts > 0 && !registered.has(service))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([service, accounts]) => ({
      service,
      accounts,
      cause: known.has(service) ? 'disabled' : 'missing',
    }));
}

/**
 * Stops the boot when the store holds accounts of a service no registered plugin
 * serves (ADR, "Fail closed at boot"): every page that names a service would otherwise
 * need a path for an unknown one. The operator enables or pins the plugin, or
 * disconnects the accounts on an instance that still serves them.
 */
export function checkAccountsServed(unserved: readonly UnservedService[]): void {
  if (unserved.length === 0) return;
  throw new ConfigError(
    unserved.map(({ service, accounts, cause }) => {
      const held = `the store holds ${accounts} ${accounts === 1 ? 'account' : 'accounts'} of '${service}'`;
      return cause === 'disabled'
        ? {
            path: 'plugins.enabled',
            env: envNamesFor('plugins.enabled'),
            message: `${held} and plugins.enabled leaves the plugin out: add '${service}', or disconnect those accounts first`,
          }
        : {
            path: 'plugins.dir',
            env: envNamesFor('plugins.dir'),
            message: `${held} and no plugin of this image or of the plugins directory serves it: pin the plugin '${service}', or run the former image and disconnect those accounts first`,
          };
    }),
  );
}
