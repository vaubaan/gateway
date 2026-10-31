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
import type { CeilingCheck } from '../limits';
import type { Logger } from '../logging';
import type { Store } from '../store';
import { systemClock, type Clock } from '../store/clock';
import { CredentialBroker } from './credentials';
import { DiscoveryAfterCall } from './discovery-after-call';
import { createConnectionHandlers, type ConnectionHandlers } from './handlers';
import { OAuth2Clients } from './oauth2-clients';
import { productionAttestationKit } from './attestation-kit';
import { OAuthBrokers } from './oauth-broker';
import { NoticeStore, PendingConnectStore } from './pending';
import { ConnectionService } from './service';

export interface ConnectionsModuleDeps {
  readonly config: InstanceConfig;
  readonly store: Store;
  readonly registry: PluginRegistry;
  readonly sessions: SessionStore;
  readonly rateLimiter: RateLimiter;
  readonly authenticator: Authenticator;
  /** Watches the missions of a connection across its revocation, transfer or reassignment. */
  readonly grounds: Pick<MissionGrounds, 'watchConnection'>;
  readonly logger: Logger;
  /** Outbound HTTP of the connect flows and of the plugins' discovery (tests inject a mock). */
  readonly fetch?: typeof fetch;
  readonly clock?: Clock;
  /** The `limits.connections` ceiling (`root.limits`); absent, none. */
  readonly ceilings?: CeilingCheck;
}

export interface ConnectionsModule {
  readonly service: ConnectionService;
  /** Decrypted credentials and their refresh — the hook the execution door calls. */
  readonly credentials: CredentialBroker;
  readonly notices: NoticeStore;
  readonly handlers: ConnectionHandlers;
  /**
   * Runs a connection's discovery after a call that created one of its
   * resources (ADR created-resources-join-the-mission): the execution door's
   * hook, stopped by `root.close()`.
   */
  readonly discoveryAfterCall: DiscoveryAfterCall;
}

export function createConnectionsModule(deps: ConnectionsModuleDeps): ConnectionsModule {
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger.child({ component: 'connections' });
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
    connections: deps.store.connections,
    registry: deps.registry,
    clients,
    brokers,
    fetch: outbound,
    clock,
    logger,
  });
  const service = new ConnectionService({
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
  });
  const notices = new NoticeStore(deps.sessions);
  const handlers = createConnectionHandlers({
    publicUrl: deps.config.publicUrl,
    authenticator: deps.authenticator,
    connections: service,
    notices,
    logger,
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
  return { service, credentials, notices, handlers, discoveryAfterCall };
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
  connectionPath,
  FIELD_PREFIX,
  METADATA_PREFIX,
  NEW_CONNECTION_PATH,
  NOTICE_PARAM,
  OWNERLESS_CONNECTIONS_PAGE,
  REASSIGN_ACTION_PATH,
  REASSIGN_PATH,
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
