/**
 * Human authentication (spec §6 "human authentication", §4.2 Administration,
 * §7.1): OIDC relying party, web sessions, bootstrap token, groups from
 * claims, admin rule. Built once by the composition root as `root.auth`.
 * Handbook: docs/handbook/authentication.md. ADR: oidc-relying-party-and-web-session.
 */
import type { RateLimiter, SessionStore } from '../compose/ports';
import { clientIpResolver } from '../http/client-ip';
import type { InstanceConfig } from '../config/types';
import type { Logger } from '../logging';
import type { Store } from '../store';
import { systemClock, type Clock } from '../store/clock';
import { AdministratorsService } from './administrators';
import { Authenticator } from './authenticator';
import { BootstrapService } from './bootstrap';
import { createAuthHandlers, type AuthHandlers } from './handlers';
import { LocalAccountsService } from './local-accounts';
import { createLocalAuthHandlers, type LinkMailer, type LocalAuthHandlers } from './local-handlers';
import { IdpSettingsService } from './idp-settings';
import { createSignInFlows, type SignInFlows } from './sign-in-flows';
import { SignInProvidersService } from './sign-in-providers';
import type { LoginDeps } from './login';
import {
  createRelyingPartyFactory,
  type CustomFetch,
  type RelyingPartyFactory,
} from './relying-party';
import { SessionService } from './session-service';

export interface OidcOptions {
  /**
   * Routes the outbound HTTP of every sign-in — OpenID Connect discovery, tokens and
   * userinfo, GitHub's token endpoint and API (corporate proxy; in-process providers
   * in tests).
   */
  readonly fetch?: CustomFetch;
  /** Tests only: accept an `http://` issuer. */
  readonly allowInsecureIssuer?: boolean;
}

export interface AuthModuleDeps {
  readonly config: InstanceConfig;
  readonly store: Store;
  readonly sessions: SessionStore;
  readonly logger: Logger;
  readonly clock?: Clock;
  readonly oidc?: OidcOptions;
  /** Watches the user's memberships across a sign-in (`MembershipSettler`, handbook authority). */
  readonly membershipsChanging?: LoginDeps['membershipsChanging'];
  /** The limits of the sign-in start, the callbacks and the bootstrap endpoint. */
  readonly rateLimiter: RateLimiter;
  /** Sends the mails of the local accounts' links; absent when the instance sends no mail. */
  readonly mailer?: LinkMailer;
}

export interface AuthModule {
  readonly sessions: SessionService;
  /** The single-provider settings saved from the interface (the provider `idp`). */
  readonly idp: IdpSettingsService;
  /** Every sign-in provider: the configuration's and the ones saved in Settings → Sign-in. */
  readonly providers: SignInProvidersService;
  /** Who administers the instance: the designations of the store (ADR administrators-live-in-the-instance). */
  readonly administrators: AdministratorsService;
  readonly flows: SignInFlows;
  readonly bootstrap: BootstrapService;
  readonly relyingParties: RelyingPartyFactory;
  readonly authenticator: Authenticator;
  /** The sign-in endpoints, the forms of the local accounts (`LocalAuthHandlers`) included. */
  readonly handlers: AuthHandlers & LocalAuthHandlers;
  /** The accounts of a sign-in provider of kind `local`, and their links. */
  readonly accounts: LocalAccountsService;
  /** Whether the instance sends the mails of the links (a mailer was configured). */
  readonly sendsMail: boolean;
}

export function createAuthModule(deps: AuthModuleDeps): AuthModule {
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger.child({ component: 'auth' });
  const sessions = new SessionService(deps.sessions, clock);
  const idp = new IdpSettingsService(deps.config.idp, deps.store.config, {
    allowInsecureIssuer: deps.oidc?.allowInsecureIssuer,
  });
  const bootstrap = new BootstrapService(deps.config.bootstrapToken, deps.store.config, clock);
  const relyingParties = createRelyingPartyFactory({
    publicUrl: deps.config.publicUrl,
    fetch: deps.oidc?.fetch,
    allowInsecureRequests: deps.oidc?.allowInsecureIssuer,
  });
  const providers = new SignInProvidersService(
    deps.config,
    async () =>
      (await deps.store.administrators.list()).flatMap((d) =>
        d.kind === 'group' && d.provider === null ? [d.groupName] : [],
      ),
    idp,
    deps.store.config,
    clock,
    {
      allowInsecureIssuer: deps.oidc?.allowInsecureIssuer,
      checkIssuer: (issuer) => relyingParties.checkIssuer(issuer),
    },
  );
  const flows = createSignInFlows({
    publicUrl: deps.config.publicUrl,
    relyingParties,
    fetch: deps.oidc?.fetch,
  });
  const administrators = new AdministratorsService({
    store: deps.store,
    providers: () => providers.views(),
    rule: deps.config.admin,
    audit: deps.store.auditWriter,
    logger: logger.child({ component: 'administrators' }),
    clock,
  });
  const authenticator = new Authenticator(
    sessions,
    deps.store,
    administrators,
    bootstrap,
    providers,
  );
  const clientIp = clientIpResolver(deps.config.trustedProxies, deps.config.clientIpHeader);
  const accounts = new LocalAccountsService({
    store: deps.store,
    audit: deps.store.auditWriter,
    clock,
    logger: logger.child({ component: 'local-accounts' }),
    publicUrl: deps.config.publicUrl,
  });
  const localHandlers = createLocalAuthHandlers({
    publicUrl: deps.config.publicUrl,
    instanceLabel: deps.config.instanceName ?? deps.config.publicUrl.host,
    sessions,
    sessionStore: deps.sessions,
    authenticator,
    providers,
    accounts,
    login: {
      store: deps.store,
      bootstrap,
      logger,
      clock,
      membershipsChanging: deps.membershipsChanging,
    },
    store: deps.store,
    administrators,
    logger,
    clock,
    rateLimiter: deps.rateLimiter,
    clientIp,
    mailer: deps.mailer,
  });
  const handlers = createAuthHandlers({
    publicUrl: deps.config.publicUrl,
    sessions,
    providers,
    flows,
    bootstrap,
    authenticator,
    store: deps.store,
    administrators,
    login: {
      store: deps.store,
      bootstrap,
      logger,
      clock,
      membershipsChanging: deps.membershipsChanging,
    },
    audit: deps.store.auditWriter,
    logger,
    clock,
    rateLimiter: deps.rateLimiter,
    clientIp,
    checkIssuer: (issuer) => relyingParties.checkIssuer(issuer),
  });
  return {
    sessions,
    idp,
    providers,
    administrators,
    flows,
    bootstrap,
    relyingParties,
    authenticator,
    handlers: { ...handlers, ...localHandlers },
    accounts,
    sendsMail: deps.mailer !== undefined,
  };
}

export {
  ADMINISTRATORS_ERROR_CODES,
  ADMINISTRATORS_ERROR_MESSAGES,
  ADMINISTRATORS_OBJECT_ID,
  AdministratorsError,
  AdministratorsService,
  designationView,
  groupsOfProvider,
  isOperator,
  pendingEmailNames,
  resolveAdministrators,
  resolveGroupDesignation,
  SEEDED_RULE_KEY,
  type AdministratorsErrorCode,
  type AdministratorSubject,
  type ConfigurationDrift,
  type ResolvedAdministrators,
} from './administrators';
export { admit, type AdmissionContext, type AdmissionReason } from './admission';
export { GithubSignIn, readableTeams } from './github';
export {
  createSignInFlows,
  type FinishedSignIn,
  type SignInFlow,
  type SignInFlows,
} from './sign-in-flows';
export {
  signInAuditObjectId,
  signInProviderAuditView,
  SignInProvidersService,
  type EffectiveSignInProvider,
  type SaveMode,
  type SignInProviderInput,
  type SignInProviderView,
  type ProviderState,
  type ProviderTestRecord,
  testPassedSinceSaved,
} from './sign-in-providers';
export {
  auditActorId,
  Authenticator,
  type AdminDecision,
  type BootstrapPrincipal,
  type Principal,
  type UserPrincipal,
} from './authenticator';
export {
  BOOTSTRAP_MAX_MISSES,
  BOOTSTRAP_MISSES_KEY,
  BOOTSTRAP_REVOKED_KEY,
  BootstrapService,
  type BootstrapState,
} from './bootstrap';
export {
  assertEmailDomainAllowed,
  mapClaims,
  parseGroupsClaim,
  type IdentityClaims,
  type RawClaims,
} from './claims';
export { clearCookie, LOGIN_COOKIE, readCookie, serializeCookie, SESSION_COOKIE } from './cookies';
export {
  IdpSettingsError,
  isLoginErrorCode,
  LOGIN_ERROR_CODES,
  LOGIN_ERROR_MESSAGES,
  LoginError,
  type LoginErrorCode,
} from './errors';
export {
  guardMutation,
  guardSession,
  OPERATOR_REFUSALS,
  refusalResponse,
  type GuardDeps,
  type GuardRefusal,
  type GuardRefusalReason,
  type GuardResult,
  type GuardRole,
  type RefusalWording,
  type SessionGuardDeps,
} from './guard';
export {
  ADMIN_PAGE,
  AUTH_LIMITS,
  adminSignInPage,
  BOOTSTRAP_PAGE,
  IDP_PAGE,
  LOGIN_PAGE,
  NEW_SIGN_IN_PROVIDER_PAGE,
  safeReturnTo,
  signInProviderPage,
  signInStartPath,
  signInTestPage,
  signInTestPath,
  statusResponse,
  type AuthHandlers,
} from './handlers';
export {
  DEFAULT_CLAIM_MAPPING,
  IDP_CONFIG_KEYS,
  IdpSettingsService,
  splitList,
  type EffectiveIdp,
  type IdpSettingsInput,
  type IdpSource,
} from './idp-settings';
export {
  completeLogin,
  currentAuthority,
  syncIdpGroups,
  type Authority,
  type LoginContext,
  type LoginOutcome,
} from './login';
export { forbiddenOriginResponse, isSameOrigin, requestOrigin } from './origin';
export {
  CALLBACK_PATH,
  callbackUrl,
  type RelyingPartySettings,
  createRelyingPartyFactory,
  type CustomFetch,
  type OidcRelyingParty,
  type RelyingPartyFactory,
} from './relying-party';
export {
  isPendingLogin,
  isWebSessionRecord,
  LOGIN_TTL_MS,
  SESSION_TTL_MS,
  SessionService,
  type PendingLogin,
  type WebSessionRecord,
} from './session-service';
export {
  CREATE_ACCOUNT_PAGE,
  FORGOT_PASSWORD_PAGE,
  LINK_TOKEN_PARAM,
  LOCAL_LINK_TTL_MS,
  LOCAL_LOCKOUT,
  LocalAccountsService,
  localAccountsObjectId,
  normalizeLocalEmail,
  RESET_PASSWORD_PAGE,
  type IssuedLink,
  type PasswordCheck,
} from './local-accounts';
export {
  ACCOUNT_ERROR_PARAM,
  createLocalAuthHandlers,
  ENROL_PAGE,
  ENROL_PARAM,
  FORGOT_SENT_PARAM,
  FRESH_SIGN_IN_FOR_FACTOR_MS,
  localAccountIdOf,
  localIdentity,
  RESET_DONE_PARAM,
  SECOND_FACTOR_PAGE,
  SECURITY_PAGE,
  type LinkMailer,
  type LocalAuthHandlers,
} from './local-handlers';
export {
  LOCAL_ACCOUNT_ERROR_CODES,
  LOCAL_ACCOUNT_ERROR_MESSAGES,
  LocalAccountError,
  type LocalAccountErrorCode,
} from './errors';
