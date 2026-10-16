/**
 * Mission listings whose records carry the derived status (spec §2.3:
 * `orphaned` is derived from the creator's current authority, never stored).
 *
 * `MissionService` and `RequestService` derive on their own loads. This is
 * for a module that lists missions straight from the repository and shows
 * their status (the Delegations page): the composition root hands it these
 * reads in place of the repository's, so no reader shows `active` for a
 * mission every call of which is refused.
 */
import type { MissionsRepo } from '../store/repositories/missions';
import type { MissionGrounds } from './mission-grounds';

export type DerivedMissionReads = Pick<MissionsRepo, 'listForCreator'>;

export function derivedMissionReads(
  missions: Pick<MissionsRepo, 'listForCreator'>,
  grounds: Pick<MissionGrounds, 'derive'>,
): DerivedMissionReads {
  return {
    async listForCreator(userId) {
      const derived = [];
      for (const mission of await missions.listForCreator(userId)) {
        derived.push(await grounds.derive(mission));
      }
      return derived;
    },
  };
}
