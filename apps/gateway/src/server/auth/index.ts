/**
 * Human authentication (spec §6 "human authentication", §4.2 Administration,
 * §7.1): OIDC relying party, web sessions, bootstrap token, groups from
 * claims, admin rule. Built once by the composition root as `root.auth`.
 * Handbook: docs/handbook/authentication.md. ADR: oidc-relying-party-and-web-session.
 */
import type { SessionStore } from '../compose/ports';
import type { InstanceConfig } from '../config/types';
import type { Logger } from '../logging';
import type { Store } from '../store';
import { systemClock, type Clock } from '../store/clock';
import type { UserRecord } from '../store/types';
import { Authenticator } from './authenticator';
import { BootstrapService } from './bootstrap';
import { createAuthHandlers, type AuthHandlers } from './handlers';
import { IdpSettingsService } from './idp-settings';
import {
  createRelyingPartyFactory,
  type CustomFetch,
  type RelyingPartyFactory,
} from './relying-party';
import { SessionService } from './session-service';

export interface OidcOptions {
  /** Routes the relying party's outbound HTTP (corporate proxy; in-process IdP in tests). */
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
  /** Settles what a membership lost at sign-in held (`MembershipSettler`, handbook authority). */
  readonly membershipsSynced?: (user: UserRecord) => Promise<void>;
}

export interface AuthModule {
  readonly sessions: SessionService;
  readonly idp: IdpSettingsService;
  readonly bootstrap: BootstrapService;
  readonly relyingParties: RelyingPartyFactory;
  readonly authenticator: Authenticator;
  readonly handlers: AuthHandlers;
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
  const authenticator = new Authenticator(sessions, deps.store, deps.config.admin, bootstrap);
  const handlers = createAuthHandlers({
    publicUrl: deps.config.publicUrl,
    sessions,
    idp,
    bootstrap,
    relyingParties,
    authenticator,
    login: {
      store: deps.store,
      adminRule: deps.config.admin,
      bootstrap,
      logger,
      clock,
      membershipsSynced: deps.membershipsSynced,
    },
    audit: deps.store.auditWriter,
    logger,
    clock,
  });
  return { sessions, idp, bootstrap, relyingParties, authenticator, handlers };
}

export { describeAdminRule, isOperator, type AdminRuleSubject } from './admin-rule';
export {
  auditActorId,
  Authenticator,
  type AdminDecision,
  type BootstrapPrincipal,
  type Principal,
  type UserPrincipal,
} from './authenticator';
export { BOOTSTRAP_REVOKED_KEY, BootstrapService, type BootstrapState } from './bootstrap';
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
  adminSignInPage,
  BOOTSTRAP_PAGE,
  IDP_PAGE,
  LOGIN_PAGE,
  safeReturnTo,
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
  type LoginOutcome,
} from './login';
export { forbiddenOriginResponse, isSameOrigin, requestOrigin } from './origin';
export {
  CALLBACK_PATH,
  callbackUrl,
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
