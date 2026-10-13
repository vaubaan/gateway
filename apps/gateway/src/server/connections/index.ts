/**
 * Connections (spec §0 "Connection", "Resource"; §2.3; §4.2; §6 anti-replay;
 * §7.2): the generic connect driver over `CredentialSpec`, the resources of a
 * connection, the credential broker with its generic OAuth refresh, and the
 * HTTP handlers. Built once by the composition root as `root.connections`.
 * Handbook: docs/handbook/connections.md.
 */
import type { PluginRegistry } from '@vaubaan/plugin-sdk';

import type { Authenticator } from '../auth/authenticator';
import type { RateLimiter, SessionStore } from '../compose/ports';
import type { InstanceConfig } from '../config/types';
import type { Logger } from '../logging';
import type { ProviderAppsService } from '../provider-apps';
import type { Store } from '../store';
import { systemClock, type Clock } from '../store/clock';
import { CredentialBroker } from './credentials';
import { createConnectionHandlers, type ConnectionHandlers } from './handlers';
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
}

export function createConnectionsModule(deps: ConnectionsModuleDeps): ConnectionsModule {
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger.child({ component: 'connections' });
  const outbound: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const credentials = new CredentialBroker({
    connections: deps.store.connections,
    registry: deps.registry,
    providerApps: deps.providerApps,
    fetch: outbound,
    clock,
    logger,
  });
  const service = new ConnectionService({
    store: deps.store,
    registry: deps.registry,
    providerApps: deps.providerApps,
    broker: credentials,
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
  return { service, credentials, notices, handlers };
}

export {
  CredentialBroker,
  REFRESH_SKEW_MS,
  type CredentialBrokerDeps,
  type ResolvedCredential,
} from './credentials';
export { CredentialFormatError, parseSecret, serializeSecret } from './credential-codec';
export {
  CONNECT_ERROR_CODES,
  CONNECT_ERROR_MESSAGES,
  ConnectError,
  ConnectionUnavailableError,
  ProviderUnreachableError,
  type ConnectErrorCode,
} from './errors';
export {
  ACCEPT_UNVERIFIED_ACTION,
  actorOf,
  connectionPath,
  FIELD_PREFIX,
  METADATA_PREFIX,
  NEW_CONNECTION_PATH,
  NOTICE_PARAM,
  PROVIDER_APPS_PAGE,
  REFUSE_UNVERIFIED_ACTION,
  type ConnectionHandlers,
} from './handlers';
export {
  InstallationRefused,
  InstallationVerificationUnavailable,
  MAX_INSTALLATION_PAGES,
  verifyInstallation,
  type InstallationClaim,
  type InstallationRefusalReason,
} from './install-verification';
export {
  cleanName,
  editableMetadataKeys,
  parseEnvLabel,
  parseListValue,
  readCredentialFields,
  resolveReturnTo,
} from './input';
export {
  buildAuthorizationUrl,
  codeChallengeS256,
  exchangeCode,
  exchangeUnsolicitedCode,
  newCodeVerifier,
  newState,
  OAuth2TokenError,
  refreshGrant,
  type OAuth2Client,
} from './oauth2';
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
  toPluginResource,
  type Actor,
  type ConnectableProvider,
  type ConnectRefusalReason,
  type Connected,
  type ConnectionDetail,
  type ConnectionView,
  type DiscoveryRecord,
  type InstallationBinding,
  type ResourcePatch,
  type StartInput,
  type StartResult,
} from './service';
export {
  connectionOwnerOf,
  connectionSummaryOf,
  type ConnectionSummary,
  type ResolvedConnectionOwner,
} from './mapping';
export { generateEd25519KeyPair, type SshKeyPair } from './ssh-keypair';
