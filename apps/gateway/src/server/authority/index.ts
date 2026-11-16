/**
 * Authority (spec §3.1, §2.3 "orphaned" / "unowned"): what a user may accept on
 * an account (owner, or the union of the shares they receive), whether a
 * mission is grounded right now (`orphaned` is that answer, derived on every
 * read and never stored), and what a membership change settles. Built
 * once by the composition root as `root.authority`.
 * Handbook: docs/handbook/authority.md.
 */
import type { PluginRegistry } from '@vaubaan/plugin-sdk';

import type { Logger } from '../logging';
import type { Store } from '../store';
import { systemClock, type Clock } from '../store/clock';
import { AccountAuthorityService } from './authority-service';
import { MembershipSettler } from './membership';
import { MissionGrounds } from './mission-grounds';
import type { NotificationEvents } from '../notifications/events';

export interface AuthorityModuleDeps {
  readonly store: Pick<Store, 'users' | 'groups' | 'accounts' | 'shares' | 'missions' | 'audit'>;
  readonly registry: PluginRegistry;
  readonly logger: Logger;
  readonly clock?: Clock;
  /** Told of each mission an act orphaned or took an account from (spec §4.2 bis); default: nobody. */
  readonly notifications?: Pick<NotificationEvents, 'missionOrphaned' | 'missionAccountLost'>;
}

export interface AuthorityModule {
  readonly service: AccountAuthorityService;
  readonly grounds: MissionGrounds;
  readonly membership: MembershipSettler;
}

export function createAuthorityModule(deps: AuthorityModuleDeps): AuthorityModule {
  const logger = deps.logger.child({ component: 'authority' });
  const service = new AccountAuthorityService({
    registry: deps.registry,
    users: deps.store.users,
    groups: deps.store.groups,
    accounts: deps.store.accounts,
    shares: deps.store.shares,
  });
  const grounds = new MissionGrounds({
    authority: service,
    missions: deps.store.missions,
    accounts: deps.store.accounts,
    audit: deps.store.audit,
    clock: deps.clock ?? systemClock,
    logger,
    notifications: deps.notifications,
  });
  const membership = new MembershipSettler({
    accounts: deps.store.accounts,
    grounds,
    logger,
  });
  return { service, grounds, membership };
}

export {
  AccountAuthorityService,
  type AuthorityBasis,
  type AuthorityGap,
  type AuthorityGaps,
  type AuthorityQuestion,
  type AuthorityRecheck,
  type AuthorityService,
  type Subject,
  type AccountAuthority,
  type AccountAuthorityDeps,
  type SupposedShare,
} from './authority-service';
export {
  explicitRiskIdsOf,
  fullCatalogRiskIds,
  uncoveredRisks,
} from '../../lib/authority/catalog-authority';
export {
  MembershipSettler,
  type MembershipSettlement,
  type MembershipSettlerDeps,
  type MembershipWatch,
} from './membership';
export { findActiveUserByEmail, principalLabel, type UserLookup } from './principals';
export {
  MissionGrounds,
  ORPHAN_CAUSES,
  PART_LOSS_CAUSES,
  isFinalLoss,
  partitionOf,
  type GroundsShift,
  type GroundsVerdict,
  type GroundsWatch,
  type InspectedMission,
  type LostPart,
  type PartLossCause,
  type MissionGroundsDeps,
  type OrphanCause,
  type OrphanReason,
} from './mission-grounds';
