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
import { createBackupModule, type BackupService, type BackupTimers } from '../backup';
import { createAuthModule, type AuthModule, type LinkMailer, type OidcOptions } from '../auth';
import { createLinkMailer } from '../mail';
import { createAuthorityModule, derivedMissionReads, type AuthorityModule } from '../authority';
import { SessionService } from '../budget';
import { createConnectionsModule, type ConnectionsModule } from '../connections';
import {
  buildInfoFromEnv,
  ConfigError,
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
import { createGitModule, type GitModule } from '../git';
import { createGroupsModule, type GroupsModule } from '../groups';
import { createInstanceModule, type InstanceModule } from '../instance';
import { collectOpsStats, createInstanceLimits, type InstanceLimits } from '../limits';
import { createMasterKeyModule, type MasterKeyModule } from '../master-key';
import type { OpsStatsDeps } from '../http/ops-stats';
import { publishHttps } from '../http/security-headers';
import { createLogger, createRedactor, type Logger, type LoggerOptions } from '../logging';
import { createMissionsModule, type MissionsModule } from '../missions';
import { createOAuthAsModule, type ClientDocumentFetcher, type OAuthAsModule } from '../oauth-as';
import { createRequestsModule, type RequestsModule } from '../requests';
import { SlidingWindowRateLimiter } from '../rate-limit';
import { createSharesModule, type SharesModule } from '../shares';
import { createUsersModule, type UsersModule } from '../users';
import { createTelemetryModule, type TelemetryModule } from '../telemetry';
import type { Store } from '../store';
import type { Clock } from '../store/clock';
import type { CacheClient, RateLimiter, SessionStore } from './ports';
import { checkSelfResources, RegistryCatalogIndex } from './registry';
import {
  KEY_BESIDE_STORE_WARNING,
  keyBesideStore,
  PROCESS_MOUNT_FACTS,
  type MountFacts,
} from './key-placement';
import { wireManagementDoor, type ManagementDoorModule } from './management';
import { clearSetup, currentSetup, SetupModeError } from '../setup/state';
import { loadBootConfig } from './boot-config';
import { buildShippedRegistry } from './shipped-plugins';
import { openEmbeddedStore, type StoreContext } from './store';

export interface GatewayRoot {
  readonly config: InstanceConfig;
  /** YAML file merged in, or `null` for environment-only configuration. */
  readonly configFile: string | null;
  readonly logger: Logger;
  readonly encryptor: Encryptor;
  /** The embedded store with its repositories; satisfies `StoreLiveness` of `ports.ts`. */
  readonly store: Store;
  /** The single provider list: the plugins the image ships (`shipped-plugins.ts`). */
  readonly registry: PluginRegistry;
  readonly rateLimiter: RateLimiter;
  readonly cache: CacheClient;
  readonly sessions: SessionStore;
  /** Human authentication: OIDC relying party, web sessions, bootstrap, admin rule. */
  readonly auth: AuthModule;
  /** Connect flows, resources, credential broker with the generic OAuth refresh. */
  readonly connections: ConnectionsModule;
  /** Authority: owner or union of shares, mission grounds (`orphaned`, derived), membership settlement. */
  readonly authority: AuthorityModule;
  /** Shares of a connection to a user or a group, and the shares a user received. */
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
  /** Authorization server of the management door: clients, consent, delegated tokens. */
  readonly oauth: OAuthAsModule;
  /** Administration → Users: the operator's deactivation and reactivation of a user. */
  readonly users: UsersModule;
  /** `/mcp/manage`: its admission gate and, behind it, the door with its seven tools. */
  readonly management: ManagementDoorModule;
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
  /** Sends the mails of the local accounts' links; built from `mail.*` by the boot (wave C). */
  readonly mailer?: LinkMailer;
  readonly buildRegistry?: (config: InstanceConfig, logger: Logger) => Promise<PluginRegistry>;
  readonly rateLimiter?: RateLimiter;
  readonly cache?: CacheClient;
  readonly sessions?: SessionStore;
  /** Outbound HTTP and issuer rules of the OIDC relying party (tests inject an in-process IdP). */
  readonly oidc?: OidcOptions;
  /** Outbound HTTP of the connect flows and of plugin discovery (tests inject a mock provider). */
  readonly providerFetch?: typeof fetch;
  /** Replaces the authorization server's verifier at the execution door (tests of the door alone). */
  readonly delegatedTokens?: DelegatedTokenResolver;
  /** Outbound HTTP to the telemetry collector (tests assert on it; default: the global `fetch`). */
  readonly telemetryFetch?: typeof fetch;
  /** Outbound fetch of Client ID Metadata Documents (tests inject a fake; unused unless enabled). */
  readonly clientDocumentFetch?: ClientDocumentFetcher;
  /** Outbound HTTP to the backup's object storage (tests inject an in-process fake). */
  readonly backupFetch?: typeof fetch;
  /** The scheduled backup's timers (tests drive them by hand). */
  readonly backupTimers?: BackupTimers;
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

  const encryptor = await createEncryptor(config.encryption);

  // The registry comes first: the store checks every persisted RiskId
  // against the loaded catalogs.
  const registry = await (deps.buildRegistry ?? buildShippedRegistry)(config, logger);
  logRetiredKeys(config, logger);
  checkSelfResources(config, registry);

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
    await checkSealedKeys(store, config, logger);
    const modules = await wireModules(
      { config, logger, registry, store, build, masterKeyGenerated, encryptor },
      deps,
      opened,
    );
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
    idp: config.idp ? config.idp.issuer.origin : 'not configured',
    sign_in: config.signIn.map((provider) => `${provider.id} (${provider.kind})`),
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
      connections: config.limits.connections ?? 'unlimited',
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
 * 429: anybody on the request page, and — knowing a token prefix, which is not a
 * secret — an agent whose token is not verified yet. Said once at boot, naming the key.
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
      'execution door, tokens issued by an earlier build only: one argon2id verification window per token prefix (a flood of wrong secrets on such a prefix holds its agent at 429 until the token has been used once)',
      'authorization server: one registration window and one token window for everybody (one caller can hold every delegated client at 429 when it renews its token)',
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
}

type RootModules = Pick<
  GatewayRoot,
  | 'rateLimiter'
  | 'cache'
  | 'sessions'
  | 'auth'
  | 'connections'
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
  | 'oauth'
  | 'users'
  | 'management'
  | 'limits'
  | 'opsStats'
>;

/**
 * Wires the feature modules over the base. Each timer a module starts is
 * pushed on `opened` at once, so the caller can stop it whether the build
 * completes (`close()`) or a later step throws.
 */
async function wireModules(base: RootBase, deps: RootDeps, opened: Closer[]): Promise<RootModules> {
  const { config, logger, registry, store, build, masterKeyGenerated, encryptor } = base;

  // Web sessions live in the embedded store (`store.webSessions`, table
  // `web_sessions`) so they survive a restart and are revocable; a hosted
  // deployment injects a shared `SessionStore` instead.
  const sessions: SessionStore = deps.sessions ?? store.webSessions;
  // One count per item, read by the ceilings, the settings, `/ops/stats` and telemetry.
  const limits = createInstanceLimits(config.limits, store);
  // Authority reads the store only, so it is built first: the sign-in settles what a
  // changed membership did, and every module below checks, derives or watches through it.
  const authority = createAuthorityModule({ store, registry, logger });
  // One sliding-window limiter, two faces: the budget's per-risk windows
  // (`mission:<id>:risk:<id>`, probed and recorded inside the decision) and the
  // surface limits (`mcp:mission:<id>`, `connect:<user>`, `auth:*`), on disjoint keys.
  const windows = new SlidingWindowRateLimiter();
  const rateLimiter = deps.rateLimiter ?? windows;
  const mailer =
    deps.mailer ??
    (config.mail
      ? createLinkMailer({
          config: config.mail,
          logger,
          instanceLabel: config.instanceName ?? config.publicUrl.host,
        })
      : undefined);
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
  });

  const cache = deps.cache ?? new MemoryCacheClient();
  const connections = createConnectionsModule({
    config,
    store,
    registry,
    sessions,
    rateLimiter,
    authenticator: auth.authenticator,
    grounds: authority.grounds,
    logger,
    fetch: deps.providerFetch,
    ceilings: limits,
  });
  const shares = createSharesModule({
    config,
    store,
    registry,
    connections,
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
    connections,
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
    profileSource: {
      users: () => limits.counts.users(),
      activeMissions: (now) => limits.counts.activeMissions(now),
      accountsByProvider: async () => ({ ...(await limits.counts.connections()).byProvider }),
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
  });
  opened.push(() => backup.stop());
  await backup.start();
  // The authorization server comes before the doors: the execution door refuses
  // a delegated token by kind, the management door admits nothing else.
  const oauth = createOAuthAsModule({
    config,
    // The Delegations page shows the status of the missions a delegation issued:
    // it lists them with the derived status (`orphaned` is never stored).
    store: {
      ...store,
      missions: {
        ...store.missions,
        ...derivedMissionReads(store.missions, authority.grounds),
      },
    },
    sessions,
    authenticator: auth.authenticator,
    rateLimiter,
    logger,
    fetchClientDocument: deps.clientDocumentFetch,
    build,
  });
  // After the authorization server: deactivating a user revokes their delegations.
  const users = createUsersModule({
    config,
    administrators: auth.administrators,
    bootstrap: auth.bootstrap,
    secondFactors: auth.secondFactors,
    masterKey: masterKey.service,
    store,
    membership: authority.membership,
    delegations: oauth.delegations,
    memberTokens: missions.team,
    connections,
    authenticator: auth.authenticator,
    sessions: auth.sessions,
    accounts: auth.accounts,
    providers: auth.providers,
    mailer,
    logger,
    ceilings: limits,
  });
  const execution = createExecutionModule({
    config,
    store,
    registry,
    auth,
    missions,
    connections,
    grounds: authority.grounds,
    budget,
    cache,
    rateLimiter,
    logger,
    build,
    delegations: deps.delegatedTokens ?? oauth.verifier,
    telemetry: telemetry.sink,
  });
  // A discovery the door scheduled after a creating call finishes before the store closes.
  opened.push(() => connections.discoveryAfterCall.stop());
  // The git remote shares the execution door's admission, stages and audit.
  const git = createGitModule({
    config,
    store,
    registry,
    execution,
    connections,
    logger,
  });
  opened.push(() => git.sweeper.stop());
  // The door is handed ports, not modules: see `compose/management.ts`.
  const management = wireManagementDoor({
    config,
    gate: { oauth, missionTokens: execution.tokens, webSessions: auth.sessions },
    missions: missions.service,
    registry,
    rateLimiter,
    build,
    logger,
  });

  return {
    rateLimiter,
    cache,
    sessions,
    auth,
    connections,
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
    oauth,
    users,
    management,
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
  // The factors local accounts kept per account move to their people, once (§7).
  const providers = await auth.providers.views();
  await auth.secondFactors.adoptLocalFactors(
    providers.filter((p) => p.kind === 'local').map((p) => p.id),
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
export function logRetiredKeys(config: Pick<InstanceConfig, 'retiredKeys'>, logger: Logger): void {
  for (const key of config.retiredKeys) {
    logger.warn(
      'configuration key no longer read: the gateway takes no OAuth client declared by an administrator (Gmail connects with an app password); remove it',
      { key },
    );
  }
}
