/**
 * Local groups (spec §0 "Group", §4.2 Administration, §11.2): the operator's
 * table of groups for an IdP that provides none, merged with the IdP-sourced
 * ones at every membership read. Built once by the composition root as
 * `root.groups`. Handbook: docs/handbook/authority.md.
 */
import type { Authenticator } from '../auth/authenticator';
import type { MembershipSettler } from '../authority';
import { reservedGroupNames } from '../config/sign-in';
import type { InstanceConfig } from '../config/types';
import type { ConnectionsModule } from '../connections';
import type { Logger } from '../logging';
import type { Store } from '../store';
import { systemClock, type Clock } from '../store/clock';
import { createGroupHandlers, type GroupHandlers } from './handlers';
import { GroupService } from './service';

export interface GroupsModuleDeps {
  readonly config: Pick<InstanceConfig, 'publicUrl'>;
  readonly store: Store;
  readonly membership: Pick<MembershipSettler, 'watch'>;
  readonly connections: Pick<ConnectionsModule, 'notices'>;
  readonly authenticator: Authenticator;
  readonly logger: Logger;
  readonly clock?: Clock;
}

export interface GroupsModule {
  readonly service: GroupService;
  readonly handlers: GroupHandlers;
}

export function createGroupsModule(deps: GroupsModuleDeps): GroupsModule {
  const logger = deps.logger.child({ component: 'groups' });
  const service = new GroupService({
    store: deps.store,
    membership: deps.membership,
    reservedNames: async () =>
      (await deps.store.administrators.list()).flatMap((d) =>
        d.kind === 'group'
          ? reservedGroupNames(d.provider === null ? d.groupName : `${d.provider}:${d.groupName}`)
          : [],
      ),
    audit: deps.store.auditWriter,
    clock: deps.clock ?? systemClock,
    logger,
  });
  const handlers = createGroupHandlers({
    publicUrl: deps.config.publicUrl,
    authenticator: deps.authenticator,
    groups: service,
    notices: deps.connections.notices,
    logger,
  });
  return { service, handlers };
}

export { GROUP_ERROR_CODES, GROUP_ERROR_MESSAGES, GroupError, type GroupErrorCode } from './errors';
export { createGroupHandlers, GROUPS_PAGE, type GroupHandlers } from './handlers';
export {
  GROUP_NAME_MAX_LENGTH,
  GroupService,
  type GroupServiceDeps,
  type GroupView,
  type MemberAddition,
  type MemberRemoval,
} from './service';
