/**
 * Pushes in flight per mission (ADR gateway-as-git-remote D6): a push its
 * mission may not make yet still uploads its pack before the review, so the
 * number a mission runs at once is bounded, beside the surface rate limit.
 */
import { MAX_PUSHES_IN_FLIGHT_PER_MISSION } from './constants';

export interface InFlightPushes {
  /** A release function, or `null` when the mission already runs its maximum. */
  acquire(missionId: string): (() => void) | null;
}

/**
 * single-process only — a counter per mission in this process. A deployment
 * with several replicas replaces it by a shared counter with a lease (the
 * same store as the surface rate limiter).
 */
export function inMemoryInFlightPushes(
  max: number = MAX_PUSHES_IN_FLIGHT_PER_MISSION,
): InFlightPushes {
  const running = new Map<string, number>();
  return {
    acquire(missionId) {
      const now = running.get(missionId) ?? 0;
      if (now >= max) return null;
      running.set(missionId, now + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (running.get(missionId) ?? 1) - 1;
        if (left <= 0) running.delete(missionId);
        else running.set(missionId, left);
      };
    },
  };
}
