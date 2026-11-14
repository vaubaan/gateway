/**
 * Users administration (spec §2.3; ADR operator-deactivates-a-user): the
 * operator's deactivation and reactivation of a user, without the identity
 * provider. Built once by the composition root as `root.users`. Handbook:
 * docs/handbook/authentication.md.
 */
import type { AdministratorsService } from '../auth/administrators';
import type { Authenticator } from '../auth/authenticator';
import type { BootstrapService } from '../auth/bootstrap';
import type { SecondFactorService } from '../auth/second-factor';
import type { SignInAccountsService } from '../auth/sign-in-accounts';
import type { LinkMailer } from '../auth/local-handlers';
import type { SessionService } from '../auth/session-service';
import type { SignInProvidersService } from '../auth/sign-in-providers';
import type { MembershipSettler } from '../authority';
import type { InstanceConfig } from '../config/types';
import type { AccountsModule } from '../accounts';
import type { CeilingCheck } from '../limits';
import type { Logger } from '../logging';
import type { MissionTeamService } from '../missions';
import type { Store } from '../store';
import { systemClock, type Clock } from '../store/clock';
import { createUserAdminHandlers, type UserAdminHandlers } from './handlers';
import { InvitationService } from './invitations';
import { UserAdminService } from './service';

export interface UsersModuleDeps {
  readonly config: Pick<InstanceConfig, 'publicUrl'>;
  /** The designations of the administrators. */
  readonly administrators: AdministratorsService;
  /** The second factor of every person: an administrator resets one from People. */
  readonly secondFactors: SecondFactorService;
  /** The install token the setup ends by revoking. */
  readonly bootstrap: Pick<BootstrapService, 'state' | 'revoke'>;
  /** Whether the generated master key still waits for its handover. */
  readonly masterKey: { state(): Promise<{ readonly handoverPending: boolean }> };
  readonly store: Store;
  readonly membership: Pick<MembershipSettler, 'watch'>;
  readonly memberTokens: Pick<MissionTeamService, 'revokeTokensOfDeactivated'>;
  readonly accounts: Pick<AccountsModule, 'notices'>;
  readonly authenticator: Authenticator;
  /** The web sessions: "sign out everywhere" clears the cookie of the browser it comes from. */
  readonly sessions: Pick<SessionService, 'destroy'>;
  /** The sign-in accounts and their links: an invitation also creates the account's link. */
  readonly signInAccounts: SignInAccountsService;
  readonly providers: Pick<SignInProvidersService, 'views'>;
  /** Sends the mails of the links; absent when the instance sends no mail. */
  readonly mailer?: LinkMailer;
  readonly logger: Logger;
  readonly clock?: Clock;
  /** The `limits.users` ceiling (`root.limits`); absent, none. */
  readonly ceilings?: CeilingCheck;
}

export interface UsersModule {
  readonly service: UserAdminService;
  /** The addresses administrators invited to sign in. */
  readonly invitations: InvitationService;
  readonly handlers: UserAdminHandlers;
}

export function createUsersModule(deps: UsersModuleDeps): UsersModule {
  const logger = deps.logger.child({ component: 'users' });
  const service = new UserAdminService({
    store: deps.store,
    membership: deps.membership,
    memberTokens: deps.memberTokens,
    audit: deps.store.auditWriter,
    clock: deps.clock ?? systemClock,
    logger,
    ceilings: deps.ceilings,
  });
  const invitations = new InvitationService({
    store: deps.store,
    audit: deps.store.auditWriter,
    clock: deps.clock ?? systemClock,
    logger,
    ceilings: deps.ceilings,
  });
  const handlers = createUserAdminHandlers({
    publicUrl: deps.config.publicUrl,
    authenticator: deps.authenticator,
    sessions: deps.sessions,
    users: service,
    invitations,
    signInAccounts: deps.signInAccounts,
    providers: deps.providers,
    administrators: deps.administrators,
    bootstrap: deps.bootstrap,
    secondFactors: deps.secondFactors,
    masterKey: deps.masterKey,
    audit: deps.store.auditWriter,
    clock: deps.clock ?? systemClock,
    mailer: deps.mailer,
    notices: deps.accounts.notices,
    logger,
  });
  return { service, invitations, handlers };
}

export {
  USER_ADMIN_ERROR_CODES,
  USER_ADMIN_ERROR_MESSAGES,
  UserAdminError,
  userLimitError,
  type UserAdminErrorCode,
} from './errors';
export {
  ADMIN_SETUP_PAGE,
  createUserAdminHandlers,
  FINISH_SETUP_ACTION,
  FIRST_ADMINISTRATOR_PAGE,
  setupCannotFinish,
  USERS_PAGE,
  type UserAdminHandlers,
} from './handlers';
export {
  INVITATIONS_OBJECT_ID,
  InvitationService,
  normalizeInvitedEmail,
  type InvitationView,
} from './invitations';
export {
  UserAdminService,
  type Deactivation,
  type Reactivation,
  type UserAdminActor,
  type UserAdminServiceDeps,
  type UserView,
} from './service';
