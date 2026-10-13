/**
 * Authorization server of the management door (feature P2.3; spec §0
 * "Delegation", §4.1 bis, §6 "three credentials", "short, traceable delegated
 * tokens"). The instance issues delegated tokens itself, relying on the IdP
 * for the user's identity at consent time. Built once by the composition root
 * as `root.oauth`; `root.management` is the admission gate of `/mcp/manage`
 * with its placeholder door (the door's tools are feature P2.4).
 * Handbook: docs/handbook/management-door.md.
 * ADR: docs/decisions/management-door-authorization-server.md.
 */
import type { Authenticator, SessionService as WebSessionService } from '../auth';
import type { RateLimiter, SessionStore } from '../compose/ports';
import type { BuildInfo, InstanceConfig } from '../config';
import type { TokenVerifier } from '../execution/token-verifier';
import { clientIpResolver } from '../http/client-ip';
import type { Logger } from '../logging';
import type { Store } from '../store';
import { systemClock, type Clock } from '../store/clock';
import { AuthorizationService } from './authorization';
import {
  createClientDocumentFetcher,
  type ClientDocumentFetcher,
} from './client-metadata-document';
import { ClientRegistry } from './clients';
import { DelegationService } from './delegations';
import { oauthEndpoints, type OAuthEndpoints } from './endpoints';
import { createOAuthHandlers, type OAuthHandlers } from './handlers';
import { ManagementGate } from './management-gate';
import { ManagementDoorPlaceholder } from './placeholder-door';
import { TokenService } from './token-service';
import { DelegatedTokenVerifier } from './verifier';

export interface OAuthAsModuleDeps {
  readonly config: Pick<InstanceConfig, 'publicUrl' | 'trustedProxies' | 'oauth'>;
  readonly store: Pick<Store, 'delegations' | 'users' | 'missions' | 'auditWriter'>;
  /** Where a consent waits for its answer: the root's `SessionStore` port. */
  readonly sessions: SessionStore;
  readonly authenticator: Authenticator;
  readonly rateLimiter: RateLimiter;
  readonly logger: Logger;
  readonly clock?: Clock;
  /** Outbound fetch of Client ID Metadata Documents (tests inject a fake). */
  readonly fetchClientDocument?: ClientDocumentFetcher;
}

export interface OAuthAsModule {
  readonly endpoints: OAuthEndpoints;
  readonly clients: ClientRegistry;
  readonly authorization: AuthorizationService;
  readonly tokens: TokenService;
  readonly delegations: DelegationService;
  /** What a delegated access token is worth: for the management door, and for the execution door to refuse it by kind. */
  readonly verifier: DelegatedTokenVerifier;
  readonly handlers: OAuthHandlers;
}

export function createOAuthAsModule(deps: OAuthAsModuleDeps): OAuthAsModule {
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger.child({ component: 'oauth-as' });
  const { config, store } = deps;
  const endpoints = oauthEndpoints(config.publicUrl);
  const audit = store.auditWriter;

  const clients = new ClientRegistry({
    repo: store.delegations,
    config: config.oauth.clientRegistration,
    audit,
    rateLimiter: deps.rateLimiter,
    clock,
    logger,
    // No fetcher exists unless the operator asked for metadata documents.
    fetchDocument: config.oauth.clientRegistration.metadataDocuments
      ? (deps.fetchClientDocument ?? createClientDocumentFetcher())
      : undefined,
  });
  const authorization = new AuthorizationService({
    clients,
    repo: store.delegations,
    pending: deps.sessions,
    audit,
    endpoints,
    clock,
    logger,
  });
  const tokens = new TokenService({
    repo: store.delegations,
    users: store.users,
    clients,
    audit,
    endpoints,
    config: config.oauth,
    clock,
    logger,
  });
  const delegations = new DelegationService({
    repo: store.delegations,
    missions: store.missions,
    clients,
    audit,
    clock,
    logger,
  });
  const verifier = new DelegatedTokenVerifier({
    repo: store.delegations,
    users: store.users,
    endpoints,
  });
  const handlers = createOAuthHandlers({
    publicUrl: config.publicUrl,
    config: config.oauth,
    endpoints,
    authenticator: deps.authenticator,
    rateLimiter: deps.rateLimiter,
    clientIp: clientIpResolver(config.trustedProxies),
    clients,
    authorization,
    tokens,
    delegations,
    logger,
  });
  return { endpoints, clients, authorization, tokens, delegations, verifier, handlers };
}

export interface ManagementDoorModuleDeps {
  readonly config: Pick<InstanceConfig, 'publicUrl' | 'trustedProxies'>;
  readonly oauth: Pick<OAuthAsModule, 'endpoints' | 'verifier'>;
  /** The execution door's verifier: a mission token presented here is refused by kind. */
  readonly missionTokens: Pick<TokenVerifier, 'verify'>;
  readonly webSessions: Pick<WebSessionService, 'read'>;
  readonly build: BuildInfo;
  readonly logger: Logger;
}

export interface ManagementDoorHandlers {
  /** `/mcp/manage` — MCP Streamable HTTP. */
  readonly mcp: (request: Request) => Promise<Response>;
}

export interface ManagementDoorModule {
  /** Admission of `/mcp/manage`: the part feature P2.4 keeps. */
  readonly gate: ManagementGate;
  readonly handlers: ManagementDoorHandlers;
}

/**
 * The management door as far as P2.3 goes: the admission gate, and a
 * placeholder MCP server with no tool behind it (see `placeholder-door.ts`).
 */
export function createManagementDoorModule(deps: ManagementDoorModuleDeps): ManagementDoorModule {
  const logger = deps.logger.child({ component: 'management-door' });
  const gate = new ManagementGate({
    config: deps.config,
    endpoints: deps.oauth.endpoints,
    verifier: deps.oauth.verifier,
    missionTokens: deps.missionTokens,
    webSessions: deps.webSessions,
    logger,
  });
  const placeholder = new ManagementDoorPlaceholder({ gate, build: deps.build, logger });
  return { gate, handlers: { mcp: (request) => placeholder.handle(request) } };
}

export {
  AUTHORIZATION_CODE_TTL_MS,
  authorizationResponseUrl,
  AuthorizationService,
  CONSENT_TTL_MS,
  MAX_STATE_LENGTH,
  type AuthorizationRequest,
  type ConsentDecision,
  type ConsentOutcome,
  type PendingConsent,
} from './authorization';
export {
  checkClientIdUrl,
  cleanClientName,
  ClientDocumentError,
  createClientDocumentFetcher,
  isClientIdUrl,
  isPublicAddress,
  parseClientDocument,
  publicOnlyLookup,
  type ClientDocument,
  type ClientDocumentFetcher,
  type FetchedDocument,
} from './client-metadata-document';
export {
  ClientRegistry,
  registrationResponse,
  UNNAMED_CLIENT,
  UNUSED_CLIENT_RETENTION_MS,
  type ClientStatus,
  type ClientView,
  type RegisteredClient,
} from './clients';
export {
  DelegationService,
  type DelegationState,
  type DelegationView,
  type RevokeDelegationResult,
} from './delegations';
export {
  AUTHORIZATION_SERVER_METADATA_PATH,
  AUTHORIZE_PATH,
  authorizationServerMetadata,
  CONSENT_DECISION_PATH,
  isManagementResource,
  MANAGEMENT_DOOR_PATH,
  MANAGEMENT_SCOPE,
  oauthEndpoints,
  PROTECTED_RESOURCE_METADATA_PATH,
  protectedResourceMetadata,
  REGISTER_PATH,
  REVOKE_PATH,
  TOKEN_PATH,
  type OAuthEndpoints,
} from './endpoints';
export {
  AuthorizationPageError,
  AuthorizationRedirectError,
  OAuthProtocolError,
  type OAuthErrorCode,
} from './errors';
export {
  createOAuthHandlers,
  DELEGATIONS_PAGE,
  MAX_REQUEST_BYTES,
  OAUTH_CLIENTS_PAGE,
  REGISTRATION_WINDOW_MS,
  REGISTRATIONS_PER_WINDOW,
  TOKEN_REQUESTS_PER_WINDOW,
  TOKEN_WINDOW_MS,
  type OAuthHandlers,
} from './handlers';
export { ManagementGate, type AdmittedDelegation } from './management-gate';
export { CONSENT_FIELD, consentPage, DECISION_FIELD, escapeHtml, messagePage } from './pages';
export { challengeOf, isCodeChallenge, isCodeVerifier, verifyS256 } from './pkce';
export { MANAGEMENT_SERVER_INFO_NAME, ManagementDoorPlaceholder } from './placeholder-door';
export {
  checkRedirectUri,
  isLoopbackHost,
  isLoopbackOnly,
  matchesRegisteredRedirect,
  redirectDestination,
  type RedirectKind,
} from './redirect-uri';
export {
  ACCESS_TOKEN_PREFIX,
  CLIENT_ID_PREFIX,
  CLIENT_SECRET_PREFIX,
  digestOf,
  isAccessTokenShaped,
  isRefreshTokenShaped,
  matchesDigest,
  REFRESH_TOKEN_PREFIX,
} from './secrets';
export {
  clientCredentialsOf,
  TokenService,
  type ClientCredentials,
  type TokenResponse,
} from './token-service';
export { DELEGATION_AUTH_INFO_KEY, DelegatedTokenVerifier } from './verifier';
