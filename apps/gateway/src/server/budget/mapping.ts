/**
 * Store records → budget domain values.
 *
 * The store keeps camelCase persistence records (`MissionRecord`, `MissionPolicyEntry`
 * with flat `rateLimit` / `rateWindowSeconds`, `SessionCounterRecord`); the budget
 * speaks `@vaubaan/shared`'s vocabulary (`MissionPolicyEntry` with `rate_limit: { max,
 * window_seconds }`, `SessionCounter`). This module is the only place that translates
 * between the two, so neither side renames anything for the other.
 */

import type {
  Iso8601,
  MissionPolicy,
  MissionPolicyEntry,
  MissionStatus,
  SessionCounter,
} from '@vaubaan/shared';
import type {
  MissionPolicyEntry as MissionPolicyEntryRecord,
  MissionRecord,
  SessionCounterRecord,
} from '../store/types.ts';
import type { PeriodSpec } from './period.ts';

/** What the budget needs of a mission: identity, lifecycle, period and policy. */
export interface BudgetMission {
  readonly id: string;
  readonly status: MissionStatus;
  readonly expires_at: Iso8601 | null;
  readonly period: PeriodSpec;
  readonly policy: MissionPolicy;
}

export function policyEntryOf(record: MissionPolicyEntryRecord): MissionPolicyEntry {
  return {
    risk_id: record.riskId,
    quota: record.quota,
    rate_limit: { max: record.rateLimit, window_seconds: record.rateWindowSeconds },
    gate: record.gate,
  };
}

export function budgetMissionOf(record: MissionRecord): BudgetMission {
  return {
    id: record.id,
    status: record.status,
    expires_at: record.expiresAt,
    period: { anchor_at: record.periodAnchor, length_seconds: record.periodSeconds },
    policy: record.policy.map(policyEntryOf),
  };
}

export function sessionCounterOf(record: SessionCounterRecord): SessionCounter {
  return {
    session_id: record.sessionId,
    risk_id: record.riskId,
    period_start: record.periodStart,
    consumed: record.consumed,
  };
}
