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
 * This file never imports `next`; the root is host-agnostic so a hosted
 * deployment can build the same root from another HTTP host.
 */
import { MemoryCacheClient, STARTUP_ACTOR_ID } from '@vaubaan/gateway-core';
import {
  createRegistry,
  SDK_VERSION,
  type PluginRegistry,
  type ServicePlugin,
} from '@vaubaan/plugin-sdk';

import { createAuditModule, type AuditModule } from '../audit';
import { createBackupModule, type BackupService, type BackupTimers } from '../backup';
import { createAuthModule, type AuthModule, type LinkMailer, type OidcOptions } from '../auth';
import { upgradeSingleSignInProviderSettings } from '../auth/single-sign-in-provider-upgrade';
import { createLinkMailer } from '../mail';
import { createAuthorityModule, type AuthorityModule } from '../authority';
import { SessionService } from '../budget';
import { createAccountsModule, type AccountsModule, type RefreshTimers } from '../accounts';
import {
  buildInfoFromEnv,
  ConfigError,
  type BuildInfo,
  type InstanceConfig,
  type LoadedConfig,
  secretValues,
} from '../config';
import { createEncryptor, type Encryptor } from '../crypto';
import { createExecutionModule, type ExecutionModule } from '../execution';
import { createGitModule, type GitModule } from '../git';
import { createGroupsModule, type GroupsModule } from '../groups';
import { createInstanceModule, type InstanceModule } from '../instance';
import { collectOpsStats, createInstanceLimits, type InstanceLimits } from '../limits';
import { createMasterKeyModule, type MasterKeyModule } from '../master-key';
import type { OpsStatsDeps } from '../http/ops-stats';
import type { Resolver } from '../http/public-address';
import { publishLocalMode } from '../http/local-mode';
import { publishHttps } from '../http/security-headers';
import { createLogger, createRedactor, type Logger, type LoggerOptions } from '../logging';
import { createMissionsModule, type MissionsModule } from '../missions';
import {
  createNotificationsModule,
  type NotificationsModule,
  type PushTransport,
} from '../notifications';
import { toolTitleOf } from '../services/tool-titles';
import {
  bundledInventory,
  checkAccountsServed,
  installedDirFor,
  loadInstalled,
  loadPlugins,
  unservedServices,
  type LoadedPlugins,
  type PinnedPlugin,
  type PluginInventory,
  type PluginInventoryEntry,
  type UnservedService,
} from '../plugins';
import { createRequestsModule, type RequestsModule } from '../requests';
import { SlidingWindowRateLimiter } from '../rate-limit';
import { createSharesModule, type SharesModule } from '../shares';
import { createUsersModule, type UsersModule } from '../users';
import { createTelemetryModule, type TelemetryModule } from '../telemetry';
import {
  createUpdatesHandlers,
  createUpdatesModule,
  type UpdatesHandlers,
  type UpdatesComparison,
  type UpdatesModule,
  type UpdatesTimers,
} from '../updates';
import type { MissionRecord, Store } from '../store';
import { systemClock, type Clock } from '../store/clock';
import type { CacheClient, RateLimiter, SessionStore } from './ports';
import {
  checkBrokeredPlugins,
  checkHostToolNames,
  checkSelfResources,
  DeferredCatalogIndex,
  KeptCatalogIndex,
  RegistryCatalogIndex,
} from './registry';
import { startInstalledPlugins } from './installed-plugins';
import { createPluginCallGate, type PluginCallGate } from '../plugins/call-gate';
import type { LiveActivation } from '../plugins/install-service';
import type { PluginVersionRecord } from '../store/repositories/plugin-versions';
import type { InstalledAdmission } from '../plugins/installed';
import { admissionProblem, trustOf } from '../plugins/trust';
import { createPluginHandlers, type PluginHandlers } from '../plugins/handlers';
import { createPluginInstallService, type PluginInstallService } from '../plugins/install-service';
import { CATALOG_INDEX_URL, fetchCatalogArchive, KNOWN_CATALOG_VERSIONS } from '../plugins/catalog';
import { catalogVersionFloor } from '../plugins/catalog-floor';
import {
  KEY_BESIDE_STORE_WARNING,
  keyBesideStore,
  PROCESS_MOUNT_FACTS,
  type MountFacts,
} from './key-placement';
import { vaubaanPluginsOf, wireVaubaanPlugin, type VaubaanPluginModule } from './vaubaan';
import { clearSetup, currentSetup, SetupModeError } from '../setup/state';
import { loadBootConfig } from './boot-config';
import { SHIPPED_PLUGINS } from './shipped-plugins';
import { openEmbeddedStore, type StoreContext } from './store';

export interface GatewayRoot {
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
  readonly rateLimiter: RateLimiter;
  readonly cache: CacheClient;
  readonly sessions: SessionStore;
  /** Human authentication: OIDC relying party, web sessions, bootstrap, admin rule. */
  readonly auth: AuthModule;
  /** Connect flows, resources, credential broker with the generic OAuth refresh. */
  readonly accounts: AccountsModule;
  /** Authority: owner or union of shares, mission grounds (`orphaned`, derived), membership settlement. */
  readonly authority: AuthorityModule;
  /** Shares of an account to a user or a group, and the shares a user received. */
  readonly shares: SharesModule;
  /** Local groups kept by the operator. */
  readonly groups: GroupsModule;
  /** Missions: authority, preview / issue / rotate / revoke, bootstrap kit. */
  readonly missions: MissionsModule;
  /** Requests to the creator: inbox, claim decisions, expiry sweeper, request URL. */
  readonly requests: RequestsModule;
  /** Audit search, mission session view, retention sweeper. */
  readonly audit: AuditModule;
  /** Budget: the session service deciding and counting every allowed call. */
  readonly budget: SessionService;
  /** The execution MCP door: `/mcp`, `/mcp/catalog`, the call pipeline. */
  readonly execution: ExecutionModule;
  /** The git remote: `/git/**`, the second door of the execution surface (spec §4.1 ter). */
  readonly git: GitModule;
  /** Community telemetry: the pipeline's sink, the operator's toggle, the validation status. */
  readonly telemetry: TelemetryModule;
  /** How the interface names this instance: the configuration's name, else the administrator's. */
  readonly instance: InstanceModule;
  /** The master key: generated here or not, handed over or not, downloadable by an operator. */
  readonly masterKey: MasterKeyModule;
  /** The scheduled, encrypted, self-checked backup to object storage (off unless configured). */
  readonly backup: BackupService;
  /** Administration → Users: the operator's deactivation and reactivation of a user. */
  readonly users: UsersModule;
  /** A person's channels (devices, addresses, mail), the events that notify them, the transports. */
  readonly notifications: NotificationsModule;
  /** The `vaubaan` plugin's ports and the `execute` the door runs for it (`compose/vaubaan.ts`). */
  readonly vaubaan: VaubaanPluginModule;
  /** The ceilings of the configuration over the counts of the store (spec §4.3 bis). */
  readonly limits: InstanceLimits;
  /** What `GET /ops/stats` answers with: the token that opens it and its counts. */
  readonly opsStats: OpsStatsDeps;
  readonly build: BuildInfo;
  readonly startedAt: Date;
  close(): Promise<void>;
}

export type { BuildInfo };

/**
 * Injection points. The defaults are the production wiring (SQLite store at
 * `store.path`, the plugins the image ships); tests inject the `:memory:`
 * store, a fixture registry or fakes of the in-memory ports.
 */
export interface RootDeps {
  readonly loadConfig?: () => LoadedConfig;
  readonly openStore?: (ctx: StoreContext) => Promise<Store>;
  /** Tests: the clock of the authentication module (link expiry, lockouts); the system clock otherwise. */
  readonly clock?: Clock;
  /** Sends the mails of the sign-in accounts' links; built from `mail.*` by the boot (wave C). */
  readonly mailer?: LinkMailer;
  /**
   * Replaces the plugin loading (tests: a fixture registry). The inventory then lists the
   * registry's plugins as bundled and enabled. Default: `loadPlugins` over the bundled
   * plugins and `plugins.*`.
   */
  readonly buildRegistry?: (config: InstanceConfig, logger: Logger) => Promise<PluginRegistry>;
  readonly rateLimiter?: RateLimiter;
  readonly cache?: CacheClient;
  readonly sessions?: SessionStore;
  /** Outbound HTTP and issuer rules of the OIDC relying party (tests inject an in-process IdP). */
  readonly oidc?: OidcOptions;
  /** Outbound HTTP of the connect flows and of plugin discovery (tests inject a mock service). */
  readonly serviceFetch?: typeof fetch;
  /** Outbound HTTP to the telemetry collector (tests assert on it; default: the global `fetch`). */
  readonly telemetryFetch?: typeof fetch;
  /** Outbound HTTP to the backup's object storage (tests inject an in-process fake). */
  readonly backupFetch?: typeof fetch;
  /** The scheduled backup's timers (tests drive them by hand). */
  readonly backupTimers?: BackupTimers;
  /** Outbound HTTP of the versions check (tests inject a fake; default: the global `fetch`). */
  readonly updatesFetch?: typeof fetch;
  /** Downloads of the catalog's archives (one-click install); the global `fetch` by default. */
  readonly catalogFetch?: typeof fetch;
  /**
   * Where the versions check reads the catalog's index (`CATALOG_INDEX_URL` by default);
   * `null` reads none, the versions feed then names the plugins (tests).
   */
  readonly catalogIndexUrl?: URL | null;
  /**
   * The plugins compiled into the server (`SHIPPED_PLUGINS` by default). Tests choose theirs:
   * an instance without a plugin, to install it at a first connection.
   */
  readonly bundled?: readonly ServicePlugin[];
  /** The versions check's timers (tests drive them by hand). */
  readonly updatesTimers?: UpdatesTimers;
  /** Ends the process for its supervisor to restart it; default: exit 75 once the root closed. */
  readonly requestRestart?: (close: () => Promise<void>) => void;
  /** The automatic refresh's timers (tests drive them by hand). */
  readonly refreshTimers?: RefreshTimers;
  /** Outbound HTTP to the browsers' push services (tests inject a fake; default: `fetch`). */
  readonly notificationFetch?: typeof fetch;
  /** Replaces the web push transport (tests assert on what would leave). */
  readonly notificationTransport?: PushTransport;
  /** Name resolution of the messaging addresses whose host is free (tests: no network). */
  readonly notificationResolve?: Resolver;
  /**
   * The mail transport of mail notifications only (the e2e instance: a recording fake, while
   * the sign-in accounts keep handing their links to the administrator). Default: `mailer`.
   */
  readonly notificationMailer?: LinkMailer;
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
    let notifySignerAdded: (name: string) => void = () => undefined;
    // The missions are read through the authority module, built with the modules below.
    let activeMissionsOf: (
      pluginId: string,
    ) => Promise<readonly { id: string; name: string }[]> = async () => [];
    // The versions check is built below; until its first read, the catalog's ids are unknown.
    let catalogIds: () => readonly string[] = () => [];
    let catalogVersions: () => readonly {
      id: string;
      released: string;
      name?: string;
    }[] = () => [];
    // The catalog's index of the last read (names, versions, digests); `{}` before it.
    let catalogPlugins: () => UpdatesComparison['catalog'] = () => ({});
    const pluginInstall = createPluginInstallService({
      versions: store.pluginVersions,
      dir: installedDir,
      sdkVersion: SDK_VERSION,
      allowUnsigned: new Set(config.plugins.allowUnsigned),
      signers: store.pluginSigners,
      // The notifications module is wired below; a signer is added once the root runs.
      notifySignerAdded: (name) => notifySignerAdded(name),
      // At upload, the catalog's ids too (the last versions feed read): a private archive
      // never takes the id of a catalog plugin, even one this image does not ship. At a
      // start, only the image's (`installedAdmission`): a private plugin already installed
      // does not stop when the catalog later publishes its id.
      reservedIds: () => new Set([...reservedPluginIds(bundled), ...catalogIds()]),
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
      missionsOf: (pluginId) => activeMissionsOf(pluginId),
      // The versions feed's latest, else the version this release was tested with; and
      // never below the version this release knows (an unsigned feed must not roll back).
      catalogVersionOf: (pluginId) =>
        catalogVersionFloor(
          catalogVersions().find((available) => available.id === pluginId)?.released,
          KNOWN_CATALOG_VERSIONS.get(pluginId),
        ),
      catalogOffer: (): readonly { id: string; released: string; name?: string }[] => {
        const offered = new Map<string, string>();
        for (const p of catalogVersions()) {
          const version = catalogVersionFloor(p.released, KNOWN_CATALOG_VERSIONS.get(p.id));
          if (version !== null) offered.set(p.id, version);
        }
        for (const [id, known] of KNOWN_CATALOG_VERSIONS) {
          if (!offered.has(id)) offered.set(id, known.version);
        }
        return [...offered]
          .filter(([id]) => !registry.has(id))
          .map(([id, released]) => {
            const name = catalogPlugins()[id]?.name ?? KNOWN_CATALOG_VERSIONS.get(id)?.name;
            return name === undefined ? { id, released } : { id, released, name };
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
        const indexed = catalogPlugins()[pluginId];
        const known = KNOWN_CATALOG_VERSIONS.get(pluginId);
        const sha256 =
          indexed?.version === version && indexed.sha256 !== undefined
            ? indexed.sha256
            : known?.version === version
              ? known.sha256
              : undefined;
        return fetchCatalogArchive(pluginId, version, {
          fetch: deps.catalogFetch ?? fetch,
          ...(sha256 !== undefined ? { sha256 } : {}),
        });
      },
      audit: store.auditWriter,
      clock: systemClock,
      logger,
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
    notifySignerAdded = (name) => modules.notifications.events.pluginSignerAdded(name);
    activeMissionsOf = (pluginId) => missionsOnService(store, modules.authority.grounds, pluginId);
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
    catalogIds = () => updates.current()?.catalogIds ?? [];
    catalogVersions = () => updates.current()?.pluginsAvailable ?? [];
    catalogPlugins = () => updates.current()?.catalog ?? {};
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
 * Exit code 75 (EX_TEMPFAIL) once the root closed: a supervisor that restarts on failure
 * (`restart: unless-stopped`, Railway's on-failure) starts the instance again, which
 * loads the versions marked for a trial (deploy/README.md).
 */
function defaultRestart(close: () => Promise<void>): void {
  void close().finally(() => process.exit(75));
}

/**
 * The plugins of this start: the image's, the installed versions the store marks
 * (`startInstalledPlugins`) and the operator's pins (`loadPlugins`); or an injected
 * registry alone.
 */
async function buildPlugins(
  config: InstanceConfig,
  logger: Logger,
  store: Store,
  buildRegistry: RootDeps['buildRegistry'],
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
 * Whether the configured master keys open what the store holds: one blob per table and
 * key version is opened at boot. A version with no configured key, or whose key does
 * not fit (a new key set without raising its version), is logged at `error`, once per
 * version, naming the keys to fix. The instance still starts: what it cannot open fails
 * call by call, and the operator needs the instance up to see it (ADR
 * master-key-rotation-reseals-every-blob, amendment).
 */
export const SEALED_KEY_MISMATCH =
  'stored secrets do not open with the configured master keys: fix VAUBAAN_MASTER_KEY / VAUBAAN_MASTER_KEY_VERSION / VAUBAAN_MASTER_KEY_PREVIOUS and redeploy';

async function checkSealedKeys(
  store: Store,
  config: InstanceConfig,
  logger: Logger,
): Promise<void> {
  const failing = (await store.sealedBlobs.probe()).filter((p) => !p.opens);
  const versions = [...new Set(failing.map((p) => p.keyVersion))].sort((a, b) => a - b);
  for (const version of versions) {
    const configured =
      version === config.encryption.keyVersion || config.encryption.previousKeys.has(version);
    logger.error(SEALED_KEY_MISMATCH, {
      key_version: version,
      current_key_version: config.encryption.keyVersion,
      cause: configured
        ? 'a key is configured for this version but it is not the one that sealed these blobs'
        : 'no key is configured for this version',
      blobs: failing.filter((p) => p.keyVersion === version).map((p) => `${p.table}: ${p.count}`),
    });
  }
}

function logConfigurationSummary(
  logger: Logger,
  config: InstanceConfig,
  configFile: string | null,
): void {
  const opsStats =
    config.ops.token === null ? 'off (no ops.token)' : 'open to the bearer of ops.token';
  logger.info('configuration loaded', {
    source: configFile ? `file ${configFile} over environment` : 'environment',
    public_url: config.publicUrl.origin,
    instance_name: config.instanceName ?? 'not set (Administration decides; the host by default)',
    sign_in: config.signIn.map((signInProvider) => `${signInProvider.id} (${signInProvider.kind})`),
    admin_rule:
      config.admin.group === null && config.admin.emails.length === 0
        ? 'none (administrators live in the instance)'
        : config.admin.group
          ? 'group (a seed: applied while the store names nobody)'
          : `emails (${config.admin.emails.length}; a seed: applied while the store names nobody)`,
    telemetry: !config.telemetry.enabledSetByConfig
      ? 'not set (Administration decides; off by default)'
      : config.telemetry.enabled
        ? 'enabled'
        : 'disabled',
    key_version: config.encryption.keyVersion,
    trusted_proxies: config.trustedProxies.length,
    client_ip_header: config.clientIpHeader ?? 'not set',
    limits: {
      users: config.limits.users ?? 'unlimited',
      accounts: config.limits.accounts ?? 'unlimited',
      active_missions: config.limits.activeMissions ?? 'unlimited',
    },
    ops_stats: opsStats,
  });
  warnWithoutTrustedProxies(logger, config);
}

/**
 * The instance always sits behind a TLS terminator, so every request reaches it from
 * that proxy: with `trusted_proxies` empty no client address is believed, and every
 * limit keyed on the address is one window shared by all callers. Nothing is bypassed
 * (a forged `X-Forwarded-For` is ignored), but one caller can then hold the others at
 * 429: anybody signed out on the request page and sign-in.
 * Said once at boot, naming the key.
 */
export const NO_TRUSTED_PROXY_WARNING =
  'trusted_proxies is empty: no client address is resolved, so the address-keyed limits are shared by all callers';

/** Trusted-edge mode is a statement about the edge: said once at boot, with what it rests on. */
export const EDGE_HEADER_NOTICE =
  'client_ip_header is set: the client address is read from that header alone, which is safe only behind an edge that overwrites it on every request';

function warnWithoutTrustedProxies(logger: Logger, config: InstanceConfig): void {
  if (config.clientIpHeader !== null) {
    logger.warn(EDGE_HEADER_NOTICE, {
      key: 'client_ip_header',
      env: 'VAUBAAN_CLIENT_IP_HEADER',
      header: config.clientIpHeader,
      check:
        'send a request with a forged value of this header and confirm the instance sees your real address (deploy/railway.md)',
    });
    return;
  }
  if (config.trustedProxies.length > 0) return;
  logger.warn(NO_TRUSTED_PROXY_WARNING, {
    key: 'trusted_proxies',
    env: 'VAUBAAN_TRUSTED_PROXIES',
    affected: [
      'request page: one per-IP window for everybody',
      'sign-in and bootstrap: one window for everybody (one caller can hold the others at 429)',
      'audit: client_ip is not recorded',
    ],
    remedy:
      'set it to the address or CIDR block of the reverse proxy in front of the instance (deploy/README.md), or, behind an edge that overwrites a client-address header (Railway: X-Real-IP), set client_ip_header',
  });
}

/**
 * The key file on the store's mount: one copy of the volume opens every credential
 * (ADR master-key-generated-and-handed-over-by-the-instance, amendment 2026-10-31).
 * Said once at boot, unless the operator accepted it; nothing is said when the key is
 * given by value or the placement cannot be told.
 */
function warnKeyBesideStore(
  logger: Logger,
  config: InstanceConfig,
  facts: MountFacts = PROCESS_MOUNT_FACTS,
): void {
  const keyFile = config.encryption.masterKeyFile;
  if (keyFile === null || config.encryption.acceptKeyBesideStore) return;
  if (keyBesideStore(keyFile, config.store.path, facts) !== true) return;
  logger.warn(KEY_BESIDE_STORE_WARNING, {
    key_file: keyFile,
    store_path: config.store.path,
    remedy:
      'mount the key on a volume of its own (deploy/compose.yaml mounts gateway-key at /keys), or give it as a secret (VAUBAAN_MASTER_KEY_FILE=/run/secrets/…); keep a copy off the host',
    accept:
      'VAUBAAN_ACCEPT_KEY_BESIDE_STORE=1 when the volume’s snapshots are kept apart from the key',
  });
}

/** Releases one thing the build opened: a handle to close, a timer to stop. */
type Closer = () => Promise<void> | void;

/** What the modules are wired from: everything built before them. */
interface RootBase {
  readonly config: InstanceConfig;
  readonly logger: Logger;
  readonly registry: PluginRegistry;
  readonly store: Store;
  readonly build: BuildInfo;
  /** The boot wrote the master key file at this start (`boot-config.ts`). */
  readonly masterKeyGenerated: boolean;
  readonly encryptor: Encryptor;
  /** Every plugin known, bundled or pinned: where a plugin's own files are read from. */
  readonly pluginEntries: readonly PluginInventoryEntry[];
  /** Installing plugins: the `vaubaan` plugin acts reach it through a narrow port. */
  readonly pluginInstall: PluginInstallService;
  /** Holds each call's service against a swap of its plugin's version. */
  readonly callGate: PluginCallGate;
}

type RootModules = Pick<
  GatewayRoot,
  | 'rateLimiter'
  | 'cache'
  | 'sessions'
  | 'auth'
  | 'accounts'
  | 'authority'
  | 'shares'
  | 'groups'
  | 'missions'
  | 'requests'
  | 'audit'
  | 'budget'
  | 'execution'
  | 'git'
  | 'telemetry'
  | 'instance'
  | 'masterKey'
  | 'backup'
  | 'users'
  | 'notifications'
  | 'vaubaan'
  | 'limits'
  | 'opsStats'
>;

/**
 * Wires the feature modules over the base. Each timer a module starts is
 * pushed on `opened` at once, so the caller can stop it whether the build
 * completes (`close()`) or a later step throws.
 */
async function wireModules(base: RootBase, deps: RootDeps, opened: Closer[]): Promise<RootModules> {
  const { config, logger, registry, store, build, masterKeyGenerated, encryptor, pluginEntries } =
    base;

  // Web sessions live in the embedded store (`store.webSessions`, table
  // `web_sessions`) so they survive a restart and are revocable; a hosted
  // deployment injects a shared `SessionStore` instead.
  const sessions: SessionStore = deps.sessions ?? store.webSessions;
  // One count per item, read by the ceilings, the settings, `/ops/stats` and telemetry.
  const limits = createInstanceLimits(config.limits, store);
  const mailer =
    deps.mailer ??
    (config.mail
      ? createLinkMailer({
          config: config.mail,
          logger,
          instanceLabel: config.instanceName ?? config.publicUrl.host,
        })
      : undefined);
  // Before every module whose acts notify: each is handed `notifications.events`. What it
  // reads from `auth` and `instance`, built below, is read when a notification is sent.
  const notifications = createNotificationsModule({
    publicUrl: config.publicUrl,
    store,
    lookups: {
      missions: store.missions,
      accounts: store.accounts,
      users: store.users,
      groups: store.groups,
      administrators: async () =>
        (await auth.administrators.withAWayIn({ anyWay: true })).map((user) => user.id),
      instanceName: async () => (await instance.name.identity()).label,
      toolTitle: (tool) => toolTitleOf(registry, tool),
    },
    authenticator: () => auth.authenticator,
    logger,
    fetch: deps.notificationFetch,
    transport: deps.notificationTransport,
    resolve: deps.notificationResolve,
    // Mail is a channel when the instance delivers mail (spec §4.2 bis, §4.3).
    mailer: deps.notificationMailer ?? mailer,
    clock: deps.clock,
  });
  // Stopped after the timers, before the store: a delivery under way writes its outcome.
  opened.push(() => notifications.stop());
  // Authority reads the store only, so it is built first: the sign-in settles what a
  // changed membership did, and every module below checks, derives or watches through it.
  const authority = createAuthorityModule({
    store,
    registry,
    logger,
    notifications: notifications.events,
  });
  // One sliding-window limiter, two faces: the budget's per-risk windows
  // (`mission:<id>:risk:<id>`, probed and recorded inside the decision) and the
  // surface limits (`mcp:mission:<id>`, `connect:<user>`, `auth:*`), on disjoint keys.
  const windows = new SlidingWindowRateLimiter();
  const rateLimiter = deps.rateLimiter ?? windows;
  // Before anything reads the sign-in providers: the `idp.*` settings of earlier builds
  // become the saved provider `idp` (a no-op once done).
  await upgradeSingleSignInProviderSettings({
    store,
    configured: config.signIn,
    logger,
    now: () => (deps.clock ?? { now: () => new Date() }).now(),
  });
  const auth = createAuthModule({
    clock: deps.clock,
    mailer,
    config,
    store,
    sessions,
    logger,
    oidc: deps.oidc,
    rateLimiter,
    ceilings: limits,
    notifications: notifications.events,
    // The user themselves is the human behind a sign-in that changes their groups.
    membershipsChanging: async (user) => {
      const watch = await authority.membership.watch(user.id);
      return async () => {
        await watch.settle(user.id);
      };
    },
  });
  await settleAdministrators(auth, config);
  const missions = createMissionsModule({
    config,
    store,
    registry,
    authenticator: auth.authenticator,
    authority: authority.service,
    grounds: authority.grounds,
    logger,
    ceilings: limits,
    notifications: notifications.events,
  });

  const cache = deps.cache ?? new MemoryCacheClient();
  const accounts = createAccountsModule({
    config,
    store,
    registry,
    pluginEntries,
    sessions,
    rateLimiter,
    authenticator: auth.authenticator,
    grounds: authority.grounds,
    logger,
    fetch: deps.serviceFetch,
    ceilings: limits,
    notifications: notifications.events,
    refreshTimers: deps.refreshTimers,
    reach: authority.service,
  });
  // The accounts refresh themselves, hourly and when a page shows one stale; stopped
  // before the store closes (the refreshes in progress finish).
  opened.push(() => accounts.refresher.stop());
  accounts.refresher.start();
  const shares = createSharesModule({
    config,
    store,
    registry,
    accounts,
    authority: authority.service,
    grounds: authority.grounds,
    authenticator: auth.authenticator,
    sessions,
    logger,
  });
  const groups = createGroupsModule({
    config,
    store,
    membership: authority.membership,
    accounts,
    authenticator: auth.authenticator,
    logger,
  });
  // Starts the expiry sweeper of the inbox.
  const requests = createRequestsModule({
    missions: missions.service,
    config,
    store,
    registry,
    grounds: authority.grounds,
    authenticator: auth.authenticator,
    rateLimiter,
    logger,
    ceilings: limits,
  });
  opened.push(() => requests.sweeper.stop());

  // The retention purge runs once before the instance serves, then on a timer
  // (handbook audit). Registered before it starts: `start()` sets the timer
  // first, and `stop()` is safe on a sweeper that never started.
  const audit = createAuditModule({
    config,
    store,
    missions: missions.service,
    credentialKindOf: (service) => registry.get(service)?.plugin.credential.kind ?? null,
    logger,
  });
  opened.push(() => audit.retention.stop());
  await audit.retention.start();
  const budget = new SessionService({
    sessions: store.sessions,
    requests: store.requests,
    rateWindows: windows,
    // The single builder of `<public_url>/r/<id>` (requests module).
    requestUrl: requests.requestUrl,
    requestExpirySeconds: config.requests.expirySeconds,
    approvalValiditySeconds: config.approvals.expirySeconds,
    notifications: notifications.events,
  });
  // Off unless the operator turned it on and a real collector is configured.
  const telemetry = await createTelemetryModule({
    config,
    store,
    registry,
    authenticator: auth.authenticator,
    cache,
    logger,
    build,
    fetch: deps.telemetryFetch,
    profileSource: {
      users: () => limits.counts.users(),
      activeMissions: (now) => limits.counts.activeMissions(now),
      accountsByService: async () => ({ ...(await limits.counts.accounts()).byService }),
    },
  });
  opened.push(() => telemetry.stop());
  const instance = createInstanceModule({
    config,
    store,
    authenticator: auth.authenticator,
    logger,
  });
  const masterKey = createMasterKeyModule({
    config,
    store,
    authenticator: auth.authenticator,
    sessions: auth.sessions,
    logger,
  });
  // Remembered in the store, so the setup hands the key over once, across restarts.
  if (masterKeyGenerated) await masterKey.service.recordGenerated();
  // The scheduled backup arms its timer when `backup.s3.*` is configured; `stop()` waits
  // for a run in progress, so it is registered before the store's close runs.
  const backup = createBackupModule({
    config,
    store,
    encryptor,
    logger,
    fetch: deps.backupFetch,
    timers: deps.backupTimers,
    notifications: notifications.events,
  });
  opened.push(() => backup.stop());
  await backup.start();
  const users = createUsersModule({
    config,
    administrators: auth.administrators,
    bootstrap: auth.bootstrap,
    secondFactors: auth.secondFactors,
    masterKey: masterKey.service,
    store,
    membership: authority.membership,
    memberTokens: missions.team,
    accounts,
    authenticator: auth.authenticator,
    sessions: auth.sessions,
    signInAccounts: auth.signInAccounts,
    signInProviders: auth.signInProviders,
    mailer,
    logger,
    ceilings: limits,
  });
  // The gateway's own management tools, bound to the mission service through ports
  // (`compose/vaubaan.ts`); the execution door runs them like any plugin's.
  const vaubaan = wireVaubaanPlugin({
    missions: missions.service,
    registry,
    logger,
    plugins: vaubaanPluginsOf({
      install: base.pluginInstall,
      administrators: auth.administrators,
      users: store.users,
      entries: pluginEntries,
      publicUrl: config.publicUrl,
    }),
  });
  const execution = createExecutionModule({
    config,
    store,
    registry,
    auth,
    missions,
    accounts,
    grounds: authority.grounds,
    budget,
    cache,
    rateLimiter,
    logger,
    build,
    telemetry: telemetry.sink,
    hostExecutes: vaubaan.hostExecutes,
    notifications: notifications.events,
    callGate: base.callGate,
  });
  // A discovery the door scheduled after a creating call finishes before the store closes.
  opened.push(() => accounts.discoveryAfterCall.stop());
  // The git remote shares the execution door's admission, stages and audit.
  const git = createGitModule({
    config,
    store,
    registry,
    execution,
    accounts,
    logger,
    callGate: base.callGate,
  });
  opened.push(() => git.sweeper.stop());
  return {
    rateLimiter,
    cache,
    sessions,
    auth,
    accounts,
    authority,
    shares,
    groups,
    missions,
    requests,
    audit,
    budget,
    execution,
    git,
    telemetry,
    instance,
    masterKey,
    backup,
    users,
    notifications,
    vaubaan,
    limits,
    opsStats: {
      token: config.ops.token,
      logger,
      collect: () =>
        collectOpsStats({
          counts: limits.counts,
          limits: config.limits,
          calls: store.audit,
          store,
          sealed: store.sealedBlobs,
          currentKeyVersion: config.encryption.keyVersion,
          now: new Date(),
        }),
    },
  };
}

/**
 * Releases what was opened, last opened first (timers, then the store they
 * write to). Every closer runs even when one fails; the first failure is
 * rethrown once all have run.
 */
/**
 * The administrators live in the store (ADR administrators-live-in-the-instance): the
 * configuration's rule is applied while the store names nobody, and shown — never
 * applied — once it does. A store that names nobody, with no rule and no bootstrap
 * token, has no way to a first administrator: the boot stops and says so.
 */
async function settleAdministrators(auth: AuthModule, config: InstanceConfig): Promise<void> {
  // The factors sign-in accounts kept per account move to their people, once (§7).
  const signInProviders = await auth.signInProviders.views();
  await auth.secondFactors.adoptLocalFactors(
    signInProviders.filter((p) => p.kind === 'local').map((p) => p.id),
  );
  await auth.administrators.seedFromConfiguration();
  if (config.bootstrapToken !== null || (await auth.administrators.any())) return;
  throw new ConfigError([
    {
      path: 'bootstrap_token',
      env: ['VAUBAAN_BOOTSTRAP_TOKEN'],
      message:
        'this gateway has no administrator yet and no admin rule: set a bootstrap token (32 characters or more) and open the setup link to name the first administrator',
    },
  ]);
}

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

/**
 * One warning per retired key or variable the configuration still sets: the
 * OAuth clients an administrator declared per provider (`providers.<id>.*`,
 * `VAUBAAN_PROVIDER_<ID>_<FIELD>`) are no longer read since Gmail connects with
 * an app password (ADR gmail-over-imap-with-an-app-password). The instance
 * starts; the value is never logged.
 */
export function logRetiredKeys(
  config: Pick<InstanceConfig, 'retiredKeys' | 'retiredManagementKeys' | 'deprecatedKeys'>,
  logger: Logger,
): void {
  for (const { old, current } of config.deprecatedKeys) {
    logger.warn(DEPRECATED_KEY_WARNING, { key: old, write_instead: current });
  }
  for (const key of config.retiredKeys) {
    logger.warn(
      'configuration key no longer read: the gateway takes no OAuth client declared by an administrator (Gmail connects with an app password); remove it',
      { key },
    );
  }
  // One line for the whole retired block (ADR platform-management-is-a-plugin-on-the-execution-door).
  if (config.retiredManagementKeys.length > 0) {
    logger.warn(RETIRED_MANAGEMENT_KEYS_WARNING, { keys: [...config.retiredManagementKeys] });
  }
}

/** Said once per renamed key or variable the configuration still uses under its old name. */
export const DEPRECATED_KEY_WARNING =
  'configuration key renamed: it is still read under its old name, for now; write the new one';

/** Said once at boot when the configuration still sets keys of the retired authorization server. */
export const RETIRED_MANAGEMENT_KEYS_WARNING =
  'configuration keys no longer read: the gateway runs no OAuth authorization server any more (agents prepare missions through the Vaubaan account and a mission key); remove them';

/**
 * The active missions on an account of `service`, by name, for the activation page. The
 * stored status says `active` for an orphaned mission: each record is derived through the
 * mission grounds first (spec §2.3).
 */
async function missionsOnService(
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
async function restoreNeededPlugins(
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
