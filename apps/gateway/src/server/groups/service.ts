/**
 * Local groups (spec §0 "Group", §4.2 Administration, §11.2 "Local groups").
 *
 * A group comes from the IdP claims when the IdP provides them, otherwise
 * from a local table kept by the operator. Both live in `groups` /
 * `group_members`, told apart by `groups.source`:
 *
 *   idp     created and filled at sign-in from the claims; read-only here
 *   local   created and filled by the operator, here; a sign-in never touches it
 *
 * A user's groups are the union of the two (`GroupsRepo.groupsOf`): that
 * union is the membership every authority check reads. The operator only
 * (v1 assumption) keeps local groups; this service does not authorize, its
 * callers do (`guardMutation(…, 'operator')`), and `actorId` is the audit
 * actor.
 *
 * Removing a member is an authorization change: the connections the group
 * owned become `unowned` when it empties, and the missions the membership
 * grounded become `orphaned` (`MembershipSettler`).
 */
import type { AuditWriter } from '@vaubaan/gateway-core';

import { findActiveUserByEmail, type MembershipSettler } from '../authority';
import type { Logger } from '../logging';
import type { Store } from '../store';
import { toIso, type Clock } from '../store/clock';
import type { GroupRecord, UserRecord } from '../store/types';
import { GroupError } from './errors';

export const GROUP_NAME_MAX_LENGTH = 80;
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export interface GroupView {
  readonly group: GroupRecord;
  readonly members: readonly UserRecord[];
  /** Connections this group owns (any status but `revoked`). */
  readonly ownedConnections: number;
}

export interface MemberRemoval {
  readonly group: GroupRecord;
  readonly user: UserRecord;
  /** Connections that lost their last owner with this removal. */
  readonly unowned: number;
  /** Missions of the removed member that lost their grounds. */
  readonly orphaned: number;
}

export interface GroupServiceDeps {
  readonly store: Pick<Store, 'groups' | 'users' | 'connections'>;
  readonly membership: Pick<MembershipSettler, 'afterRemoval'>;
  /** The IdP group of the admin rule, if any: never the name of a local group. */
  readonly adminGroup: string | null;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly logger: Logger;
}

export class GroupService {
  constructor(private readonly deps: GroupServiceDeps) {}

  /** Every group, local and IdP-sourced, with its current members. */
  async list(): Promise<GroupView[]> {
    const views: GroupView[] = [];
    for (const group of await this.deps.store.groups.list()) {
      const owned = await this.deps.store.connections.listOwnedBy([
        { kind: 'group', id: group.id },
      ]);
      views.push({
        group,
        members: await this.deps.store.groups.listMembers(group.id),
        ownedConnections: owned.filter((c) => c.status !== 'revoked').length,
      });
    }
    return views;
  }

  /**
   * Creates a local group. A name designates one group: it is refused when a
   * local or an IdP-sourced group already holds it, and when it is the group
   * of the admin rule (membership of that one is granted by the IdP alone).
   */
  async create(actorId: string, rawName: string): Promise<GroupRecord> {
    const name = rawName.trim();
    if (name === '' || name.length > GROUP_NAME_MAX_LENGTH || CONTROL_CHARACTERS.test(name)) {
      throw new GroupError('name-invalid');
    }
    if (this.deps.adminGroup !== null && name === this.deps.adminGroup) {
      throw new GroupError('name-reserved');
    }
    const group = await this.deps.store.groups.createLocal(name);
    if (!group) throw new GroupError('name-taken');
    await this.audit(actorId, 'group-created', group, null, { name: group.name, source: 'local' });
    this.deps.logger.info('local group created', { group_id: group.id });
    return group;
  }

  /** Adds a known user (by email) to a local group. Idempotent. */
  async addMember(
    actorId: string,
    groupId: string,
    email: string,
  ): Promise<{ group: GroupRecord; user: UserRecord }> {
    const group = await this.requireLocal(groupId);
    const lookup = await findActiveUserByEmail(this.deps.store.users, email);
    if (!lookup.found) {
      throw new GroupError(lookup.reason === 'unknown' ? 'user-unknown' : 'user-ambiguous');
    }
    const { user } = lookup;
    await this.deps.store.groups.addMember(group.id, user.id);
    await this.audit(actorId, 'group-member-added', group, null, {
      user_id: user.id,
      email: user.email,
    });
    this.deps.logger.info('local group member added', { group_id: group.id, user_id: user.id });
    return { group, user };
  }

  /**
   * Removes a member from a local group, then settles what the membership
   * held: connections left without owner, missions left without grounds.
   */
  async removeMember(actorId: string, groupId: string, userId: string): Promise<MemberRemoval> {
    const group = await this.requireLocal(groupId);
    const user = await this.deps.store.users.getById(userId);
    if (!user || !(await this.deps.store.groups.removeMember(group.id, userId))) {
      throw new GroupError('not-found');
    }
    // Audited before the settlement: the removal is done whatever happens next, and each
    // orphaned mission gets its own `mission-orphaned` entry.
    await this.audit(
      actorId,
      'group-member-removed',
      group,
      { user_id: user.id, email: user.email },
      null,
    );
    const settlement = await this.deps.membership.afterRemoval(user.id, actorId);
    this.deps.logger.info('local group member removed', {
      group_id: group.id,
      user_id: user.id,
      connections_unowned: settlement.unowned.length,
      missions_orphaned: settlement.orphaned.length,
    });
    return {
      group,
      user,
      unowned: settlement.unowned.length,
      orphaned: settlement.orphaned.length,
    };
  }

  /** A local group, or the refusal: IdP-sourced memberships are replaced at each sign-in. */
  private async requireLocal(groupId: string): Promise<GroupRecord> {
    const group = await this.deps.store.groups.getById(groupId);
    if (!group) throw new GroupError('not-found');
    if (group.source !== 'local') throw new GroupError('not-local');
    return group;
  }

  private async audit(
    actorId: string,
    act: 'group-created' | 'group-member-added' | 'group-member-removed',
    group: GroupRecord,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    await this.deps.audit.write({
      kind: 'admin',
      ts: toIso(this.deps.clock.now()),
      user_id: actorId,
      act,
      object: { type: 'group', id: group.id },
      before,
      after,
      delegated_client_id: null,
    });
  }
}
