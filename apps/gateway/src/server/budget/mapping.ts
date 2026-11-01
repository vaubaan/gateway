/**
 * Store records ⇄ domain values, for missions and the budget.
 *
 * The store keeps camelCase persistence records (`MissionRecord`, its policy entries
 * with flat `rateLimit` / `rateWindowSeconds`, `SessionCounterRecord`,
 * `ConnectionResourceRecord`); missions, the budget and the pipeline speak
 * `@vaubaan/shared`'s vocabulary (`MissionPolicyEntry` with `rate_limit: { max,
 * window_seconds }`, `Period`, `SessionCounter`). This module is the only place that
 * translates between the two, in both directions, so neither side renames anything for
 * the other: the policy entry (`policyEntryOf` / `policyEntryRecordOf`), the period
 * (`periodOf`, `statedPeriodOf`, `budgetPeriodOf`), the counter (`sessionCounterOf`) and
 * the staleness of a resource (`isStale`). A connection's own shapes are translated by
 * `connections/mapping.ts`.
 *
 * Naming: the store calls its camelCase policy entry `MissionPolicyEntry`, exactly
 * like the shared domain type; it is aliased here (`…Record`) rather than renamed.
 * Its selection is `MissionConnectionRecord`, apart from gateway-core's
 * `MissionConnection`.
 */

import type {
  Iso8601,
  MissionPolicy,
  MissionPolicyEntry,
  MissionStatus,
  Period,
  SessionCounter,
} from '@vaubaan/shared';
import type {
  ConnectionResourceRecord,
  MissionPolicyEntry as MissionPolicyEntryRecord,
  MissionPolicyLineInput,
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
  /** Every line names its resource set (`resource_set_id`). */
  readonly policy: MissionPolicy;
  /**
   * The resource sets of the mission, to name one in a refusal when its connection has
   * several (risk model §4.7). Absent: no set is named.
   */
  readonly resource_sets?: readonly BudgetResourceSet[];
}

/** What the budget knows of one resource set: where it is, to name it. */
export interface BudgetResourceSet {
  readonly id: string;
  readonly connection_id: string;
  /** From 1, among the sets of its connection. */
  readonly position: number;
}

/** "resource set 2" when the set's connection has several sets; `null` otherwise. */
export function resourceSetLabelOf(
  sets: readonly BudgetResourceSet[] | undefined,
  resourceSetId: string,
): string | null {
  const set = sets?.find((s) => s.id === resourceSetId);
  if (!set) return null;
  const siblings = (sets ?? []).filter((s) => s.connection_id === set.connection_id);
  return siblings.length > 1 ? `resource set ${set.position}` : null;
}

/** A period as a creator states it: no anchor, the store sets it at issuance. */
export type StatedPeriod =
  { readonly kind: 'one-off' } | { readonly kind: 'recurring'; readonly length_seconds: number };

export function policyEntryOf(record: MissionPolicyEntryRecord): MissionPolicyEntry {
  return {
    resource_set_id: record.resourceSetId,
    risk_id: record.riskId,
    quota: record.quota,
    rate_limit: { max: record.rateLimit, window_seconds: record.rateWindowSeconds },
    gate: record.gate,
  };
}

/** The inverse of `policyEntryOf`: what `MissionsRepo.replacePolicy` persists. */
export function policyEntryRecordOf(
  entry: MissionPolicyEntry & { readonly resource_set_id: string },
): MissionPolicyEntryRecord {
  return { resourceSetId: entry.resource_set_id, ...policyLineInputOf(entry) };
}

/** A line as a writer gives it inside its set (`MissionsRepo.create` / `edit`). */
export function policyLineInputOf(entry: MissionPolicyEntry): MissionPolicyLineInput {
  return {
    riskId: entry.risk_id,
    quota: entry.quota,
    rateLimit: entry.rate_limit.max,
    rateWindowSeconds: entry.rate_limit.window_seconds,
    gate: entry.gate,
  };
}

/** The period as the pipeline carries it (`MissionContext.mission.period`). */
export function periodOf(record: Pick<MissionRecord, 'periodAnchor' | 'periodSeconds'>): Period {
  return record.periodSeconds === null
    ? { kind: 'one-off' }
    : { kind: 'recurring', length_seconds: record.periodSeconds, anchor_at: record.periodAnchor };
}

/** The period as a draft, a detail page, a kit or an audit payload states it. */
export function statedPeriodOf(record: Pick<MissionRecord, 'periodSeconds'>): StatedPeriod {
  return record.periodSeconds === null
    ? { kind: 'one-off' }
    : { kind: 'recurring', length_seconds: record.periodSeconds };
}

/** The period as the budget computes with it: the anchor, even for a one-off mission. */
export function budgetPeriodOf(
  record: Pick<MissionRecord, 'periodAnchor' | 'periodSeconds'>,
): PeriodSpec {
  return { anchor_at: record.periodAnchor, length_seconds: record.periodSeconds };
}

/** True once the last discovery no longer returned the resource (spec §0 "Resource"). */
export function isStale(record: Pick<ConnectionResourceRecord, 'staleSince'>): boolean {
  return record.staleSince !== null;
}

export function budgetMissionOf(record: MissionRecord): BudgetMission {
  return {
    id: record.id,
    status: record.status,
    expires_at: record.expiresAt,
    period: budgetPeriodOf(record),
    policy: record.policy.map(policyEntryOf),
    resource_sets: record.connections.flatMap((c) =>
      c.resourceSets.map((set) => ({
        id: set.id,
        connection_id: c.connectionId,
        position: set.position,
      })),
    ),
  };
}

export function sessionCounterOf(record: SessionCounterRecord): SessionCounter {
  return {
    session_id: record.sessionId,
    resource_set_id: record.resourceSetId,
    risk_id: record.riskId,
    period_start: record.periodStart,
    consumed: record.consumed,
  };
}
