/**
 * The plugins of the composition root: those of this start (the image's, the installed
 * versions, the operator's pins), the install service of Administration › Plugins with
 * what it reads late, the plugins installed at a start for the accounts that need them,
 * and the additions and swaps of the running instance. Called by `buildRoot` (`root.ts`).
 */
import { STARTUP_ACTOR_ID } from '@vaubaan/gateway-core';
import { catalogMarkOf } from '@vaubaan/shared';
import {
  createRegistry,
  SDK_VERSION,
  type PluginRegistry,
  type ServicePlugin,
} from '@vaubaan/plugin-sdk';

import type { InstanceConfig } from '../config';
import type { Logger } from '../logging';
import {
  bundledInventory,
  installedDirFor,
  loadInstalled,
  loadPlugins,
  type LoadedPlugins,
  type PinnedPlugin,
  type PluginInventory,
  type PluginInventoryEntry,
  type UnservedService,
} from '../plugins';
import type { PluginCallGate } from '../plugins/call-gate';
import {
  createPluginInstallService,
  type CatalogOffer,
  type LiveActivation,
  type PluginInstallService,
} from '../plugins/install-service';
import { fetchCatalogArchive, type KnownCatalogVersion } from '../plugins/catalog';
import { catalogVersionFloor } from '../plugins/catalog-floor';
import type { InstalledAdmission } from '../plugins/installed';
import { admissionProblem, trustOf } from '../plugins/trust';
import type { UpdatesComparison } from '../updates';
import type { MissionRecord, Store } from '../store';
import { systemClock } from '../store/clock';
import type { PluginVersionRecord } from '../store/repositories/plugin-versions';
import { startInstalledPlugins } from './installed-plugins';
import { checkBrokeredPlugins, checkHostToolNames, checkSelfResources } from './registry';
import { SHIPPED_PLUGINS } from './shipped-plugins';

/** The injection points of the plugins (`RootDeps` extends them). */
export interface PluginsDeps {
  /**
   * Replaces the plugin loading (tests: a fixture registry). The inventory then lists the
   * registry's plugins as bundled and enabled. Default: `loadPlugins` over the bundled
   * plugins and `plugins.*`.
   */
  readonly buildRegistry?: (config: InstanceConfig, logger: Logger) => Promise<PluginRegistry>;
  /** Downloads of the catalog's archives (one-click install); the global `fetch` by default. */
  readonly catalogFetch?: typeof fetch;
  /**
   * The catalog versions this release knows (`KNOWN_CATALOG_VERSIONS` by default): the floor
   * of an offer and the pins of an install. Tests pin the versions of their fixture archives.
   */
  readonly knownCatalogVersions?: ReadonlyMap<string, KnownCatalogVersion>;
  /**
   * The plugins compiled into the server (`SHIPPED_PLUGINS` by default). Tests choose theirs:
   * an instance without a plugin, to install it at a first connection.
   */
  readonly bundled?: readonly ServicePlugin[];
}

/**
 * What the install service reads from modules built after it: each is replaced by
 * `buildRoot` once its source exists, and read at call time, never captured.
 */
export interface PluginInstallLate {
  /** The notifications module is wired below; a signer is added once the root runs. */
  notifySignerAdded: (name: string) => void;
  /** The missions are read through the authority module, built with the modules below. */
  activeMissionsOf: (pluginId: string) => Promise<readonly { id: string; name: string }[]>;
  /** The versions check is built below; until its first read, the catalog's ids are unknown. */
  catalogIds: () => readonly string[];
  catalogVersions: () => readonly {
    id: string;
    released: string;
    name?: string;
  }[];
  /** The catalog's index of the last read (names, versions, digests); `{}` before it. */
  catalogPlugins: () => UpdatesComparison['catalog'];
}

/** The install service of Administration › Plugins and the `vaubaan` tools, over this start's plugins. */
export function wirePluginInstall(input: {
  readonly config: InstanceConfig;
  readonly logger: Logger;
  readonly store: Store;
  readonly registry: PluginRegistry;
  readonly inventory: PluginInventory;
  readonly installedDir: string | null;
  readonly callGate: PluginCallGate;
  readonly keptRiskIds: Set<string>;
  readonly bundled: readonly ServicePlugin[];
  readonly knownCatalogVersions: ReadonlyMap<string, KnownCatalogVersion>;
  readonly catalogFetch: typeof fetch | undefined;
  readonly late: PluginInstallLate;
}): PluginInstallService {
  const {
    config,
    logger,
    store,
    registry,
    inventory,
    installedDir,
    callGate,
    keptRiskIds,
    bundled,
    knownCatalogVersions,
    late,
  } = input;
  return createPluginInstallService({
    versions: store.pluginVersions,
    dir: installedDir,
    sdkVersion: SDK_VERSION,
    allowUnsigned: new Set(config.plugins.allowUnsigned),
    signers: store.pluginSigners,
    // The notifications module is wired below; a signer is added once the root runs.
    notifySignerAdded: (name) => late.notifySignerAdded(name),
    // At upload, the catalog's ids too (the last versions feed read): a private archive
    // never takes the id of a catalog plugin, even one this image does not ship. At a
    // start, only the image's (`installedAdmission`): a private plugin already installed
    // does not stop when the catalog later publishes its id.
    reservedIds: () => new Set([...reservedPluginIds(bundled), ...late.catalogIds()]),
    running: (pluginId) => {
      const registered = registry.get(pluginId);
      const entry = inventory.entries.find((e) => e.id === pluginId);
      if (!registered || !entry) return null;
      return {
        version: entry.version,
        origin: entry.origin,
        riskIds: registered.catalog.entries.map(({ entry }) => entry.id),
      };
    },
    providedOtherwise: (pluginId) =>
      bundled.some((plugin) => plugin.id === pluginId) ||
      inventory.entries.some((e) => e.id === pluginId && e.origin === 'pinned'),
    accountsOf: async (pluginId) => (await store.accounts.countByService())[pluginId] ?? 0,
    missionsOf: (pluginId) => late.activeMissionsOf(pluginId),
    // The versions feed's latest, else the version this release was tested with; and
    // never below the version this release knows (an unsigned feed must not roll back).
    catalogVersionOf: (pluginId) =>
      catalogVersionFloor(
        late.catalogVersions().find((available) => available.id === pluginId)?.released,
        knownCatalogVersions.get(pluginId),
      ),
    catalogOffer: (): readonly CatalogOffer[] => {
      const offered = new Map<string, string>();
      for (const p of late.catalogVersions()) {
        const version = catalogVersionFloor(p.released, knownCatalogVersions.get(p.id));
        if (version !== null) offered.set(p.id, version);
      }
      for (const [id, known] of knownCatalogVersions) {
        if (!offered.has(id)) offered.set(id, known.version);
      }
      return [...offered]
        .filter(([id]) => !registry.has(id))
        .map(([id, released]) => {
          const indexed = late.catalogPlugins()[id];
          const known = knownCatalogVersions.get(id);
          const name = indexed?.name ?? known?.name;
          // The index's mark, else the one this release knows (no index read, or an
          // archive built before archives carried their mark).
          const icon = indexed?.mark ?? (known ? catalogMarkOf(known) : null);
          return name === undefined ? { id, released, icon } : { id, released, name, icon };
        })
        .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
    },
    loadRefusal: (pluginId) =>
      config.plugins.enabled === null || config.plugins.enabled.includes(pluginId)
        ? null
        : `plugins.enabled does not list ${pluginId}: this instance runs only the plugins it names`,
    loadNow: (pin) => addPluginNow(config, registry, inventory.entries, pin),
    activateNow: async (version) =>
      activatePluginNow(version, {
        config,
        registry,
        entries: inventory.entries,
        dir: installedDir,
        gate: callGate,
        keptRiskIds,
        versions: store.pluginVersions,
        admit: await installedAdmission(config, store, bundled),
        logger,
      }),
    catalog: (pluginId, version) => {
      // The digest the index or this release gives for that very version, if any.
      const indexed = late.catalogPlugins()[pluginId];
      const known = knownCatalogVersions.get(pluginId);
      const sha256 =
        indexed?.version === version && indexed.sha256 !== undefined
          ? indexed.sha256
          : known?.version === version
            ? known.sha256
            : undefined;
      return fetchCatalogArchive(pluginId, version, {
        fetch: input.catalogFetch ?? fetch,
        ...(sha256 !== undefined ? { sha256 } : {}),
      });
    },
    audit: store.auditWriter,
    clock: systemClock,
    logger,
  });
}

/**
 * The ids only a Vaubaan signature may carry: the image's plugins. (The catalog's join them
 * once the instance reads the catalog's index.)
 */
function reservedPluginIds(bundled: readonly ServicePlugin[]): ReadonlySet<string> {
  return new Set(bundled.map((plugin) => plugin.id));
}

/** The admission rule of this start for installed versions (`trust.ts`), over the trusted signers now. */
async function installedAdmission(
  config: InstanceConfig,
  store: Store,
  bundled: readonly ServicePlugin[],
): Promise<InstalledAdmission> {
  const trustedKeys = (await store.pluginSigners.list()).map((signer) => ({
    name: signer.name,
    publicKeyPem: signer.publicKeyPem,
  }));
  const rules = {
    reservedIds: reservedPluginIds(bundled),
    allowUnsigned: new Set(config.plugins.allowUnsigned),
  };
  return (pluginId, files) =>
    admissionProblem(pluginId, trustOf(files, { trustedKeys }), rules)?.message ?? null;
}

/**
 * The plugins of this start: the image's, the installed versions the store marks
 * (`startInstalledPlugins`) and the operator's pins (`loadPlugins`); or an injected
 * registry alone.
 */
export async function buildPlugins(
  config: InstanceConfig,
  logger: Logger,
  store: Store,
  buildRegistry: PluginsDeps['buildRegistry'],
  bundled: readonly ServicePlugin[] = SHIPPED_PLUGINS,
): Promise<LoadedPlugins & { readonly installedDir: string | null }> {
  if (buildRegistry) {
    const registry = await buildRegistry(config, logger);
    return {
      registry,
      inventory: { dir: null, entries: bundledInventory(registry.all().map((r) => r.plugin)) },
      installedDir: installedDirFor(config.store.path),
    };
  }
  const installed = await startInstalledPlugins({
    config,
    store,
    admit: await installedAdmission(config, store, bundled),
    audit: store.auditWriter,
    clock: systemClock,
    logger,
    sdkVersion: SDK_VERSION,
  });
  const loaded = await loadPlugins(config, logger, {
    bundled,
    installed: installed.plugins,
  });
  return { ...loaded, installedDir: installed.dir };
}

/**
 * The active missions on an account of `service`, by name, for the activation page. The
 * stored status says `active` for an orphaned mission: each record is derived through the
 * mission grounds first (spec §2.3).
 */
export async function missionsOnService(
  store: Store,
  grounds: { derive(mission: MissionRecord): Promise<MissionRecord> },
  service: string,
): Promise<readonly { id: string; name: string }[]> {
  const byId = new Map<string, string>();
  for (const account of await store.accounts.list({ service })) {
    for (const stored of await store.missions.listForAccount(account.id)) {
      const mission = await grounds.derive(stored);
      if (mission.status === 'active') byId.set(mission.id, mission.name);
    }
  }
  return [...byId].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Adds a plugin to the running instance (ADR plugins-installed-when-first-needed): the
 * boot's own checks over the registry it would make, then the registry and the inventory
 * — one array every page, the versions check and the `vaubaan` plugin read. A plugin is
 * only ever added: an id the instance has is refused. `null` once added, or why not.
 */
function addPluginNow(
  config: InstanceConfig,
  registry: PluginRegistry,
  entries: readonly PluginInventoryEntry[],
  pin: PinnedPlugin,
): string | null {
  if (registry.has(pin.id)) return `${pin.id} is already registered`;
  try {
    const candidate = createRegistry([...registry.all().map((r) => r.plugin), pin.plugin]);
    checkSelfResources(config, candidate);
    checkBrokeredPlugins(candidate);
    checkHostToolNames(candidate);
    registry.register(pin.plugin);
  } catch (err) {
    return err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err);
  }
  (entries as PluginInventoryEntry[]).push({
    id: pin.id,
    name: pin.plugin.displayName,
    version: pin.version,
    origin: 'installed',
    replaces: null,
    enabled: true,
    path: pin.path,
    ...(pin.trust !== undefined ? { trust: pin.trust } : {}),
  });
  return null;
}

/**
 * Activates an installed version in the running instance (ADR
 * plugins-activated-by-an-administrator-on-trial, amendment 2026-11-19): its trial as a start
 * runs it (the folder against its manifest, its signature against today's signers, its own
 * examples), then the boot's checks over the registry it would make, then the swap, once no
 * call of the service runs (`PluginCallGate`). A plugin the image or a pin serves, safe mode
 * and an instance without a data directory keep the trial for the next start.
 */
async function activatePluginNow(
  version: PluginVersionRecord,
  input: {
    readonly config: InstanceConfig;
    readonly registry: PluginRegistry;
    readonly entries: readonly PluginInventoryEntry[];
    readonly dir: string | null;
    readonly gate: PluginCallGate;
    readonly keptRiskIds: Set<string>;
    readonly versions: Store['pluginVersions'];
    readonly admit: InstalledAdmission;
    readonly logger: Logger;
  },
): Promise<LiveActivation> {
  const { config, registry, dir } = input;
  const id = version.pluginId;
  if (dir === null || config.plugins.safeMode) return { kind: 'next-start' };
  if (config.plugins.enabled !== null && !config.plugins.enabled.includes(id)) {
    return { kind: 'next-start' };
  }
  const entry = input.entries.find((e) => e.id === id);
  if (entry !== undefined && entry.origin !== 'installed') return { kind: 'next-start' };
  const loaded = await loadInstalled(
    dir,
    [
      {
        digest: version.digest,
        pluginId: id,
        version: version.version,
        state: 'trial',
        trust: version.trust,
      },
    ],
    { sdkVersion: SDK_VERSION, logger: input.logger, admit: input.admit },
  );
  const outcome = loaded.outcomes[0];
  const pin = loaded.plugins[0];
  if (outcome?.outcome === 'failed') return { kind: 'failed', failure: outcome.failure };
  if (pin === undefined) return { kind: 'failed', failure: 'the version did not load' };
  const replaced =
    (await input.versions.list()).find((v) => v.pluginId === id && v.state === 'active')?.digest ??
    null;
  const previous = registry.get(id);
  if (previous === undefined) {
    const refused = addPluginNow(config, registry, input.entries, pin);
    return refused === null
      ? { kind: 'activated', replaced }
      : { kind: 'failed', failure: refused };
  }
  try {
    const candidate = createRegistry(
      registry.all().map((r) => (r.plugin.id === id ? pin.plugin : r.plugin)),
    );
    checkSelfResources(config, candidate);
    checkBrokeredPlugins(candidate);
    checkHostToolNames(candidate);
  } catch (err) {
    return {
      kind: 'failed',
      failure: err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err),
    };
  }
  try {
    await input.gate.swap(id, () => {
      registry.replace(pin.plugin);
      for (const { entry: risk } of previous.catalog.entries) input.keptRiskIds.add(risk.id);
      const entries = input.entries as PluginInventoryEntry[];
      const at = entries.findIndex((e) => e.id === id);
      const next: PluginInventoryEntry = {
        id,
        name: pin.plugin.displayName,
        version: pin.version,
        origin: 'installed',
        replaces: entries[at]?.replaces ?? null,
        enabled: true,
        path: pin.path,
        ...(pin.trust !== undefined ? { trust: pin.trust } : {}),
      };
      if (at === -1) entries.push(next);
      else entries[at] = next;
    });
  } catch (err) {
    return { kind: 'failed', failure: err instanceof Error ? err.message : String(err) };
  }
  input.logger.info(`plugin ${id} ${version.version} activated without a restart`, {
    plugin: id,
    version: version.version,
    replaced,
  });
  return { kind: 'activated', replaced };
}

/**
 * Installs, from the catalog, each plugin the store holds accounts for and no registered
 * plugin serves, at the version the versions feed or this release names; audited as the
 * start. A plugin the configuration disables is left to `checkAccountsServed`.
 */
export async function restoreNeededPlugins(
  install: PluginInstallService,
  unserved: readonly UnservedService[],
  logger: Logger,
): Promise<void> {
  for (const { service, cause } of unserved) {
    if (cause !== 'missing') continue;
    const result = await install.installForConnection(service, { userId: STARTUP_ACTOR_ID });
    if (result.ok) {
      logger.info(`plugin ${service} installed from the catalog: accounts of it exist`, {
        plugin: service,
        version: result.installed?.version,
      });
    } else {
      logger.error(`plugin ${service} could not be installed from the catalog`, {
        plugin: service,
        code: result.code,
        problem: result.message,
      });
    }
  }
}
