/**
 * Plugins: the bundled ones of the image, the pins of `plugins.dir`, `plugins.enabled`
 * (ADR plugins-bundled-or-pinned-by-the-operator; handbook plugin-loading).
 *
 * `loadPlugins` is what the composition root runs at boot: read the pins, compose the
 * set, build the registry (the single service list), log what was pinned or left out.
 * The inventory it returns is `GatewayRoot.plugins`, what Administration › Plugins shows.
 */
import {
  createRegistry,
  SDK_VERSION,
  type PluginRegistry,
  type ServicePlugin,
} from '@vaubaan/plugin-sdk';

import type { InstanceConfig } from '../config';
import type { Logger } from '../logging';
import { composePlugins, type PluginInventoryEntry } from './inventory';
import { readPinnedPlugins, type PinReadOptions } from './loader';

export {
  bundledInventory,
  checkAccountsServed,
  composePlugins,
  unservedServices,
  type PluginInventoryEntry,
  type PluginOrigin,
  type PluginSet,
  type UnservedService,
} from './inventory';
export {
  BUNDLED_PLUGINS_DIR,
  connectFileUrl,
  readConnectFile,
  type ConnectFile,
  type ConnectFileSources,
} from './connect-files';
export {
  importEntryFile,
  PINNED_CATALOG_FILE,
  readPinManifest,
  readPinnedPlugins,
  SDK_PACKAGE,
  sdkInRange,
  type PinManifest,
  type PinnedPlugin,
} from './loader';

/** Every plugin the instance knows, as `GatewayRoot.plugins` exposes it. */
export interface PluginInventory {
  /** `plugins.dir`; `null` when the configuration sets none. */
  readonly dir: string | null;
  /** Bundled and pinned, registered or not, in registration order. */
  readonly entries: readonly PluginInventoryEntry[];
}

export interface LoadedPlugins {
  readonly registry: PluginRegistry;
  readonly inventory: PluginInventory;
}

export interface LoadPluginsOptions {
  /** The plugins the image bundles (`SHIPPED_PLUGINS`). */
  readonly bundled: readonly ServicePlugin[];
  /** Tests: another SDK version than this build's. */
  readonly sdkVersion?: string;
  /** Tests: a fake `import()`. */
  readonly importEntry?: PinReadOptions['importEntry'];
}

/**
 * Reads the pins, composes the set and builds the registry. Throws a `ConfigError`
 * (exit 78) for every refusal of the ADR's "fail closed at boot" that does not need the
 * store; the accounts check runs once the store is open (`checkAccountsServed`).
 */
export async function loadPlugins(
  config: Pick<InstanceConfig, 'plugins'>,
  logger: Logger,
  options: LoadPluginsOptions,
): Promise<LoadedPlugins> {
  const { dir, enabled } = config.plugins;
  const pinned =
    dir === null
      ? []
      : await readPinnedPlugins(dir, {
          sdkVersion: options.sdkVersion ?? SDK_VERSION,
          importEntry: options.importEntry,
        });
  const set = composePlugins({ bundled: options.bundled, pinned, enabled });
  const registry = createRegistry(set.plugins);
  logInventory(logger, set.inventory);
  return { registry, inventory: { dir, entries: set.inventory } };
}

/** One line per pin and one for the plugins left out: a pin is never silent (ADR). */
function logInventory(logger: Logger, inventory: readonly PluginInventoryEntry[]): void {
  for (const entry of inventory) {
    if (entry.origin !== 'pinned') continue;
    const replaces = entry.replaces === null ? '' : ` (replaces bundled ${entry.replaces})`;
    logger.info(`plugin ${entry.id} ${entry.version} pinned from ${entry.path}${replaces}`, {
      plugin: entry.id,
      version: entry.version,
      path: entry.path,
      replaces: entry.replaces,
      enabled: entry.enabled,
    });
  }
  const disabled = inventory.filter((entry) => !entry.enabled).map((entry) => entry.id);
  if (disabled.length > 0) {
    logger.info(`plugins not enabled by plugins.enabled: ${disabled.join(', ')}`, {
      disabled,
    });
  }
}
