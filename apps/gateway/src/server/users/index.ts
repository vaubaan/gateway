/**
 * Users administration (spec §2.3; ADR operator-deactivates-a-user): the
 * operator's deactivation and reactivation of a user, without the identity
 * provider. Built once by the composition root as `root.users`. Handbook:
 * docs/handbook/authentication.md, "Deactivating a user".
 */
import type { Authenticator } from '../auth/authenticator';
import type { SessionService } from '../auth/session-service';
import type { MembershipSettler } from '../authority';
import type { InstanceConfig } from '../config/types';
import type { ConnectionsModule } from '../connections';
import type { Logger } from '../logging';
import type { MissionTeamService } from '../missions';
import type { DelegationService } from '../oauth-as';
import type { Store } from '../store';
import { systemClock, type Clock } from '../store/clock';
import { createUserAdminHandlers, type UserAdminHandlers } from './handlers';
import { InvitationService } from './invitations';
import { UserAdminService } from './service';

export interface UsersModuleDeps {
  readonly config: Pick<InstanceConfig, 'publicUrl'>;
  readonly store: Store;
  readonly membership: Pick<MembershipSettler, 'watch'>;
  readonly delegations: Pick<DelegationService, 'revokeAllOf'>;
  readonly memberTokens: Pick<MissionTeamService, 'revokeTokensOfDeactivated'>;
  readonly connections: Pick<ConnectionsModule, 'notices'>;
  readonly authenticator: Authenticator;
  /** The web sessions: "sign out everywhere" clears the cookie of the browser it comes from. */
  readonly sessions: Pick<SessionService, 'destroy'>;
  readonly logger: Logger;
  readonly clock?: Clock;
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
    delegations: deps.delegations,
    memberTokens: deps.memberTokens,
    audit: deps.store.auditWriter,
    clock: deps.clock ?? systemClock,
    logger,
  });
  const invitations = new InvitationService({
    store: deps.store,
    audit: deps.store.auditWriter,
    clock: deps.clock ?? systemClock,
    logger,
  });
  const handlers = createUserAdminHandlers({
    publicUrl: deps.config.publicUrl,
    authenticator: deps.authenticator,
    sessions: deps.sessions,
    users: service,
    invitations,
    notices: deps.connections.notices,
    logger,
  });
  return { service, invitations, handlers };
}

export {
  USER_ADMIN_ERROR_CODES,
  USER_ADMIN_ERROR_MESSAGES,
  UserAdminError,
  type UserAdminErrorCode,
} from './errors';
export { createUserAdminHandlers, USERS_PAGE, type UserAdminHandlers } from './handlers';
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
