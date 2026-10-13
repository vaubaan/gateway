/**
 * Mission state derivation — pure.
 *
 * Spec §2.3: `active`, `exhausted` (per risk, never a stored status), `expired`,
 * `orphaned`, `revoked`. The store persists `active | expired | orphaned | revoked`
 * (`MissionStatus`); `expired` may also follow from `expires_at` before anyone flips
 * the column; `exhausted` follows from the counters of the current period. The
 * rollover is applied here too: counters of past periods are ignored, so a mission
 * whose period ended reads as un-exhausted without any job (spec §3.3).
 */

import type {
  Iso8601,
  MissionPolicy,
  MissionStatus,
  RiskId,
  SessionCounter,
} from '@vaubaan/shared';
import { currentPeriod, type CurrentPeriod, type PeriodSpec } from './period.ts';

export type MissionState =
  | { readonly kind: 'revoked' }
  | { readonly kind: 'orphaned' }
  | { readonly kind: 'expired'; readonly expires_at: Iso8601 | null }
  | {
      readonly kind: 'active';
      readonly period: CurrentPeriod;
      /** Accepted risks whose quota is spent for the current period (spec §2.3). */
      readonly exhausted: readonly RiskId[];
      /** Remaining actions per accepted risk in the current period. */
      readonly remaining: Readonly<Record<RiskId, number>>;
    };

export interface MissionStateInput {
  readonly status: MissionStatus;
  readonly expires_at: Iso8601 | null;
  readonly period: PeriodSpec;
  readonly policy: MissionPolicy;
}

/** A counter row as the derivation needs it: risk, period key, consumed. */
export type PeriodCounter = Pick<SessionCounter, 'risk_id' | 'period_start' | 'consumed'>;

/** Consumed actions per risk for the period that starts at `periodStart`. */
export function consumedInPeriod(
  counters: readonly PeriodCounter[],
  periodStart: Iso8601,
): Map<RiskId, number> {
  const consumed = new Map<RiskId, number>();
  for (const counter of counters) {
    if (counter.period_start !== periodStart) continue;
    consumed.set(counter.risk_id, (consumed.get(counter.risk_id) ?? 0) + counter.consumed);
  }
  return consumed;
}

export function deriveMissionState(
  mission: MissionStateInput,
  counters: readonly PeriodCounter[],
  now: Date,
): MissionState {
  switch (mission.status) {
    case 'revoked':
      return { kind: 'revoked' };
    case 'orphaned':
      return { kind: 'orphaned' };
    case 'expired':
      return { kind: 'expired', expires_at: mission.expires_at };
    case 'active':
      break;
  }
  if (mission.expires_at !== null && Date.parse(mission.expires_at) <= now.getTime()) {
    return { kind: 'expired', expires_at: mission.expires_at };
  }
  const period = currentPeriod(mission.period, now);
  const consumed = consumedInPeriod(counters, period.start);
  const remaining: Record<RiskId, number> = {};
  const exhausted: RiskId[] = [];
  for (const entry of mission.policy) {
    const left = entry.quota - (consumed.get(entry.risk_id) ?? 0);
    remaining[entry.risk_id] = Math.max(0, left);
    if (left <= 0) exhausted.push(entry.risk_id);
  }
  return { kind: 'active', period, exhausted, remaining };
}
