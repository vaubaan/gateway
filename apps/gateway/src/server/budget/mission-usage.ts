/**
 * "Load the mission log's counters, derive the state" — the one implementation.
 *
 * The Missions pages, the request page and `MissionLogService.stateOf` all need the same
 * read: the mission log if it exists, its counters, the state that follows (spec
 * §2.3, §3.3). It is written here once and reads the counters of the *current period*
 * only (`MissionLogsRepo.counters(missionLogId, periodStart)`), so its cost does not grow with
 * the age of the mission: past periods are never loaded to be discarded.
 *
 * `MissionLogService.usageOf` / `stateOf` are this function over the service's own
 * repository; a module built before the service exists takes
 * `missionUsageReader(store.missionLogs)`, which is the same function over the same store.
 */

import type { PolicyLineKey } from '@vaubaan/shared';
import type { MissionLogsRepo } from '../store/index.ts';
import { missionLogCounterOf, type BudgetMission } from './mapping.ts';
import { consumedInPeriod, deriveMissionState, type MissionState } from './mission-state.ts';
import { currentPeriod, type CurrentPeriod } from './period.ts';

export interface MissionUsage {
  /** `null` until the first call gives the mission its mission log. */
  readonly mission_log_id: string | null;
  readonly period: CurrentPeriod;
  /** Actions consumed per line (set, risk) in `period`; a line never touched is absent. */
  readonly consumed: ReadonlyMap<PolicyLineKey, number>;
  readonly state: MissionState;
}

export type MissionUsageLogs = Pick<MissionLogsRepo, 'getByMission' | 'counters'>;

/** What a consumer of the read depends on; `MissionLogService` satisfies it. */
export interface MissionUsageReader {
  stateOf(mission: BudgetMission, now: Date): Promise<MissionState>;
  usageOf(mission: BudgetMission, now: Date): Promise<MissionUsage>;
}

export async function readMissionUsage(
  missionLogs: MissionUsageLogs,
  mission: BudgetMission,
  now: Date,
): Promise<MissionUsage> {
  const period = currentPeriod(mission.period, now);
  const missionLog = await missionLogs.getByMission(mission.id);
  const records = missionLog ? await missionLogs.counters(missionLog.id, period.start) : [];
  const counters = records.map(missionLogCounterOf);
  return {
    mission_log_id: missionLog?.id ?? null,
    period,
    consumed: consumedInPeriod(counters, period.start),
    state: deriveMissionState(mission, counters, now),
  };
}

/** The read over a mission logs repository, for a module wired before the `MissionLogService`. */
export function missionUsageReader(missionLogs: MissionUsageLogs): MissionUsageReader {
  return {
    usageOf: (mission, now) => readMissionUsage(missionLogs, mission, now),
    stateOf: async (mission, now) => (await readMissionUsage(missionLogs, mission, now)).state,
  };
}
