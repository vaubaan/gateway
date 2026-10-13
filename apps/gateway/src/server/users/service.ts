/**
 * Users administration: the operator deactivates a user, and reactivates them
 * (spec §2.3 "creator removed from the IdP"; ADR operator-deactivates-a-user).
 *
 * The instance stores no directory: a user exists once they have signed in,
 * and the identity provider decides who may sign in. That leaves offboarding
 * to the IdP alone, and to its delays: a person removed there keeps their
 * web session until it expires, their delegations for as long as a client
 * renews them, and their missions for ever. Deactivation is the operator's
 * answer on the instance itself, without the IdP:
 *
 *   status        `users.status = 'removed'`: every authority check answers
 *                 "holds nothing" from the next read on
 *   sign-in       refused (`account-deactivated`) although the IdP vouches
 *   sessions      every web session of the user is over at their next request
 *                 (`users.sessions_ended_at`), and stays over after a
 *                 reactivation
 *   delegations   every active one is revoked with its tokens (reason
 *                 `user-deactivated`); a reactivated user consents again
 *   memberships   removed from every group, local and IdP-sourced; a
 *                 connection whose owner group empties, or that the user owned
 *                 in their own name, becomes `unowned` — the operator
 *                 reassigns it
 *   missions      nothing is written on them: they follow the derived rule and
 *                 read `orphaned` (`creator-removed`), each with its
 *                 `mission-orphaned` entry in the operator's name
 *
 * Reactivation restores the status and nothing else that was removed: the
 * missions whose authority still stands (a share made to the user, a
 * connection they still own) serve again by the same derived rule, with their
 * `mission-restored` entry; IdP groups return at the next sign-in; local
 * groups, delegations and reassigned connections do not come back by
 * themselves.
 *
 * This service does not authorize: its callers do
 * (`guardMutation(…, 'operator')`), and `actor` is who the entries name.
 */
import type { AuditWriter } from '@vaubaan/gateway-core';

import type { MembershipSettlement, MembershipSettler } from '../authority';
import type { Logger } from '../logging';
import type { DelegationService } from '../oauth-as';
import type { Store } from '../store';
import { toIso, type Clock } from '../store/clock';
import type { UserRecord } from '../store/types';
import { UserAdminError } from './errors';

/** Who acts: the audit actor, and their own user id (`null` for the bootstrap operator). */
export interface UserAdminActor {
  readonly actorId: string;
  readonly userId: string | null;
}

export interface UserView {
  readonly user: UserRecord;
  /** Names of the groups the user belongs to now, local and IdP-sourced. */
  readonly groups: readonly string[];
}

export interface Deactivation {
  readonly user: UserRecord;
  /** Names of the groups the user was removed from. */
  readonly groupsLeft: readonly string[];
  readonly delegationsRevoked: number;
  /** Missions of the user that read `orphaned` from now on. */
  readonly orphaned: number;
  /** Connections that have no owner left with this deactivation. */
  readonly unowned: number;
}

export interface Reactivation {
  readonly user: UserRecord;
  /** Orphaned missions of the user that serve again. */
  readonly restored: number;
}

export interface UserAdminServiceDeps {
  readonly store: Pick<Store, 'users' | 'groups'>;
  readonly membership: Pick<MembershipSettler, 'watch'>;
  readonly delegations: Pick<DelegationService, 'revokeAllOf'>;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly logger: Logger;
}

export class UserAdminService {
  constructor(private readonly deps: UserAdminServiceDeps) {}

  /** Every user the instance knows, in sign-up order, with their current groups. */
  async list(): Promise<UserView[]> {
    const views: UserView[] = [];
    for (const user of await this.deps.store.users.list()) {
      const groups = await this.deps.store.groups.groupsOf(user.id);
      views.push({ user, groups: groups.map((group) => group.name) });
    }
    return views;
  }

  async deactivate(actor: UserAdminActor, userId: string): Promise<Deactivation> {
    const { store, membership, delegations } = this.deps;
    const user = await store.users.getById(userId);
    if (!user) throw new UserAdminError('not-found');
    if (user.status !== 'active') throw new UserAdminError('already-deactivated');
    if (actor.userId === user.id) throw new UserAdminError('cannot-deactivate-self');

    const watch = await membership.watch(user.id);
    const removed = await store.users.markRemoved(user.id);
    // From here on the user holds nothing. What follows closes what they still held;
    // each step is attempted whatever happened to the one before, and the first
    // failure reaches the caller once the settlement has run: `unowned` is a stored
    // state and must not depend on another write succeeding.
    let groupsLeft: string[] = [];
    let delegationsRevoked = 0;
    let settlement: MembershipSettlement;
    try {
      groupsLeft = (await store.groups.removeAllMemberships(user.id)).map((group) => group.name);
      delegationsRevoked = (
        await delegations.revokeAllOf(user.id, {
          reason: 'user-deactivated',
          actorId: actor.actorId,
          viaClient: false,
        })
      ).length;
      await this.deps.audit.write({
        kind: 'admin',
        ts: toIso(this.deps.clock.now()),
        user_id: actor.actorId,
        act: 'user-deactivated',
        object: { type: 'user', id: user.id },
        before: { status: 'active', email: user.email },
        after: {
          status: 'removed',
          groups_left: groupsLeft,
          delegations_revoked: delegationsRevoked,
        },
        delegated_client_id: null,
      });
    } finally {
      settlement = await watch.settle(actor.actorId);
    }
    this.deps.logger.warn('user deactivated', {
      user_id: user.id,
      actor_id: actor.actorId,
      groups_left: groupsLeft.length,
      delegations_revoked: delegationsRevoked,
      missions_orphaned: settlement.orphaned.length,
      connections_unowned: settlement.unowned.length,
    });
    return {
      user: removed,
      groupsLeft,
      delegationsRevoked,
      orphaned: settlement.orphaned.length,
      unowned: settlement.unowned.length,
    };
  }

  async reactivate(actor: UserAdminActor, userId: string): Promise<Reactivation> {
    const { store, membership } = this.deps;
    const user = await store.users.getById(userId);
    if (!user) throw new UserAdminError('not-found');
    if (user.status === 'active') throw new UserAdminError('not-deactivated');

    const watch = await membership.watch(user.id);
    const restoredUser = await store.users.reactivate(user.id);
    // Another operator reactivated them between the read and the write: their entry stands.
    if (!restoredUser) throw new UserAdminError('not-deactivated');
    let settlement: MembershipSettlement;
    try {
      await this.deps.audit.write({
        kind: 'admin',
        ts: toIso(this.deps.clock.now()),
        user_id: actor.actorId,
        act: 'user-reactivated',
        object: { type: 'user', id: user.id },
        before: { status: 'removed', removed_at: user.removedAt },
        after: { status: 'active', email: user.email },
        delegated_client_id: null,
      });
    } finally {
      settlement = await watch.settle(actor.actorId);
    }
    this.deps.logger.info('user reactivated', {
      user_id: user.id,
      actor_id: actor.actorId,
      missions_restored: settlement.restored.length,
    });
    return { user: restoredUser, restored: settlement.restored.length };
  }
}
