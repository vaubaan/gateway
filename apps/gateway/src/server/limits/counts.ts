/**
 * The counts of the instance (spec §4.3 bis), each one SQL `COUNT` of the store. One
 * definition serves the ceilings, the administrator's view, the counters endpoint and
 * the telemetry's instance profile, so that none of them disagrees with another:
 *
 *   users            people not removed (`users.status = 'active'`), signed in or not;
 *                    never an agent or a mission token
 *   connections      connected accounts not revoked, every owner together; an expired
 *                    or ownerless one counts until it is revoked
 *   active missions  neither revoked nor past their end, orphaned ones included
 */
import type { Store } from '../store';

export interface ConnectionCounts {
  readonly total: number;
  /** Not revoked, by provider id; a provider with none is absent. */
  readonly byProvider: Readonly<Record<string, number>>;
}

export interface InstanceCounts {
  users(): Promise<number>;
  connections(): Promise<ConnectionCounts>;
  activeMissions(now: Date): Promise<number>;
}

export type CountedStore = Pick<Store, 'users' | 'connections' | 'missions'>;

export function storeCounts(store: CountedStore): InstanceCounts {
  return {
    users: () => store.users.countActive(),
    async connections() {
      const byProvider = await store.connections.countByProvider();
      const total = Object.values(byProvider).reduce((sum, n) => sum + n, 0);
      return { total, byProvider };
    },
    activeMissions: (now) => store.missions.countActive(now.toISOString()),
  };
}

/** A mission as the count of active missions reads it: its status and its end. */
export interface CountedMission {
  /** The stored status, or the derived `orphaned` (stored `active`). */
  readonly status: string;
  readonly expiresAt: string | null;
}

/** Whether the mission counts among the active ones at `now` (`MissionsRepo.countActive`). */
export function countsAsActiveMission(mission: CountedMission, now: Date): boolean {
  const live = mission.status === 'active' || mission.status === 'orphaned';
  return live && endsAfter(mission.expiresAt, now);
}

/**
 * Whether giving the mission the end `expiresAt` (an edit, a granted extension) adds
 * an active mission (spec §4.3 bis): it does not count now — expired, or past its end
 * — and would. A revoked mission never counts again.
 */
export function revivesEndedMission(
  mission: CountedMission,
  expiresAt: string | null,
  now: Date,
): boolean {
  if (mission.status === 'revoked' || countsAsActiveMission(mission, now)) return false;
  return endsAfter(expiresAt, now);
}

function endsAfter(end: string | null, now: Date): boolean {
  return end === null || Date.parse(end) > now.getTime();
}
