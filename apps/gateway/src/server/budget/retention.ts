/**
 * Retention of the session history (spec §6 "Purge by operator-configured
 * retention", §8; product owner's decision of 2026-10-13).
 *
 * A session timeline says what the audit says — which tool, when, for whom,
 * under which agent label — and the counters of a past period say how much.
 * Both leave with the audit entries of the same age: `retention_days` is one
 * promise about how long the instance remembers a call.
 *
 * What is removed, per session:
 *
 *   events    older than the cutoff, except the ones the budget still reads:
 *             an event of `PERIOD_STATE_EVENT_KINDS` written since the start
 *             of the mission's current period is kept whatever its age (a gate
 *             opened "until the period ends" stays open; the credits a granted
 *             claim gave back stay accounted for).
 *   counters  of a period that is over and ended before the cutoff. The
 *             counters of the current period are never touched: they are the
 *             budget. A one-off mission has one period that never ends, so
 *             none of its counters is ever removed.
 *
 * The period is computed here, on read, like everywhere else (`currentPeriod`).
 */
import type { SessionEventKind } from '@vaubaan/shared';

import { toIso, type Clock } from '../store/clock.ts';
import type { MissionsRepo, SessionsRepo } from '../store/index.ts';
import { CREDIT_EVENT_KINDS } from './consistency.ts';
import { GATE_EVENT_KINDS } from './gates.ts';
import { budgetPeriodOf } from './mapping.ts';
import { currentPeriod } from './period.ts';

const MS_PER_DAY = 86_400_000;
const MS_PER_SECOND = 1000;

/**
 * The events a decision or the counters' check reads back from the start of the
 * current period: they are state, not history, until the period is over.
 */
export const PERIOD_STATE_EVENT_KINDS: readonly SessionEventKind[] = [
  ...GATE_EVENT_KINDS,
  ...CREDIT_EVENT_KINDS,
];

export interface SessionHistoryPurge {
  readonly events: number;
  readonly counters: number;
}

export interface SessionHistoryRetentionDeps {
  readonly sessions: Pick<SessionsRepo, 'withHistoryBefore' | 'purgeHistory'>;
  readonly missions: Pick<MissionsRepo, 'getById'>;
  readonly clock: Clock;
}

export class SessionHistoryRetention {
  constructor(private readonly deps: SessionHistoryRetentionDeps) {}

  /** Removes what is older than `retentionDays`; idempotent and bounded by its cutoff. */
  async purge(retentionDays: number): Promise<SessionHistoryPurge> {
    if (!Number.isInteger(retentionDays) || retentionDays < 1) {
      throw new RangeError('retention must be a positive number of days');
    }
    const now = this.deps.clock.now();
    const cutoffMs = now.getTime() - retentionDays * MS_PER_DAY;
    const cutoff = toIso(new Date(cutoffMs));
    let events = 0;
    let counters = 0;
    for (const session of await this.deps.sessions.withHistoryBefore(cutoff)) {
      const { id: sessionId, missionId } = session;
      const mission = await this.deps.missions.getById(missionId);
      if (!mission) continue;
      const spec = budgetPeriodOf(mission);
      const period = currentPeriod(spec, now);
      // A past period ended at `start + length`: it is older than the cutoff when its
      // start is older than `cutoff - length`. Never the current one.
      const countersBefore =
        spec.length_seconds === null
          ? null
          : earliest(period.start, toIso(new Date(cutoffMs - spec.length_seconds * MS_PER_SECOND)));
      const removed = await this.deps.sessions.purgeHistory(sessionId, {
        eventsBefore: cutoff,
        keep: { kinds: PERIOD_STATE_EVENT_KINDS, since: period.start },
        countersBefore,
      });
      events += removed.events;
      counters += removed.counters;
    }
    return { events, counters };
  }
}

function earliest(a: string, b: string): string {
  return a < b ? a : b;
}
