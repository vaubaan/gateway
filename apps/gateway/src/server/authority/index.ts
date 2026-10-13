/**
 * Authority (spec §3.1, §2.3 "orphaned" / "unowned"): what a user may accept on
 * a connection (owner, or the union of the shares they receive), whether a
 * mission is still grounded, and what a membership removal settles. Built
 * once by the composition root as `root.authority`.
 * Handbook: docs/handbook/authority.md.
 */
import type { PluginRegistry } from '@vaubaan/plugin-sdk';

import type { Logger } from '../logging';
import type { Store } from '../store';
import { systemClock, type Clock } from '../store/clock';
import { ConnectionAuthorityService } from './authority-service';
import { MembershipSettler } from './membership';
import { MissionGrounds } from './mission-grounds';

export interface AuthorityModuleDeps {
  readonly store: Pick<
    Store,
    'users' | 'groups' | 'connections' | 'shares' | 'missions' | 'auditWriter'
  >;
  readonly registry: PluginRegistry;
  readonly logger: Logger;
  readonly clock?: Clock;
}

export interface AuthorityModule {
  readonly service: ConnectionAuthorityService;
  readonly grounds: MissionGrounds;
  readonly membership: MembershipSettler;
}

export function createAuthorityModule(deps: AuthorityModuleDeps): AuthorityModule {
  const logger = deps.logger.child({ component: 'authority' });
  const service = new ConnectionAuthorityService({
    registry: deps.registry,
    users: deps.store.users,
    groups: deps.store.groups,
    connections: deps.store.connections,
    shares: deps.store.shares,
  });
  const grounds = new MissionGrounds({
    authority: service,
    missions: deps.store.missions,
    connections: deps.store.connections,
    audit: deps.store.auditWriter,
    clock: deps.clock ?? systemClock,
    logger,
  });
  const membership = new MembershipSettler({
    connections: deps.store.connections,
    grounds,
    logger,
  });
  return { service, grounds, membership };
}

export {
  ConnectionAuthorityService,
  uncoveredRisks,
  type AuthorityBasis,
  type AuthorityGap,
  type AuthorityGaps,
  type AuthorityQuestion,
  type AuthorityRecheck,
  type AuthorityService,
  type AuthoritySubject,
  type ConnectionAuthority,
  type ConnectionAuthorityDeps,
} from './authority-service';
export { explicitRiskIdsOf, fullCatalogRiskIds } from './catalog-authority';
export {
  MembershipSettler,
  type MembershipSettlement,
  type MembershipSettlerDeps,
} from './membership';
export { findActiveUserByEmail, principalLabel, type UserLookup } from './principals';
export {
  MissionGrounds,
  ORPHAN_CAUSES,
  partitionOf,
  type GroundsVerdict,
  type MissionGroundsDeps,
  type OrphanCause,
} from './mission-grounds';
