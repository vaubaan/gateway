/**
 * Structural check: the session counters agree with the audit (spec §3.3 "the two
 * must agree; a structural test checks it", §10 "session counters agree with the
 * audit"). Per `(mission, risk, period)`:
 *
 *   SUM(session_counters.consumed) + credits given back by granted claims
 *     == COUNT(audit WHERE decision = 'allowed' AND risk touched)
 *
 * A granted claim (`reset` / quota `extension`, handbook requests) lowers the counters
 * without touching the audit; its session event records, per risk, how many actions it
 * gave back (`details.credits` for the period `details.period_start`), and the check
 * adds them back. Details are read through `parseEventDetails`: an event whose stored
 * details do not have the shape of its kind gives back nothing.
 *
 * Reusable: the integration suite asserts an empty `mismatches`; an operator
 * diagnostic may run it on a live store.
 */

import { parseEventDetails, type RiskId, type SessionEventKind } from '@vaubaan/shared';
import type { AuditRepo, EventRecord, SessionsRepo } from '../store/index.ts';
import { sessionCounterOf, type BudgetMission } from './mapping.ts';
import { consumedInPeriod } from './mission-state.ts';
import { currentPeriod, type CurrentPeriod } from './period.ts';

/** Upper bound of a one-off period's audit range: the period never ends. */
const OPEN_ENDED_UNTIL = '9999-12-31T23:59:59.999Z';

export interface CounterAuditLine {
  readonly risk_id: RiskId;
  /** Sum of the session counters of the period. */
  readonly counted: number;
  /** Actions given back by granted claims in the period. */
  readonly credited: number;
  readonly audited: number;
}

export type CounterAuditMismatch = CounterAuditLine;

/** Session event kinds that may carry `details.credits` (a granted claim). */
export const CREDIT_EVENT_KINDS = [
  'reset',
  'extension',
] as const satisfies readonly SessionEventKind[];

export interface CounterAuditReport {
  readonly mission_id: string;
  readonly period: CurrentPeriod;
  /** One line per accepted risk. */
  readonly risks: readonly CounterAuditLine[];
  readonly mismatches: readonly CounterAuditMismatch[];
}

export interface ConsistencyDeps {
  readonly sessions: Pick<SessionsRepo, 'getByMission' | 'counters' | 'listEvents'>;
  readonly audit: Pick<AuditRepo, 'countAllowedTouches'>;
}

export async function countersAgreeWithAudit(
  deps: ConsistencyDeps,
  mission: BudgetMission,
  now: Date,
): Promise<CounterAuditReport> {
  const period = currentPeriod(mission.period, now);
  const session = await deps.sessions.getByMission(mission.id);
  const counters = session ? await deps.sessions.counters(session.id, period.start) : [];
  const counted = consumedInPeriod(counters.map(sessionCounterOf), period.start);
  const credited = session
    ? creditsOf(
        await deps.sessions.listEvents(session.id, {
          since: period.start,
          kinds: CREDIT_EVENT_KINDS,
          limit: Number.MAX_SAFE_INTEGER,
        }),
        period.start,
      )
    : new Map<RiskId, number>();
  const risks = await Promise.all(
    mission.policy.map(async (entry) => ({
      risk_id: entry.risk_id,
      counted: counted.get(entry.risk_id) ?? 0,
      credited: credited.get(entry.risk_id) ?? 0,
      audited: await deps.audit.countAllowedTouches(
        mission.id,
        entry.risk_id,
        period.start,
        period.end ?? OPEN_ENDED_UNTIL,
      ),
    })),
  );
  return {
    mission_id: mission.id,
    period,
    risks,
    mismatches: risks.filter((r) => r.counted + r.credited !== r.audited),
  };
}

/** Sums `details.credits` of the credit events that concern the period. */
function creditsOf(events: readonly EventRecord[], periodStart: string): Map<RiskId, number> {
  const total = new Map<RiskId, number>();
  for (const event of events) {
    const parsed = parseEventDetails(event.kind, event.details);
    if (!parsed || !('credits' in parsed.details)) continue;
    if (parsed.details.period_start !== periodStart) continue;
    for (const [riskId, amount] of Object.entries(parsed.details.credits)) {
      total.set(riskId, (total.get(riskId) ?? 0) + amount);
    }
  }
  return total;
}
