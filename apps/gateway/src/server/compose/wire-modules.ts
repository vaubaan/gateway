/**
 * The feature modules of the composition root, wired in their order over what
 * `buildRoot` (`root.ts`) built before them: notifications, authority, auth, missions,
 * accounts, shares, groups, requests, audit, budget, telemetry, instance, master key,
 * backup, users, the `vaubaan` plugin, execution and git.
 */
import { MemoryCacheClient } from '@vaubaan/gateway-core';
import type { PluginRegistry } from '@vaubaan/plugin-sdk';

import { createAuditModule, type AuditModule } from '../audit';
import { createBackupModule, type BackupService, type BackupTimers } from '../backup';
import { createAuthModule, type AuthModule, type LinkMailer, type OidcOptions } from '../auth';
import { upgradeSingleSignInProviderSettings } from '../auth/single-sign-in-provider-upgrade';
import { createLinkMailer } from '../mail';
import { createAuthorityModule, type AuthorityModule } from '../authority';
import { MissionLogService } from '../budget';
import { createAccountsModule, type AccountsModule, type RefreshTimers } from '../accounts';
import { ConfigError, type BuildInfo, type InstanceConfig } from '../config';
import type { Encryptor } from '../crypto';
import { createExecutionModule, type ExecutionModule } from '../execution';
import { createGitModule, type GitModule } from '../git';
import { createGroupsModule, type GroupsModule } from '../groups';
import { createInstanceModule, type InstanceModule } from '../instance';
import { collectOpsStats, createInstanceLimits, type InstanceLimits } from '../limits';
import { createMasterKeyModule, type MasterKeyModule } from '../master-key';
import type { OpsStatsDeps } from '../http/ops-stats';
import type { Resolver } from '../http/public-address';
import type { Logger } from '../logging';
import { createMissionsModule, type MissionsModule } from '../missions';
import {
  createNotificationsModule,
  type NotificationsModule,
  type PushTransport,
} from '../notifications';
import { toolTitleOf } from '../services/tool-titles';
import type { PluginInventoryEntry } from '../plugins';
import type { PluginCallGate } from '../plugins/call-gate';
import type { PluginInstallService } from '../plugins/install-service';
import { createRequestsModule, type RequestsModule } from '../requests';
import { SlidingWindowRateLimiter } from '../rate-limit';
import { createSharesModule, type SharesModule } from '../shares';
import { createUsersModule, type UsersModule } from '../users';
import { createTelemetryModule, type TelemetryModule } from '../telemetry';
import type { Store } from '../store';
import type { Clock } from '../store/clock';
import type { CacheClient, RateLimiter, SessionStore } from './ports';
import { vaubaanPluginsOf, wireVaubaanPlugin, type VaubaanPluginModule } from './vaubaan';

/** The injection points of the modules (`RootDeps` extends them). */
export interface ModulesDeps {
  /** Tests: the clock of the authentication module (link expiry, lockouts); the system clock otherwise. */
  readonly clock?: Clock;
  /** Sends the mails of the sign-in accounts' links; built from `mail.*` by the boot (wave C). */
  readonly mailer?: LinkMailer;
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
}

/** The feature modules of the root (`GatewayRoot` extends them). */
export interface RootModules {
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
  /** Audit search, mission log view, retention sweeper. */
  readonly audit: AuditModule;
  /** Budget: the mission log service deciding and counting every allowed call. */
  readonly budget: MissionLogService;
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
}

/** Releases one thing the build opened: a handle to close, a timer to stop. */
export type Closer = () => Promise<void> | void;

/** What the modules are wired from: everything built before them. */
export interface RootBase {
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

/**
 * Wires the feature modules over the base. Each timer a module starts is
 * pushed on `opened` at once, so the caller can stop it whether the build
 * completes (`close()`) or a later step throws.
 */
export async function wireModules(
  base: RootBase,
  deps: ModulesDeps,
  opened: Closer[],
): Promise<RootModules> {
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
    version: build.version,
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
  const budget = new MissionLogService({
    missionLogs: store.missionLogs,
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
  // A local setup's flow through Google, Microsoft or GitHub ends as the form does.
  auth.completeSetupWith((request, signInProvider, identity, starter) =>
    users.handlers.localSetupWith(request, signInProvider, identity, starter),
  );
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
