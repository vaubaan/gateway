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
import { MemoryCacheClient } from '@vaubaan/gateway-core';
import type { PluginRegistry } from '@vaubaan/plugin-sdk';

import { createAuthModule, type AuthModule, type OidcOptions } from '../auth';
import { createConnectionsModule, type ConnectionsModule } from '../connections';
import {
  loadInstanceConfig,
  type InstanceConfig,
  type LoadedConfig,
  secretValues,
} from '../config';
import { createEncryptor, type Encryptor } from '../crypto';
import { createLogger, createRedactor, type Logger, type LoggerOptions } from '../logging';
import { ProviderAppsService } from '../provider-apps';
import { createMissionsModule, type MissionsModule } from '../missions';
import { SqliteSessionStore } from '../session';
import type { Store } from '../store';
import { MemoryRateLimiter } from './memory';
import type { CacheClient, RateLimiter, SessionStore } from './ports';
import { checkProviderApps, RegistryCatalogIndex } from './registry';
import { buildShippedRegistry } from './shipped-plugins';
import { openEmbeddedStore, type StoreContext } from './store';

export interface GatewayRoot {
  readonly config: InstanceConfig;
  /** YAML file merged in, or `null` for environment-only configuration. */
  readonly configFile: string | null;
  readonly logger: Logger;
  readonly encryptor: Encryptor;
  /** The embedded store with its repositories (P0.3); satisfies `StoreLiveness` of `ports.ts`. */
  readonly store: Store;
  /** The single provider list (P0.2): the plugins the image ships (`shipped-plugins.ts`). */
  readonly registry: PluginRegistry;
  readonly rateLimiter: RateLimiter;
  readonly cache: CacheClient;
  readonly sessions: SessionStore;
  /** Human authentication: OIDC relying party, web sessions, bootstrap, admin rule (P1.1). */
  readonly auth: AuthModule;
  /** The company's registered app per provider: mounted configuration or Admin page (P1.4). */
  readonly providerApps: ProviderAppsService;
  /** Connect flows, resources, credential broker with the generic OAuth refresh (P1.4). */
  readonly connections: ConnectionsModule;
  /** Missions: authority, preview / issue / rotate / revoke, bootstrap kit (P1.5). */
  readonly missions: MissionsModule;
  readonly build: BuildInfo;
  readonly startedAt: Date;
  close(): Promise<void>;
}

export interface BuildInfo {
  readonly version: string;
  readonly commit: string;
}

/**
 * Injection points. The defaults are the production wiring (SQLite store at
 * `store.path`, the plugins the image ships); tests inject the `:memory:`
 * store, a fixture registry or fakes of the in-memory ports.
 */
export interface RootDeps {
  readonly loadConfig?: () => LoadedConfig;
  readonly openStore?: (ctx: StoreContext) => Promise<Store>;
  readonly buildRegistry?: (config: InstanceConfig, logger: Logger) => Promise<PluginRegistry>;
  readonly rateLimiter?: RateLimiter;
  readonly cache?: CacheClient;
  readonly sessions?: SessionStore;
  /** Outbound HTTP and issuer rules of the OIDC relying party (tests inject an in-process IdP). */
  readonly oidc?: OidcOptions;
  /** Outbound HTTP of the connect flows and of plugin discovery (tests inject a mock provider). */
  readonly providerFetch?: typeof fetch;
  readonly logWrite?: LoggerOptions['write'];
  readonly build?: BuildInfo;
}

export async function buildRoot(deps: RootDeps = {}): Promise<GatewayRoot> {
  const { config, configFile } = (deps.loadConfig ?? loadInstanceConfig)();
  const logger = createLogger({
    level: config.log.level,
    redact: createRedactor(secretValues(config)),
    write: deps.logWrite,
  }).child({ component: 'gateway' });
  const build = deps.build ?? buildInfoFromEnv();

  logger.info('configuration loaded', {
    source: configFile ? `file ${configFile} over environment` : 'environment',
    public_url: config.publicUrl.origin,
    idp: config.idp ? config.idp.issuer.origin : 'not configured',
    admin_rule: config.admin.group ? 'group' : `emails (${config.admin.emails.length})`,
    providers: [...config.providers.keys()],
    telemetry: config.telemetry.enabled ? 'enabled' : 'disabled',
    key_version: config.encryption.keyVersion,
  });

  const encryptor = await createEncryptor(config.encryption);

  // The registry comes first: the store checks every persisted RiskId
  // against the loaded catalogs, and the provider apps against the ids.
  const registry = await (deps.buildRegistry ?? buildShippedRegistry)(config, logger);
  checkProviderApps(config, registry, logger);

  const store = await (deps.openStore ?? openEmbeddedStore)({
    config,
    logger,
    encryptor,
    catalog: new RegistryCatalogIndex(registry),
  });

  // Web sessions live in the embedded store (table `web_sessions`) so they
  // survive a restart and are revocable; a hosted deployment injects a shared
  // `SessionStore` instead.
  const sessions = deps.sessions ?? new SqliteSessionStore({ db: store.db });
  const auth = createAuthModule({ config, store, sessions, logger, oidc: deps.oidc });
  const missions = createMissionsModule({
    config,
    store,
    registry,
    authenticator: auth.authenticator,
    logger,
  });

  const rateLimiter = deps.rateLimiter ?? new MemoryRateLimiter();
  const providerApps = new ProviderAppsService(config.providers, store.config, registry);
  const connections = createConnectionsModule({
    config,
    store,
    registry,
    providerApps,
    sessions,
    rateLimiter,
    authenticator: auth.authenticator,
    logger,
    fetch: deps.providerFetch,
  });

  const root: GatewayRoot = {
    config,
    configFile,
    logger,
    encryptor,
    store,
    registry,
    rateLimiter,
    cache: deps.cache ?? new MemoryCacheClient(),
    sessions,
    auth,
    providerApps,
    connections,
    missions,
    build,
    startedAt: new Date(),
    async close() {
      await store.close();
    },
  };
  logger.info('composition root ready', {
    store: store.kind,
    schema_version: store.schemaVersion,
    plugins: registry.ids,
    build,
  });
  return root;
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
    const pending = buildRoot(deps);
    g[GLOBAL_KEY] = pending;
    pending.catch(() => {
      if (g[GLOBAL_KEY] === pending) delete g[GLOBAL_KEY];
    });
  }
  return g[GLOBAL_KEY];
}

/** Closes and forgets the process-wide root. Tests only. */
export async function resetRoot(): Promise<void> {
  const g = globalThis as GlobalWithRoot;
  const pending = g[GLOBAL_KEY];
  delete g[GLOBAL_KEY];
  if (pending) {
    try {
      await (await pending).close();
    } catch {
      // a root that failed to build has nothing to close
    }
  }
}

/** Build stamps frozen into the bundle by `next.config.ts`; `dev` outside a build. */
function buildInfoFromEnv(): BuildInfo {
  return {
    version: process.env.NEXT_PUBLIC_GATEWAY_VERSION || 'dev',
    commit: process.env.NEXT_PUBLIC_COMMIT_SHA || 'dev',
  };
}
