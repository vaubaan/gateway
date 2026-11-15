/**
 * What a membership change does to the domain (spec §2.3).
 *
 * Group membership is never copied anywhere, so its effects on authority need
 * no work: the next check simply reads the new memberships, and a mission of
 * the user reads `orphaned` or `active` accordingly (`MissionGrounds`). Two
 * things are done here, around the change:
 *
 *   - an account whose owner group has no member left becomes `unowned`, a
 *     stored state (it keeps serving its missions; the operator reassigns an
 *     owner);
 *   - the missions of the user are watched across the change, so that the
 *     ones it orphaned and the ones it restored each get an audit entry
 *     naming the human behind it.
 *
 * Called by the local-groups service (the operator added or removed a member)
 * and by the sign-in (the IdP claims replaced the user's IdP-sourced
 * memberships): `watch(userId)` before the change, `settle(actorId)` after.
 * A change this settler never heard of is still seen by every reader of the
 * mission, the execution door first: only the audit entry is missing.
 */
import type { Logger } from '../logging';
import type { AccountsRepo } from '../store/repositories/accounts';
import type { AccountRecord, MissionRecord } from '../store/types';
import type { MissionGrounds } from './mission-grounds';

export interface MembershipSettlerDeps {
  readonly accounts: Pick<AccountsRepo, 'markOwnerlessUnowned'>;
  readonly grounds: Pick<MissionGrounds, 'watchCreator'>;
  readonly logger: Logger;
}

export interface MembershipSettlement {
  /** Accounts that just lost their last owner. */
  readonly unowned: readonly AccountRecord[];
  /** Missions of the user that the change left without grounds. */
  readonly orphaned: readonly MissionRecord[];
  /** Missions of the user whose grounds the change brought back. */
  readonly restored: readonly MissionRecord[];
}

/** Taken before a membership change; settled once it is done. */
export interface MembershipWatch {
  /** `actorId` is the human behind the change: the operator, or the user at sign-in. */
  settle(actorId: string): Promise<MembershipSettlement>;
}

export class MembershipSettler {
  constructor(private readonly deps: MembershipSettlerDeps) {}

  /** `userId` is about to gain or lose memberships. */
  async watch(userId: string): Promise<MembershipWatch> {
    const missions = await this.deps.grounds.watchCreator(userId);
    return {
      settle: async (actorId) => {
        const unowned = await this.deps.accounts.markOwnerlessUnowned();
        for (const account of unowned) {
          this.deps.logger.warn('account has no owner left', {
            account_id: account.id,
            service: account.service,
            owner_group_id: account.owner.id,
          });
        }
        return { unowned, ...(await missions.settle(actorId)) };
      },
    };
  }
}
