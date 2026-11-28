/**
 * The trust-raise proposals of a running mission (risk model §4.7): offered on the Now
 * page and the mission page, "Not now", and the one offer "Raise" opens the edit with.
 * The count itself is `trust-raise.ts`'; the mission service delegates these acts here.
 */
import type { MacroAction } from '@vaubaan/shared';

import type { Subject } from '../authority';
import type { MissionRecord } from '../store/types';
import type { MissionLookups } from './mission-lookups';
import type { MissionServiceDeps } from './mission-views';
import { trustRaiseOffers, type TrustRaiseOffer } from './trust-raise';

/** The default of `trust_raise.after_approvals`. */
const DEFAULT_TRUST_RAISE_AFTER_APPROVALS = 10;

export class MissionTrustRaises {
  constructor(
    private readonly deps: MissionServiceDeps,
    private readonly lookups: MissionLookups,
  ) {}

  /**
   * The trust-raise proposals of every running mission the user created (risk model
   * §4.7), for the Now page: each with its mission's id and name.
   */
  async trustRaisesFor(user: Subject): Promise<
    {
      readonly mission_id: string;
      readonly mission_name: string;
      readonly offers: readonly TrustRaiseOffer[];
    }[]
  > {
    const out: { mission_id: string; mission_name: string; offers: readonly TrustRaiseOffer[] }[] =
      [];
    for (const created of await this.deps.store.missions.listForCreator(user.id)) {
      const { mission, orphan } = await this.deps.grounds.inspect(created);
      if (orphan || (await this.lookups.stateOf(mission)).kind !== 'active') continue;
      const offers = await this.trustRaisesOf(mission);
      if (offers.length > 0)
        out.push({ mission_id: mission.id, mission_name: mission.name, offers });
    }
    return out;
  }

  /**
   * "Not now" on a trust-raise proposal (risk model §4.7): the offer is hidden until as
   * many approvals again. The creator only; `null` is "not found" for anyone else, or a
   * set that is not the mission's. Not an edit of the mission: nothing it allows moves.
   */
  async snoozeTrustRaise(
    user: Subject,
    missionId: string,
    target: { readonly resource_set_id: string; readonly macro_action_id: string },
  ): Promise<{ readonly ok: true } | null> {
    const mission = await this.lookups.ownMission(user, missionId);
    if (!mission) return null;
    const done = await this.deps.store.missions.snoozeTrustRaise(
      mission.id,
      target.resource_set_id,
      target.macro_action_id,
    );
    return done ? { ok: true } : null;
  }

  /**
   * The one trust-raise proposal "Raise" opens the edit with: offered now on that
   * macro-action of that set of a running mission the user created; `null` otherwise
   * (the edit then opens as usual).
   */
  async trustRaiseOffer(
    user: Subject,
    missionId: string,
    target: { readonly resource_set_id: string; readonly macro_action_id: string },
  ): Promise<TrustRaiseOffer | null> {
    const inspected = await this.lookups.ownInspected(user, missionId);
    if (!inspected || inspected.orphan) return null;
    if ((await this.lookups.stateOf(inspected.mission)).kind !== 'active') return null;
    const offers = await this.trustRaisesOf(inspected.mission);
    return (
      offers.find(
        (o) =>
          o.resource_set_id === target.resource_set_id &&
          o.macro_action_id === target.macro_action_id,
      ) ?? null
    );
  }

  async trustRaisesOf(mission: MissionRecord): Promise<TrustRaiseOffer[]> {
    const accounts = new Map<string, { name: string; macroActions: readonly MacroAction[] }>();
    for (const c of mission.accounts) {
      const account = await this.deps.store.accounts.getById(c.accountId);
      if (!account || !this.deps.registry.get(account.service)) continue;
      accounts.set(c.accountId, {
        name: account.displayName,
        macroActions: this.lookups.macroActionsOf(account.service),
      });
    }
    return trustRaiseOffers({
      mission,
      accountOf: (accountId) => accounts.get(accountId) ?? null,
      requests: await this.deps.store.requests.listForMission(mission.id),
      marks: await this.deps.store.missions.trustMarks(mission.id),
      threshold: this.deps.trustRaiseAfterApprovals ?? DEFAULT_TRUST_RAISE_AFTER_APPROVALS,
    });
  }
}
