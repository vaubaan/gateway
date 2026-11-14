/**
 * Accounts (spec §0 "Account", "Resource"; §2.3; §4.2; §6 anti-replay;
 * §7.2): the generic connect driver over `CredentialSpec`, the resources of an
 * account, the credential broker with its generic OAuth refresh, and the
 * HTTP handlers. Built once by the composition root as `root.accounts`.
 * Handbook: docs/handbook/accounts.md.
 */
import type { PluginRegistry } from '@vaubaan/plugin-sdk';

import type { Authenticator } from '../auth/authenticator';
import type { MissionGrounds } from '../authority';
import type { RateLimiter, SessionStore } from '../compose/ports';
import type { InstanceConfig } from '../config/types';
import type { CeilingCheck } from '../limits';
import type { Logger } from '../logging';
import { bundledInventory, readConnectFile, type PluginInventoryEntry } from '../plugins';
import type { Store } from '../store';
import { systemClock, type Clock } from '../store/clock';
import { CredentialBroker } from './credentials';
import { DiscoveryAfterCall } from './discovery-after-call';
import { FutureResources } from './future-resources';
import { HourlyDiscovery, type DiscoveryTimers } from './hourly-discovery';
import { createAccountHandlers, type AccountHandlers } from './handlers';
import { OAuth2Clients } from './oauth2-clients';
import { productionAttestationKit } from './attestation-kit';
import { OAuthBrokers } from './oauth-broker';
import { NoticeStore, PendingConnectStore } from './pending';
import { AccountService } from './service';
import type { NotificationEvents } from '../notifications/events';

export interface AccountsModuleDeps {
  readonly config: InstanceConfig;
  readonly store: Store;
  readonly registry: PluginRegistry;
  /**
   * Every plugin known, bundled or pinned (`root.plugins.entries`): where the connect
   * guide's screenshots are read from. Absent (tests): every plugin bundled and enabled.
   */
  readonly pluginEntries?: readonly PluginInventoryEntry[];
  readonly sessions: SessionStore;
  readonly rateLimiter: RateLimiter;
  readonly authenticator: Authenticator;
  /** Watches the missions of an account across its revocation, transfer or reassignment. */
  readonly grounds: Pick<MissionGrounds, 'watchAccount'>;
  readonly logger: Logger;
  /** Outbound HTTP of the connect flows and of the plugins' discovery (tests inject a mock). */
  readonly fetch?: typeof fetch;
  readonly clock?: Clock;
  /** The `limits.accounts` ceiling (`root.limits`); absent, none. */
  readonly ceilings?: CeilingCheck;
  /** Told when an account needs reconnecting (spec §4.2 bis); default: nobody. */
  readonly notifications?: Pick<NotificationEvents, 'accountNeedsReconnecting'>;
  /** The hourly discovery's timers (tests drive them by hand). */
  readonly discoveryTimers?: DiscoveryTimers;
}

export interface AccountsModule {
  readonly service: AccountService;
  /** Decrypted credentials and their refresh — the hook the execution door calls. */
  readonly credentials: CredentialBroker;
  readonly notices: NoticeStore;
  readonly handlers: AccountHandlers;
  /**
   * Runs an account's discovery after a call that created one of its
   * resources (ADR created-resources-join-the-mission): the execution door's
   * hook, stopped by `root.close()`.
   */
  readonly discoveryAfterCall: DiscoveryAfterCall;
  /**
   * Joins and leaves of the running missions' future resources after a discovery, a
   * relabel or a resource a call created (ADR
   * resource-set-is-one-environment-with-optional-future-resources).
   */
  readonly futureResources: FutureResources;
  /** The hourly discovery of the accounts future resources depend on; `start()` by the root. */
  readonly hourlyDiscovery: HourlyDiscovery;
}

export function createAccountsModule(deps: AccountsModuleDeps): AccountsModule {
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger.child({ component: 'accounts' });
  const outbound: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const clients = new OAuth2Clients({
    config: deps.store.config,
    publicUrl: deps.config.publicUrl,
    fetch: outbound,
    clock,
    logger,
  });
  const brokers = new OAuthBrokers(deps.config.oauthBrokers, {
    fetch: outbound,
    attestation: productionAttestationKit({ fetch: outbound }),
  });
  const credentials = new CredentialBroker({
    accounts: deps.store.accounts,
    registry: deps.registry,
    clients,
    brokers,
    fetch: outbound,
    clock,
    logger,
    notifications: deps.notifications,
  });
  const futureResources = new FutureResources({
    store: deps.store,
    audit: deps.store.auditWriter,
    selfResources: deps.config.selfResources,
    logger,
    clock,
  });
  const service = new AccountService({
    store: deps.store,
    registry: deps.registry,
    clients,
    brokers,
    broker: credentials,
    grounds: deps.grounds,
    pending: new PendingConnectStore(deps.sessions),
    rateLimiter: deps.rateLimiter,
    audit: deps.store.auditWriter,
    publicUrl: deps.config.publicUrl,
    fetch: outbound,
    clock,
    logger,
    ceilings: deps.ceilings,
    futureResources,
  });
  const notices = new NoticeStore(deps.sessions);
  const handlers = createAccountHandlers({
    publicUrl: deps.config.publicUrl,
    authenticator: deps.authenticator,
    accounts: service,
    notices,
    logger,
    connectFile: (providerId, file) =>
      readConnectFile(
        {
          registry: deps.registry,
          inventory:
            deps.pluginEntries ?? bundledInventory(deps.registry.all().map((r) => r.plugin)),
        },
        providerId,
        file,
      ),
  });
  const discoveryAfterCall = new DiscoveryAfterCall({
    registry: deps.registry,
    service,
    logger,
  });
  const unserved = deps.registry
    .brokerProviders()
    .filter((provider) => brokers.forProvider(provider) === null);
  if (unserved.length > 0) {
    logger.info('plugins need an OAuth broker that is not configured; listed as not configured', {
      broker_providers: unserved,
    });
  }
  const hourlyDiscovery = new HourlyDiscovery({
    missions: deps.store.missions,
    service,
    logger,
    clock,
    timers: deps.discoveryTimers,
  });
  return {
    service,
    credentials,
    notices,
    handlers,
    discoveryAfterCall,
    futureResources,
    hourlyDiscovery,
  };
}

export {
  CredentialBroker,
  REFRESH_SKEW_MS,
  type CredentialBrokerDeps,
  type ResolvedCredential,
} from './credentials';
export {
  CredentialFormatError,
  parseSecret,
  parseStoredCredential,
  serializeSecret,
  type BrokerGrant,
  type StoredCredential,
} from './credential-codec';
export {
  OAUTH_CLIENT_KEY_PREFIX,
  OAuth2ClientMissing,
  OAuth2Clients,
  REGISTERED_CLIENT_NAME,
  registeredClientKey,
} from './oauth2-clients';
export {
  FutureResources,
  type FutureResourcesDeps,
  type ResourceSnapshot,
} from './future-resources';
export {
  HOURLY_DISCOVERY_INTERVAL_MS,
  HourlyDiscovery,
  type DiscoveryTimers,
  type HourlyDiscoveryDeps,
  type HourlyDiscoveryRun,
} from './hourly-discovery';
export {
  DISCOVERY_AFTER_CALL_RETRY_DELAYS_MS,
  DiscoveryAfterCall,
  type AnsweredCall,
  type DiscoveryAfterCallDeps,
  type ScheduledCause,
} from './discovery-after-call';
export {
  CONNECT_ERROR_CODES,
  CONNECT_ERROR_MESSAGES,
  ConnectError,
  AccountUnavailableError,
  isConnectError,
  OAuthBrokerUnavailableError,
  ProviderUnreachableError,
  type ConnectErrorCode,
} from './errors';
export {
  BROKER_REQUEST_TIMEOUT_MS,
  brokerNotConfiguredReason,
  challengeOf,
  OAuthBrokerClient,
  OAuthBrokerError,
  OAuthBrokers,
  type BrokerCall,
  type FlowRequest,
  type FreshToken,
  type RedeemedGrant,
} from './oauth-broker';
export {
  actorOf,
  connectPagePath,
  accountPath,
  ALTERNATIVE_FIELD,
  FIELD_PREFIX,
  METADATA_PREFIX,
  NEW_ACCOUNT_PATH,
  NOTICE_PARAM,
  OWNERLESS_ACCOUNTS_PAGE,
  REASSIGN_ACTION_PATH,
  REASSIGN_PATH,
  type AccountHandlers,
} from './handlers';
export {
  askedFields,
  chooseAlternative,
  cleanName,
  echoOfForm,
  editableMetadataKeys,
  parseEnvLabel,
  parseListValue,
  readCredentialFields,
  readCredentialForm,
  resolveReturnTo,
  type FieldProblem,
  type FormEcho,
  type FormFields,
} from './input';
export {
  buildAuthorizationUrl,
  codeChallengeS256,
  exchangeCode,
  newCodeVerifier,
  newState,
  OAuth2TokenError,
  refreshGrant,
  type OAuth2Client,
} from './oauth2';
export {
  createNoticeRedirect,
  type NoticeRedirect,
  type NoticeRedirectDeps,
} from './notice-redirect';
export {
  CONNECT_TTL_MS,
  NoticeStore,
  PendingConnectStore,
  type Notice,
  type NoticeTone,
  type PendingConnect,
} from './pending';
export {
  CONNECT_RATE_LIMIT,
  CONNECT_RATE_WINDOW_MS,
  ACCOUNTS_PATH,
  AccountService,
  ownerActRefusal,
  toPluginResource,
  type Actor,
  type ConnectableProvider,
  type AlternativeView,
  type GuideFigureView,
  type GuideStepView,
  type TokenGuideView,
  type TokenPermissionView,
  type Connected,
  type AccountDetail,
  type AccountView,
  type AfterCallDiscovery,
  type DiscoveryAfterCallCause,
  type DiscoveryRecord,
  type ImportedFrom,
  type ImportPastedInput,
  type ImportSshInput,
  type MissionResourceCheck,
  type MissionResourceMoves,
  type NewOwner,
  type ResourcePatch,
  type StartInput,
  type StartResult,
} from './service';
export {
  accountCredentialKind,
  accountOwnerOf,
  accountSummaryOf,
  type AccountSummary,
  type ResolvedAccountOwner,
} from './mapping';
export {
  generateEd25519KeyPair,
  importEd25519PrivateKey,
  SshKeyImportError,
  type SshKeyPair,
} from './ssh-keypair';
