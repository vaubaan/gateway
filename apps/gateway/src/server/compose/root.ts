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

import { createAuditModule, type AuditModule } from '../audit';
import { createAuthModule, type AuthModule, type OidcOptions } from '../auth';
import { SessionService } from '../budget';
import { createConnectionsModule, type ConnectionsModule } from '../connections';
import {
  buildInfoFromEnv,
  loadInstanceConfig,
  type BuildInfo,
  type InstanceConfig,
  type LoadedConfig,
  secretValues,
} from '../config';
import { createEncryptor, type Encryptor } from '../crypto';
import {
  createExecutionModule,
  type DelegatedTokenResolver,
  type ExecutionModule,
} from '../execution';
import { createLogger, createRedactor, type Logger, type LoggerOptions } from '../logging';
import { ProviderAppsService } from '../provider-apps';
import { createMissionsModule, type MissionsModule } from '../missions';
import { createRequestsModule, type RequestsModule } from '../requests';
import { SlidingWindowRateLimiter } from '../rate-limit';
import { createTelemetryModule, type TelemetryModule } from '../telemetry';
import type { Store } from '../store';
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
  /** Requests to the creator: inbox, claim decisions, expiry sweeper, request URL (P1.7). */
  readonly requests: RequestsModule;
  /** Audit search, mission session view, retention sweeper (P1.8). */
  readonly audit: AuditModule;
  /** Budget: the session service deciding and counting every allowed call (P1.3). */
  readonly budget: SessionService;
  /** The execution MCP door: `/mcp`, `/mcp/catalog`, the call pipeline (P1.6). */
  readonly execution: ExecutionModule;
  /** Community telemetry: the pipeline's sink, the operator's toggle, the validation status (P2.5). */
  readonly telemetry: TelemetryModule;
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
  readonly buildRegistry?: (config: InstanceConfig, logger: Logger) => Promise<PluginRegistry>;
  readonly rateLimiter?: RateLimiter;
  readonly cache?: CacheClient;
  readonly sessions?: SessionStore;
  /** Outbound HTTP and issuer rules of the OIDC relying party (tests inject an in-process IdP). */
  readonly oidc?: OidcOptions;
  /** Outbound HTTP of the connect flows and of plugin discovery (tests inject a mock provider). */
  readonly providerFetch?: typeof fetch;
  /** Recognises delegated tokens at the execution door so they are refused by kind (P2.3 wires the real one). */
  readonly delegatedTokens?: DelegatedTokenResolver;
  /** Outbound HTTP to the telemetry collector (tests assert on it; default: the global `fetch`). */
  readonly telemetryFetch?: typeof fetch;
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
  logConfigurationSummary(logger, config, configFile);

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

  // Everything opened from here on is registered as it opens (the store
  // handle, then each timer), so a late failure closes it: `getRoot` retries
  // a failed build, and a retry must not find a second handle on the same file.
  const opened: Closer[] = [() => store.close()];
  try {
    const modules = await wireModules({ config, logger, registry, store, build }, deps, opened);
    const root: GatewayRoot = {
      config,
      configFile,
      logger,
      encryptor,
      store,
      registry,
      ...modules,
      build,
      startedAt: new Date(),
      close: () => closeAll(opened),
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

function logConfigurationSummary(
  logger: Logger,
  config: InstanceConfig,
  configFile: string | null,
): void {
  logger.info('configuration loaded', {
    source: configFile ? `file ${configFile} over environment` : 'environment',
    public_url: config.publicUrl.origin,
    idp: config.idp ? config.idp.issuer.origin : 'not configured',
    admin_rule: config.admin.group ? 'group' : `emails (${config.admin.emails.length})`,
    providers: [...config.providers.keys()],
    telemetry: !config.telemetry.enabledSetByConfig
      ? 'not set (Administration decides; off by default)'
      : config.telemetry.enabled
        ? 'enabled'
        : 'disabled',
    key_version: config.encryption.keyVersion,
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
}

type RootModules = Pick<
  GatewayRoot,
  | 'rateLimiter'
  | 'cache'
  | 'sessions'
  | 'auth'
  | 'providerApps'
  | 'connections'
  | 'missions'
  | 'requests'
  | 'audit'
  | 'budget'
  | 'execution'
  | 'telemetry'
>;

/**
 * Wires the feature modules over the base. Each timer a module starts is
 * pushed on `opened` at once, so the caller can stop it whether the build
 * completes (`close()`) or a later step throws.
 */
async function wireModules(base: RootBase, deps: RootDeps, opened: Closer[]): Promise<RootModules> {
  const { config, logger, registry, store, build } = base;

  // Web sessions live in the embedded store (`store.webSessions`, table
  // `web_sessions`) so they survive a restart and are revocable; a hosted
  // deployment injects a shared `SessionStore` instead.
  const sessions: SessionStore = deps.sessions ?? store.webSessions;
  const auth = createAuthModule({ config, store, sessions, logger, oidc: deps.oidc });
  const missions = createMissionsModule({
    config,
    store,
    registry,
    authenticator: auth.authenticator,
    logger,
  });

  // One sliding-window limiter, two faces: the budget's per-risk windows
  // (`mission:<id>:risk:<id>`, probed and recorded inside the decision) and the
  // surface limits (`mcp:mission:<id>`, `connect:<user>`), on disjoint keys.
  const windows = new SlidingWindowRateLimiter();
  const rateLimiter = deps.rateLimiter ?? windows;
  const cache = deps.cache ?? new MemoryCacheClient();
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
  // Starts the expiry sweeper of the inbox.
  const requests = createRequestsModule({
    config,
    store,
    registry,
    authenticator: auth.authenticator,
    rateLimiter,
    logger,
  });
  opened.push(() => requests.sweeper.stop());

  // The retention purge runs once before the instance serves, then on a timer
  // (handbook audit). Registered before it starts: `start()` sets the timer
  // first, and `stop()` is safe on a sweeper that never started.
  const audit = createAuditModule({ config, store, missions: missions.service, logger });
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
  });
  opened.push(() => telemetry.stop());
  const execution = createExecutionModule({
    config,
    store,
    registry,
    auth,
    missions,
    connections,
    budget,
    cache,
    rateLimiter,
    logger,
    build,
    delegations: deps.delegatedTokens,
    telemetry: telemetry.sink,
  });

  return {
    rateLimiter,
    cache,
    sessions,
    auth,
    providerApps,
    connections,
    missions,
    requests,
    audit,
    budget,
    execution,
    telemetry,
  };
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
