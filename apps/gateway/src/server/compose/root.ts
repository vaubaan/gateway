/**
 * Composition root — built ONCE per process (plan §3.1), reached from every
 * consumer (route handlers, server components, `instrumentation.ts`) through
 * `getRoot()`.
 *
 * Why `globalThis`: Next.js bundles each route and the instrumentation file
 * into separate module graphs, and `next dev` re-evaluates modules on HMR, so
 * a module-level singleton can be instantiated several times in one process.
 * A promise cached on `globalThis` is the one handle every graph shares
 * (ADR docker-image-and-config-format).
 *
 * The order of construction lives here; the wiring of each part lives beside it:
 * the boot's own checks and lines (`boot-checks.ts`), the plugins and their install
 * service (`wire-plugins.ts`), the feature modules (`wire-modules.ts`).
 *
 * This file never imports `next`; the root is host-agnostic so a hosted
 * deployment can build the same root from another HTTP host.
 */
import type { PluginRegistry } from '@vaubaan/plugin-sdk';

import {
  buildInfoFromEnv,
  type BuildInfo,
  type InstanceConfig,
  type LoadedConfig,
  secretValues,
} from '../config';
import { createEncryptor, type Encryptor } from '../crypto';
import { publishLocalMode } from '../http/local-mode';
import { publishHttps } from '../http/security-headers';
import { createLogger, createRedactor, type Logger, type LoggerOptions } from '../logging';
import { checkAccountsServed, unservedServices, type PluginInventory } from '../plugins';
import { createPluginCallGate, type PluginCallGate } from '../plugins/call-gate';
import { createPluginHandlers, type PluginHandlers } from '../plugins/handlers';
import type { PluginInstallService } from '../plugins/install-service';
import { CATALOG_INDEX_URL, KNOWN_CATALOG_VERSIONS } from '../plugins/catalog';
import {
  createUpdatesHandlers,
  createUpdatesModule,
  type UpdatesHandlers,
  type UpdatesModule,
  type UpdatesTimers,
} from '../updates';
import type { Store } from '../store';
import { systemClock } from '../store/clock';
import {
  checkSealedKeys,
  logConfigurationSummary,
  logRetiredKeys,
  warnKeyBesideStore,
} from './boot-checks';
import type { MountFacts } from './key-placement';
import {
  checkBrokeredPlugins,
  checkHostToolNames,
  checkSelfResources,
  DeferredCatalogIndex,
  KeptCatalogIndex,
  RegistryCatalogIndex,
} from './registry';
import { clearSetup, currentSetup, SetupModeError } from '../setup/state';
import { loadBootConfig } from './boot-config';
import { SHIPPED_PLUGINS } from './shipped-plugins';
import { openEmbeddedStore, type StoreContext } from './store';
import { wireModules, type Closer, type ModulesDeps, type RootModules } from './wire-modules';
import {
  buildPlugins,
  missionsOnService,
  restoreNeededPlugins,
  wirePluginInstall,
  type PluginInstallLate,
  type PluginsDeps,
} from './wire-plugins';

export interface GatewayRoot extends RootModules {
  readonly config: InstanceConfig;
  /** YAML file merged in, or `null` for environment-only configuration. */
  readonly configFile: string | null;
  readonly logger: Logger;
  readonly encryptor: Encryptor;
  /** The embedded store with its repositories; satisfies `StoreLiveness` of `ports.ts`. */
  readonly store: Store;
  /**
   * The single service list: the plugins the image bundles (`shipped-plugins.ts`), a pin
   * of `plugins.dir` replacing the bundled plugin of its id, filtered by `plugins.enabled`.
   */
  readonly registry: PluginRegistry;
  /** Every plugin the instance knows, bundled or pinned, registered or not (Administration › Plugins). */
  readonly plugins: PluginInventory;
  /**
   * The versions check: what the published feed says is behind, in memory (`updates.*`),
   * and "Check now" of Administration › Plugins.
   */
  readonly updates: UpdatesModule & { readonly handlers: UpdatesHandlers };
  /** Installing plugins from Administration › Plugins and the `vaubaan` tools (ADR plugins-activated-by-an-administrator-on-trial). */
  readonly pluginInstall: {
    readonly service: PluginInstallService;
    readonly handlers: PluginHandlers;
    /** `<data dir>/plugins`; `null` for a store in memory. */
    readonly dir: string | null;
    /** Holds each call's service against a swap of its plugin's version (`plugins/call-gate.ts`). */
    readonly calls: PluginCallGate;
  };
  readonly build: BuildInfo;
  readonly startedAt: Date;
  close(): Promise<void>;
}

export type { BuildInfo };

/**
 * Injection points. The defaults are the production wiring (SQLite store at
 * `store.path`, the plugins the image ships); tests inject the `:memory:`
 * store, a fixture registry or fakes of the in-memory ports. Those of the plugins
 * and of the modules are declared beside their wiring (`wire-plugins.ts`,
 * `wire-modules.ts`).
 */
export interface RootDeps extends PluginsDeps, ModulesDeps {
  readonly loadConfig?: () => LoadedConfig;
  readonly openStore?: (ctx: StoreContext) => Promise<Store>;
  /** Outbound HTTP of the versions check (tests inject a fake; default: the global `fetch`). */
  readonly updatesFetch?: typeof fetch;
  /**
   * Where the versions check reads the catalog's index (`CATALOG_INDEX_URL` by default);
   * `null` reads none, the versions feed then names the plugins (tests).
   */
  readonly catalogIndexUrl?: URL | null;
  /** The versions check's timers (tests drive them by hand). */
  readonly updatesTimers?: UpdatesTimers;
  /** Ends the process for its supervisor to restart it; default: exit 75 once the root closed. */
  readonly requestRestart?: (close: () => Promise<void>) => void;
  readonly logWrite?: LoggerOptions['write'];
  readonly build?: BuildInfo;
  /** Where the key file and the store sit (tests inject mounts of their own). */
  readonly mountFacts?: MountFacts;
}

export async function buildRoot(deps: RootDeps = {}): Promise<GatewayRoot> {
  const { config, configFile, masterKeyGenerated } = (deps.loadConfig ?? loadBootConfig)();
  const logger = createLogger({
    level: config.log.level,
    redact: createRedactor(secretValues(config)),
    write: deps.logWrite,
  }).child({ component: 'gateway' });
  const build = deps.build ?? buildInfoFromEnv();
  logConfigurationSummary(logger, config, configFile);
  if (masterKeyGenerated) {
    // The path of the file, never its content.
    const keyFilePath = config.encryption.masterKeyFile;
    logger.info('master key generated at the first start: the setup hands it over', {
      path: keyFilePath,
      key_version: config.encryption.keyVersion,
    });
  }
  warnKeyBesideStore(logger, config, deps.mountFacts);
  // The proxy sends HSTS when the public URL is https (`server/http/security-headers.ts`).
  publishHttps(config.publicUrl.protocol === 'https:');
  publishLocalMode(config.local);

  const encryptor = await createEncryptor(config.encryption);

  logRetiredKeys(config, logger);
  // The store opens before the plugins: the installed versions are read from it (ADR
  // plugins-activated-by-an-administrator-on-trial). It checks every persisted RiskId
  // against the loaded catalogs, through an index filled once they are loaded; nothing
  // writes before that.
  const catalog = new DeferredCatalogIndex();
  const store = await (deps.openStore ?? openEmbeddedStore)({ config, logger, encryptor, catalog });

  // Everything opened from here on is registered as it opens (the store
  // handle, then each timer), so a late failure closes it: `getRoot` retries
  // a failed build, and a retry must not find a second handle on the same file.
  const opened: Closer[] = [() => store.close()];
  const bundled = deps.bundled ?? SHIPPED_PLUGINS;
  const knownCatalogVersions = deps.knownCatalogVersions ?? KNOWN_CATALOG_VERSIONS;
  try {
    const { registry, inventory, installedDir } = await buildPlugins(
      config,
      logger,
      store,
      deps.buildRegistry,
      bundled,
    );
    checkSelfResources(config, registry);
    checkBrokeredPlugins(registry);
    checkHostToolNames(registry);
    // Grows when a version is swapped in while the instance runs: the replaced version's
    // permissions stay known, as a start would read them from the kept versions.
    const keptRiskIds = new Set(await store.pluginVersions.keptRiskIds());
    catalog.fill(new KeptCatalogIndex(new RegistryCatalogIndex(registry), keptRiskIds));
    const callGate = createPluginCallGate();
    // Each read at call time, replaced below once its source is built (`PluginInstallLate`).
    const late: PluginInstallLate = {
      notifySignerAdded: () => undefined,
      activeMissionsOf: async () => [],
      catalogIds: () => [],
      catalogVersions: () => [],
      catalogPlugins: () => ({}),
    };
    const pluginInstall = wirePluginInstall({
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
      catalogFetch: deps.catalogFetch,
      late,
    });
    // A plugin the accounts need and no image carries (ADR plugins-installed-when-first-needed):
    // installed from the catalog before anything reads the accounts — an upgrade from an
    // image that compiled it, or a store restored elsewhere. What cannot be installed stops
    // the boot below, naming it.
    await restoreNeededPlugins(
      pluginInstall,
      unservedServices(
        await store.accounts.countByService(),
        new Set(registry.ids),
        inventory.entries,
      ),
      logger,
    );
    // Accounts of a service no registered plugin serves stop the boot (ADR
    // plugins-bundled-or-pinned-by-the-operator): a plugin disabled, or one not installed.
    checkAccountsServed(
      unservedServices(
        await store.accounts.countByService(),
        new Set(registry.ids),
        inventory.entries,
      ),
    );
    await checkSealedKeys(store, config, logger);
    const modules = await wireModules(
      {
        config,
        logger,
        registry,
        store,
        build,
        masterKeyGenerated,
        encryptor,
        pluginEntries: inventory.entries,
        pluginInstall,
        callGate,
      },
      deps,
      opened,
    );
    late.notifySignerAdded = (name) => modules.notifications.events.pluginSignerAdded(name);
    late.activeMissionsOf = (pluginId) =>
      missionsOnService(store, modules.authority.grounds, pluginId);
    // Nothing about the instance leaves with the request; off unless `updates.check`.
    const updates = createUpdatesModule({
      config: config.updates,
      gatewayVersion: build.version,
      inventory: inventory.entries,
      logger,
      ...(deps.catalogIndexUrl === null
        ? {}
        : { indexUrl: deps.catalogIndexUrl ?? CATALOG_INDEX_URL }),
      fetch: deps.updatesFetch,
      timers: deps.updatesTimers,
    });
    opened.push(() => updates.stop());
    late.catalogIds = () => updates.current()?.catalogIds ?? [];
    late.catalogVersions = () => updates.current()?.pluginsAvailable ?? [];
    late.catalogPlugins = () => updates.current()?.catalog ?? {};
    updates.start();
    const closeRoot = () => closeAll(opened);
    const requestRestart = deps.requestRestart ?? defaultRestart;
    const root: GatewayRoot = {
      config,
      configFile,
      logger,
      encryptor,
      store,
      registry,
      plugins: inventory,
      updates: {
        ...updates,
        handlers: createUpdatesHandlers({
          publicUrl: config.publicUrl,
          authenticator: modules.auth.authenticator,
          updates,
        }),
      },
      pluginInstall: {
        service: pluginInstall,
        dir: installedDir,
        calls: callGate,
        handlers: createPluginHandlers({
          publicUrl: config.publicUrl,
          authenticator: modules.auth.authenticator,
          install: pluginInstall,
          logger,
          audit: store.auditWriter,
          clock: systemClock,
          requestRestart: () => requestRestart(closeRoot),
        }),
      },
      ...modules,
      build,
      startedAt: new Date(),
      close: closeRoot,
    };
    logger.info('composition root ready', {
      store: store.kind,
      schema_version: store.schemaVersion,
      plugins: registry.ids,
      build,
    });
    return root;
  } catch (err) {
    await closeAfterFailedBuild(opened, logger);
    throw err;
  }
}

/**
 * Exit code 75 (EX_TEMPFAIL) once the root closed: a supervisor that restarts on failure
 * (`restart: unless-stopped`, Railway's on-failure) starts the instance again, which
 * loads the versions marked for a trial (deploy/README.md).
 */
function defaultRestart(close: () => Promise<void>): void {
  void close().finally(() => process.exit(75));
}

/**
 * Releases what was opened, last opened first (timers, then the store they
 * write to). Every closer runs even when one fails; the first failure is
 * rethrown once all have run.
 */
async function closeAll(opened: readonly Closer[]): Promise<void> {
  let failure: { readonly error: unknown } | null = null;
  for (const close of [...opened].reverse()) {
    try {
      await close();
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}

/** Same release after a build that threw: the build error is the one the caller sees. */
async function closeAfterFailedBuild(opened: readonly Closer[], logger: Logger): Promise<void> {
  try {
    await closeAll(opened);
  } catch (err) {
    logger.error('could not release everything a failed build had opened', { err });
  }
}

/* ------------------------------------------------------------------------ */
/* Process-wide handle                                                       */
/* ------------------------------------------------------------------------ */

// single-process only — the handle is per process by design: every replica of
// a hosted deployment builds its own root from the same configuration, so no
// shared replacement is needed.
const GLOBAL_KEY = Symbol.for('vaubaan.gateway.root');

type GlobalWithRoot = typeof globalThis & { [GLOBAL_KEY]?: Promise<GatewayRoot> };

/**
 * The process-wide root. The first caller builds it (with its `deps`);
 * concurrent and later callers share the same promise and their `deps` are
 * not consulted. A failed build is forgotten so the next call retries (the
 * boot path exits the process on failure anyway).
 */
export function getRoot(deps?: RootDeps): Promise<GatewayRoot> {
  const g = globalThis as GlobalWithRoot;
  if (!g[GLOBAL_KEY]) {
    // In setup mode there is no configuration to build from (the environment is
    // scrubbed): only the setup's own completion, with its loader, builds the root.
    if (currentSetup() && !deps?.loadConfig) return Promise.reject(new SetupModeError());
    const pending = buildRoot(deps);
    g[GLOBAL_KEY] = pending;
    pending.catch(() => {
      if (g[GLOBAL_KEY] === pending) delete g[GLOBAL_KEY];
    });
  }
  return g[GLOBAL_KEY];
}

/** Whether a root is being built or built in this process (the demo builds it before the server starts). */
export function rootStarted(): boolean {
  return (globalThis as GlobalWithRoot)[GLOBAL_KEY] !== undefined;
}

/** Closes and forgets the process-wide root. Tests only. */
export async function resetRoot(): Promise<void> {
  const g = globalThis as GlobalWithRoot;
  const pending = g[GLOBAL_KEY];
  delete g[GLOBAL_KEY];
  clearSetup();
  if (pending) {
    try {
      await (await pending).close();
    } catch {
      // a root that failed to build has nothing to close
    }
  }
}
