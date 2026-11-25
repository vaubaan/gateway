/**
 * Mission state derivation — pure.
 *
 * Spec §2.3: `active`, `exhausted` (per risk, never a stored status), `expired`,
 * `orphaned`, `revoked`. The store persists `active | expired | revoked`; `orphaned`
 * is derived from the creator's current authority before the mission gets here
 * (`MissionGrounds.inspect`, handbook authority), so the `status` read below is the
 * derived one; `expired` may also follow from `expires_at` before anyone flips the
 * column; `exhausted` follows from the counters of the current period. The
 * rollover is applied here too: counters of past periods are ignored, so a mission
 * whose period ended reads as un-exhausted without any job (spec §3.3).
 */

import {
  lineKeyOf,
  policyLineKey,
  type Iso8601,
  type MissionPolicy,
  type MissionStatus,
  type PolicyLineKey,
  type MissionLogCounter,
} from '@vaubaan/shared';
import { currentPeriod, type CurrentPeriod, type PeriodSpec } from './period.ts';

export type MissionState =
  | { readonly kind: 'revoked' }
  | { readonly kind: 'orphaned' }
  | { readonly kind: 'expired'; readonly expires_at: Iso8601 | null }
  | {
      readonly kind: 'active';
      readonly period: CurrentPeriod;
      /** Accepted lines (a risk in a resource set) whose quota is spent for the current period (spec §2.3). */
      readonly exhausted: readonly PolicyLineKey[];
      /** Remaining actions per accepted line in the current period (`lineKeyOf`). */
      readonly remaining: Readonly<Record<PolicyLineKey, number>>;
    };

export interface MissionStateInput {
  readonly status: MissionStatus;
  readonly expires_at: Iso8601 | null;
  readonly period: PeriodSpec;
  readonly policy: MissionPolicy;
}

/** A counter row as the derivation needs it: set, risk, period key, consumed. */
export type PeriodCounter = Pick<
  MissionLogCounter,
  'resource_set_id' | 'risk_id' | 'period_start' | 'consumed'
>;

/** Consumed actions per line (set, risk) for the period that starts at `periodStart`. */
export function consumedInPeriod(
  counters: readonly PeriodCounter[],
  periodStart: Iso8601,
): Map<PolicyLineKey, number> {
  const consumed = new Map<PolicyLineKey, number>();
  for (const counter of counters) {
    if (counter.period_start !== periodStart) continue;
    const key = policyLineKey(counter.resource_set_id, counter.risk_id);
    consumed.set(key, (consumed.get(key) ?? 0) + counter.consumed);
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
  const remaining: Record<PolicyLineKey, number> = {};
  const exhausted: PolicyLineKey[] = [];
  for (const entry of mission.policy) {
    const key = lineKeyOf(entry);
    const left = entry.quota - (consumed.get(key) ?? 0);
    remaining[key] = Math.max(0, left);
    if (left <= 0) exhausted.push(key);
  }
  return { kind: 'active', period, exhausted, remaining };
}
