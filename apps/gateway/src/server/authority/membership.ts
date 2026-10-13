/**
 * What a membership removal does to the domain (spec §2.3).
 *
 * Group membership is never copied anywhere, so most of its effects need no
 * work: the next authority check simply reads the new memberships. Two
 * effects are stored states and are settled here, right after the removal:
 *
 *   - a connection whose owner group has no member left becomes `unowned`
 *     (it keeps serving its missions; the operator reassigns an owner);
 *   - the missions of the user who lost a membership are re-checked, and the
 *     ones that membership grounded become `orphaned`.
 *
 * Called by the local-groups service (the operator removed a member) and by
 * the sign-in (the IdP claims replaced the user's IdP-sourced memberships).
 * The execution door re-checks on every call anyway: a removal this settler
 * never heard of is still seen by the next call of the mission.
 */
import type { Logger } from '../logging';
import type { ConnectionsRepo } from '../store/repositories/connections';
import type { ConnectionRecord, MissionRecord } from '../store/types';
import type { MissionGrounds } from './mission-grounds';

export interface MembershipSettlerDeps {
  readonly connections: Pick<ConnectionsRepo, 'markOwnerlessUnowned'>;
  readonly grounds: Pick<MissionGrounds, 'sweepCreator'>;
  readonly logger: Logger;
}

export interface MembershipSettlement {
  /** Connections that just lost their last owner. */
  readonly unowned: readonly ConnectionRecord[];
  /** Missions of the user that just lost their grounds. */
  readonly orphaned: readonly MissionRecord[];
}

export class MembershipSettler {
  constructor(private readonly deps: MembershipSettlerDeps) {}

  /**
   * `userId` lost (or may have lost) a membership; `actorId` is the human
   * behind the change — the operator, or the user themselves at sign-in.
   */
  async afterRemoval(userId: string, actorId: string): Promise<MembershipSettlement> {
    const unowned = await this.deps.connections.markOwnerlessUnowned();
    for (const connection of unowned) {
      this.deps.logger.warn('connection has no owner left', {
        connection_id: connection.id,
        provider: connection.provider,
        owner_group_id: connection.owner.id,
      });
    }
    const orphaned = await this.deps.grounds.sweepCreator(userId, actorId);
    return { unowned, orphaned };
  }
}
