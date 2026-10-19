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
 *   member tokens the tokens they generated on missions shared with them are
 *                 revoked (`mission-token-revoked`, reason `holder-deactivated`);
 *                 the execution door refuses them from the deactivation itself,
 *                 since it reads the holder's status on every call. They stay
 *                 members: a reactivated user generates a new token
 *   memberships   removed from every group, local and IdP-sourced; a
 *                 connection whose owner group empties, or that the user owned
 *                 in their own name, becomes `unowned` — the operator
 *                 reassigns it
 *   missions      nothing is written on them: they follow the derived rule and
 *                 read `orphaned` (`creator-removed`), each with its
 *                 `mission-orphaned` entry in the operator's name
 *
 * Reactivation first closes again whatever a half-failed deactivation left open
 * (`closeHeldBy`: nothing to do when the deactivation completed, and a failure
 * there stops the reactivation), then restores the status and nothing else: the
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
import type { MissionTeamService } from '../missions';
import type { DelegationService } from '../oauth-as';
import type { Store } from '../store';
import { toIso, type Clock } from '../store/clock';
import type { GroupRecord, UserRecord } from '../store/types';
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
  /** The same groups as records: the admin rule reads their source and provider. */
  readonly groupRecords: readonly GroupRecord[];
}

export interface Deactivation {
  readonly user: UserRecord;
  /** Names of the groups the user was removed from. */
  readonly groupsLeft: readonly string[];
  readonly delegationsRevoked: number;
  /** Tokens the user held as a member of other people's missions, now revoked. */
  readonly memberTokensRevoked: number;
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
  /** Revokes the tokens the user holds as a member of missions they did not create. */
  readonly memberTokens: Pick<MissionTeamService, 'revokeTokensOfDeactivated'>;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly logger: Logger;
}

export class UserAdminService {
  constructor(private readonly deps: UserAdminServiceDeps) {}

  /** Every user the instance knows, in sign-up order, with their current groups. */
  /** One user by id, or `null`. */
  async get(id: string): Promise<UserRecord | null> {
    return this.deps.store.users.getById(id);
  }

  async list(): Promise<UserView[]> {
    const views: UserView[] = [];
    for (const user of await this.deps.store.users.list()) {
      const groups = await this.deps.store.groups.groupsOf(user.id);
      views.push({ user, groups: groups.map((group) => group.name), groupRecords: groups });
    }
    return views;
  }

  async deactivate(actor: UserAdminActor, userId: string): Promise<Deactivation> {
    const { store, membership, delegations, memberTokens } = this.deps;
    const user = await store.users.getById(userId);
    if (!user) throw new UserAdminError('not-found');
    if (user.status !== 'active') throw new UserAdminError('already-deactivated');
    if (actor.userId === user.id) throw new UserAdminError('cannot-deactivate-self');

    const watch = await membership.watch(user.id);
    const removed = await store.users.markRemoved(user.id);
    // From here on the user holds nothing. What follows closes what they still held.
    // Each step is attempted whatever happened to the one before — a failure to
    // revoke a delegation must not leave the memberships, nor a failed entry the
    // settlement — and the first failure reaches the caller once all have run:
    // `unowned` is a stored state and must not depend on another write succeeding.
    const failures: unknown[] = [];
    const attempt = async <T>(fallback: T, step: () => Promise<T>): Promise<T> => {
      try {
        return await step();
      } catch (err) {
        failures.push(err);
        return fallback;
      }
    };
    const groupsLeft = await attempt<string[]>([], async () =>
      (await store.groups.removeAllMemberships(user.id)).map((group) => group.name),
    );
    const delegationsRevoked = await attempt(0, async () => {
      const ended = await delegations.revokeAllOf(user.id, {
        reason: 'user-deactivated',
        actorId: actor.actorId,
        viaClient: false,
      });
      return ended.length;
    });
    // The door already refuses these tokens (it reads the holder's status on every
    // call, and the status was written above); revoking them makes it durable.
    const memberTokensRevoked = await attempt(0, () =>
      memberTokens.revokeTokensOfDeactivated(actor.actorId, user.id),
    );
    await attempt(undefined, () =>
      this.deps.audit.write({
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
          member_tokens_revoked: memberTokensRevoked,
        },
        delegated_client_id: null,
      }),
    );
    const settlement = await attempt<MembershipSettlement>(
      { unowned: [], orphaned: [], restored: [] },
      () => watch.settle(actor.actorId),
    );
    if (failures.length > 0) {
      this.deps.logger.error('user deactivated, but not everything they held was closed', {
        user_id: user.id,
        actor_id: actor.actorId,
        failed_steps: failures.length,
        err: failures[0],
      });
      throw failures[0];
    }
    this.deps.logger.warn('user deactivated', {
      user_id: user.id,
      actor_id: actor.actorId,
      groups_left: groupsLeft.length,
      delegations_revoked: delegationsRevoked,
      member_tokens_revoked: memberTokensRevoked,
      missions_orphaned: settlement.orphaned.length,
      connections_unowned: settlement.unowned.length,
    });
    return {
      user: removed,
      groupsLeft,
      delegationsRevoked,
      memberTokensRevoked,
      orphaned: settlement.orphaned.length,
      unowned: settlement.unowned.length,
    };
  }

  /**
   * Closes what a user holds that outlives their status: their delegations (with
   * their tokens), the member tokens they hold on other people's missions, their
   * group memberships. Idempotent; throws on the first step that fails.
   */
  private async closeHeldBy(actor: UserAdminActor, userId: string): Promise<void> {
    const { store, delegations, memberTokens } = this.deps;
    await delegations.revokeAllOf(userId, {
      reason: 'user-deactivated',
      actorId: actor.actorId,
      viaClient: false,
    });
    await memberTokens.revokeTokensOfDeactivated(actor.actorId, userId);
    await store.groups.removeAllMemberships(userId);
  }

  async reactivate(actor: UserAdminActor, userId: string): Promise<Reactivation> {
    const { store, membership } = this.deps;
    const user = await store.users.getById(userId);
    if (!user) throw new UserAdminError('not-found');
    if (user.status === 'active') throw new UserAdminError('not-deactivated');

    // A deactivation whose closing steps half-failed left things open that only the
    // user's status keeps dead (a delegation not revoked, a member token, a membership).
    // They are closed again here, BEFORE the status returns: each step is a no-op when
    // the deactivation completed, and a step that fails stops the reactivation — the
    // user stays deactivated and the operator tries again.
    await this.closeHeldBy(actor, user.id);
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
  /**
   * "Sign out everywhere": every web session of the user ends at its next request
   * (`users.sessions_ended_at`), nothing else changes — keys, connected apps and
   * missions stay. Done by the user for themselves, or by an operator for anyone
   * active (security review 2026-10-15, auth L1). Audited `user-sessions-ended`.
   */
  async endSessions(actor: UserAdminActor, userId: string): Promise<UserRecord> {
    const { store } = this.deps;
    const user = await store.users.getById(userId);
    if (!user) throw new UserAdminError('not-found');
    if (!(await store.users.endSessions(user.id))) throw new UserAdminError('already-deactivated');
    await this.deps.audit.write({
      kind: 'admin',
      ts: toIso(this.deps.clock.now()),
      user_id: actor.actorId,
      act: 'user-sessions-ended',
      object: { type: 'user', id: user.id },
      before: null,
      after: { email: user.email, by: actor.userId === user.id ? 'self' : 'operator' },
      delegated_client_id: null,
    });
    this.deps.logger.info('user sessions ended', { user_id: user.id, actor_id: actor.actorId });
    return user;
  }
}
