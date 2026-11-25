/**
 * Structural check: the mission log counters agree with the audit (spec §3.3 "the two
 * must agree; a structural test checks it", §10 "mission log counters agree with the
 * audit"). Per `(mission, resource set, risk, period)` (risk model §4.7: a call charged
 * on several sets counts once in each):
 *
 *   SUM(mission_log_counters.consumed) + credits given back by granted claims
 *     == COUNT(audit WHERE decision = 'allowed' AND risk touched)
 *
 * A granted claim (`reset` / quota `extension`, handbook requests) lowers the counters
 * without touching the audit; its mission log event records, per risk, how many actions it
 * gave back (`details.credits` for the period `details.period_start`), and the check
 * adds them back. Details are read through `parseEventDetails`: an event whose stored
 * details do not have the shape of its kind gives back nothing.
 *
 * Reusable: the integration suite asserts an empty `mismatches`; an operator
 * diagnostic may run it on a live store.
 */

import {
  lineKeyOf,
  parseEventDetails,
  policyLineKey,
  type PolicyLineKey,
  type RiskId,
  type MissionLogEventKind,
} from '@vaubaan/shared';
import type { AuditRepo, EventRecord, MissionLogsRepo } from '../store/index.ts';
import { missionLogCounterOf, type BudgetMission } from './mapping.ts';
import { consumedInPeriod } from './mission-state.ts';
import { currentPeriod, type CurrentPeriod } from './period.ts';

/** Upper bound of a one-off period's audit range: the period never ends. */
const OPEN_ENDED_UNTIL = '9999-12-31T23:59:59.999Z';

export interface CounterAuditLine {
  readonly resource_set_id: string;
  readonly risk_id: RiskId;
  /** Sum of the mission log counters of the period. */
  readonly counted: number;
  /** Actions given back by granted claims in the period. */
  readonly credited: number;
  readonly audited: number;
}

export type CounterAuditMismatch = CounterAuditLine;

/** Mission log event kinds that may carry `details.credits` (a granted claim). */
export const CREDIT_EVENT_KINDS = [
  'reset',
  'extension',
] as const satisfies readonly MissionLogEventKind[];

export interface CounterAuditReport {
  readonly mission_id: string;
  readonly period: CurrentPeriod;
  /** One line per accepted line of the policy (a risk in a resource set). */
  readonly risks: readonly CounterAuditLine[];
  readonly mismatches: readonly CounterAuditMismatch[];
}

export interface ConsistencyDeps {
  readonly missionLogs: Pick<MissionLogsRepo, 'getByMission' | 'counters' | 'listEvents'>;
  readonly audit: Pick<AuditRepo, 'countAllowedTouches'>;
}

export async function countersAgreeWithAudit(
  deps: ConsistencyDeps,
  mission: BudgetMission,
  now: Date,
): Promise<CounterAuditReport> {
  const period = currentPeriod(mission.period, now);
  const missionLog = await deps.missionLogs.getByMission(mission.id);
  const counters = missionLog ? await deps.missionLogs.counters(missionLog.id, period.start) : [];
  const counted = consumedInPeriod(counters.map(missionLogCounterOf), period.start);
  const credited = missionLog
    ? creditsOf(
        await deps.missionLogs.listEvents(missionLog.id, {
          since: period.start,
          kinds: CREDIT_EVENT_KINDS,
          limit: Number.MAX_SAFE_INTEGER,
        }),
        period.start,
      )
    : new Map<PolicyLineKey, number>();
  const risks = await Promise.all(
    mission.policy.map(async (entry) => ({
      resource_set_id: entry.resource_set_id ?? '',
      risk_id: entry.risk_id,
      counted: counted.get(lineKeyOf(entry)) ?? 0,
      credited: credited.get(lineKeyOf(entry)) ?? 0,
      audited: await deps.audit.countAllowedTouches(
        mission.id,
        entry.resource_set_id ?? '',
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

/**
 * Sums `details.credits` of the credit events that concern the period, per line: the
 * credits of an event are in the set the event names (a claim is about one line).
 */
function creditsOf(
  events: readonly EventRecord[],
  periodStart: string,
): Map<PolicyLineKey, number> {
  const total = new Map<PolicyLineKey, number>();
  for (const event of events) {
    const parsed = parseEventDetails(event.kind, event.details);
    if (!parsed || !('credits' in parsed.details)) continue;
    if (parsed.details.period_start !== periodStart || event.resourceSetId === null) continue;
    for (const [riskId, amount] of Object.entries(parsed.details.credits)) {
      const key = policyLineKey(event.resourceSetId, riskId);
      total.set(key, (total.get(key) ?? 0) + amount);
    }
  }
  return total;
}
