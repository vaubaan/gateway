/**
 * Connections (spec §0 "Connection", "Resource"; §2.3; §4.2; §6 anti-replay;
 * §7.2): the generic connect driver over `CredentialSpec`, the resources of a
 * connection, the credential broker with its generic OAuth refresh, and the
 * HTTP handlers. Built once by the composition root as `root.connections`.
 * Handbook: docs/handbook/connections.md.
 */
import type { PluginRegistry } from '@vaubaan/plugin-sdk';

import type { Authenticator } from '../auth/authenticator';
import type { MissionGrounds } from '../authority';
import type { RateLimiter, SessionStore } from '../compose/ports';
import type { InstanceConfig } from '../config/types';
import type { Logger } from '../logging';
import type { ProviderAppsService } from '../provider-apps';
import type { Store } from '../store';
import { systemClock, type Clock } from '../store/clock';
import { CredentialBroker } from './credentials';
import { DiscoveryAfterCall } from './discovery-after-call';
import { createConnectionHandlers, type ConnectionHandlers } from './handlers';
import { OAuth2Clients } from './oauth2-clients';
import { NoticeStore, PendingConnectStore } from './pending';
import { ConnectionService } from './service';

export interface ConnectionsModuleDeps {
  readonly config: InstanceConfig;
  readonly store: Store;
  readonly registry: PluginRegistry;
  readonly providerApps: ProviderAppsService;
  readonly sessions: SessionStore;
  readonly rateLimiter: RateLimiter;
  readonly authenticator: Authenticator;
  /** Watches the missions of a connection across its revocation, transfer or reassignment. */
  readonly grounds: Pick<MissionGrounds, 'watchConnection'>;
  readonly logger: Logger;
  /** Outbound HTTP of the connect flows and of the plugins' discovery (tests inject a mock). */
  readonly fetch?: typeof fetch;
  readonly clock?: Clock;
}

export interface ConnectionsModule {
  readonly service: ConnectionService;
  /** Decrypted credentials and their refresh — the hook the execution door calls. */
  readonly credentials: CredentialBroker;
  readonly notices: NoticeStore;
  readonly handlers: ConnectionHandlers;
  /**
   * Runs a connection's discovery after a call that created one of its
   * resources (ADR discovery-runs-after-a-creating-call): the execution door's
   * hook, stopped by `root.close()`.
   */
  readonly discoveryAfterCall: DiscoveryAfterCall;
}

export function createConnectionsModule(deps: ConnectionsModuleDeps): ConnectionsModule {
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger.child({ component: 'connections' });
  const outbound: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const clients = new OAuth2Clients({
    providerApps: deps.providerApps,
    config: deps.store.config,
    publicUrl: deps.config.publicUrl,
    fetch: outbound,
    clock,
    logger,
  });
  const credentials = new CredentialBroker({
    connections: deps.store.connections,
    registry: deps.registry,
    providerApps: deps.providerApps,
    clients,
    fetch: outbound,
    clock,
    logger,
  });
  const service = new ConnectionService({
    store: deps.store,
    registry: deps.registry,
    providerApps: deps.providerApps,
    clients,
    broker: credentials,
    grounds: deps.grounds,
    pending: new PendingConnectStore(deps.sessions),
    rateLimiter: deps.rateLimiter,
    audit: deps.store.auditWriter,
    publicUrl: deps.config.publicUrl,
    fetch: outbound,
    clock,
    logger,
  });
  const notices = new NoticeStore(deps.sessions);
  const handlers = createConnectionHandlers({
    publicUrl: deps.config.publicUrl,
    authenticator: deps.authenticator,
    connections: service,
    registry: deps.registry,
    providerApps: deps.providerApps,
    notices,
    audit: deps.store.auditWriter,
    logger,
    clock,
  });
  const discoveryAfterCall = new DiscoveryAfterCall({
    registry: deps.registry,
    service,
    logger,
  });
  return { service, credentials, notices, handlers, discoveryAfterCall };
}

export {
  CredentialBroker,
  REFRESH_SKEW_MS,
  type CredentialBrokerDeps,
  type ResolvedCredential,
} from './credentials';
export { CredentialFormatError, parseSecret, serializeSecret } from './credential-codec';
export {
  OAUTH_CLIENT_KEY_PREFIX,
  OAuth2ClientMissing,
  OAuth2Clients,
  REGISTERED_CLIENT_NAME,
  registeredClientKey,
} from './oauth2-clients';
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
  ConnectionUnavailableError,
  isConnectError,
  ProviderUnreachableError,
  type ConnectErrorCode,
} from './errors';
export {
  actorOf,
  CLEAR_PROVIDER_APP_ACTION,
  connectPagePath,
  PROVIDER_APP_ACTION_PATH,
  providerAppActionPath,
  connectionPath,
  FIELD_PREFIX,
  METADATA_PREFIX,
  NEW_CONNECTION_PATH,
  NOTICE_PARAM,
  OWNERLESS_CONNECTIONS_PAGE,
  type ConnectionHandlers,
} from './handlers';
export {
  cleanName,
  echoOfForm,
  editableMetadataKeys,
  parseEnvLabel,
  parseListValue,
  readCredentialFields,
  resolveReturnTo,
  type FieldProblem,
  type FormEcho,
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
  CONNECTIONS_PATH,
  ConnectionService,
  ownerActRefusal,
  toPluginResource,
  type Actor,
  type ConnectableProvider,
  type TokenGuideView,
  type TokenPermissionView,
  type ToolLabel,
  type Connected,
  type ConnectionDetail,
  type ConnectionView,
  type AfterCallDiscovery,
  type DiscoveryAfterCallCause,
  type DiscoveryRecord,
  type ImportedFrom,
  type ImportPastedInput,
  type ImportSshInput,
  type NewOwner,
  type ResourcePatch,
  type StartInput,
  type StartResult,
} from './service';
export {
  connectionCredentialKind,
  connectionOwnerOf,
  connectionSummaryOf,
  type ConnectionSummary,
  type ResolvedConnectionOwner,
} from './mapping';
export {
  generateEd25519KeyPair,
  importEd25519PrivateKey,
  SshKeyImportError,
  type SshKeyPair,
} from './ssh-keypair';
