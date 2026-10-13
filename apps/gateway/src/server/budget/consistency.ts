/**
 * Structural check: the session counters agree with the audit (spec §3.3 "the two
 * must agree; a structural test checks it", §10 "session counters agree with the
 * audit"). Per `(mission, risk, period)`:
 *
 *   SUM(session_counters.consumed) == COUNT(audit WHERE decision = 'allowed' AND risk touched)
 *
 * Reusable: the integration suite asserts an empty `mismatches`; an operator
 * diagnostic may run it on a live store.
 */

import type { RiskId } from '@vaubaan/shared';
import type { AuditRepo, SessionsRepo } from '../store/index.ts';
import type { BudgetMission } from './mapping.ts';
import { currentPeriod, type CurrentPeriod } from './period.ts';

/** Upper bound of a one-off period's audit range: the period never ends. */
const OPEN_ENDED_UNTIL = '9999-12-31T23:59:59.999Z';

export interface CounterAuditMismatch {
  readonly risk_id: RiskId;
  readonly counted: number;
  readonly audited: number;
}

export interface CounterAuditReport {
  readonly mission_id: string;
  readonly period: CurrentPeriod;
  /** One line per accepted risk. */
  readonly risks: readonly {
    readonly risk_id: RiskId;
    readonly counted: number;
    readonly audited: number;
  }[];
  readonly mismatches: readonly CounterAuditMismatch[];
}

export interface ConsistencyDeps {
  readonly sessions: Pick<SessionsRepo, 'getByMission' | 'counters'>;
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
  const risks = await Promise.all(
    mission.policy.map(async (entry) => ({
      risk_id: entry.risk_id,
      counted: counters
        .filter((c) => c.riskId === entry.risk_id)
        .reduce((sum, c) => sum + c.consumed, 0),
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
    mismatches: risks.filter((r) => r.counted !== r.audited),
  };
}
