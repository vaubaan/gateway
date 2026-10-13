/**
 * "Load the session's counters, derive the state" — the one implementation.
 *
 * The Missions pages, the request page and `SessionService.stateOf` all need the same
 * read: the mission's session if it exists, its counters, the state that follows (spec
 * §2.3, §3.3). It is written here once and reads the counters of the *current period*
 * only (`SessionsRepo.counters(sessionId, periodStart)`), so its cost does not grow with
 * the age of the mission: past periods are never loaded to be discarded.
 *
 * `SessionService.usageOf` / `stateOf` are this function over the service's own
 * repository; a module built before the service exists takes
 * `missionUsageReader(store.sessions)`, which is the same function over the same store.
 */

import type { RiskId } from '@vaubaan/shared';
import type { SessionsRepo } from '../store/index.ts';
import { sessionCounterOf, type BudgetMission } from './mapping.ts';
import { consumedInPeriod, deriveMissionState, type MissionState } from './mission-state.ts';
import { currentPeriod, type CurrentPeriod } from './period.ts';

export interface MissionUsage {
  /** `null` until the first call gives the mission its session. */
  readonly session_id: string | null;
  readonly period: CurrentPeriod;
  /** Actions consumed per risk in `period`; a risk never touched is absent. */
  readonly consumed: ReadonlyMap<RiskId, number>;
  readonly state: MissionState;
}

export type MissionUsageSessions = Pick<SessionsRepo, 'getByMission' | 'counters'>;

/** What a consumer of the read depends on; `SessionService` satisfies it. */
export interface MissionUsageReader {
  stateOf(mission: BudgetMission, now: Date): Promise<MissionState>;
  usageOf(mission: BudgetMission, now: Date): Promise<MissionUsage>;
}

export async function readMissionUsage(
  sessions: MissionUsageSessions,
  mission: BudgetMission,
  now: Date,
): Promise<MissionUsage> {
  const period = currentPeriod(mission.period, now);
  const session = await sessions.getByMission(mission.id);
  const records = session ? await sessions.counters(session.id, period.start) : [];
  const counters = records.map(sessionCounterOf);
  return {
    session_id: session?.id ?? null,
    period,
    consumed: consumedInPeriod(counters, period.start),
    state: deriveMissionState(mission, counters, now),
  };
}

/** The read over a sessions repository, for a module wired before the `SessionService`. */
export function missionUsageReader(sessions: MissionUsageSessions): MissionUsageReader {
  return {
    usageOf: (mission, now) => readMissionUsage(sessions, mission, now),
    stateOf: async (mission, now) => (await readMissionUsage(sessions, mission, now)).state,
  };
}
