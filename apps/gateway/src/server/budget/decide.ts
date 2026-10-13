/**
 * The budget decision — pure.
 *
 * Spec §3.2 (unit, quota, rate limit, one budget per mission), §3.3 (session and
 * remaining budget), §3.5 (gate: whole-call refusal, approval consumed on replay, "the
 * gate does not replace the budget"), §6 ("authoritative, atomic counting"). Plan §3.5.
 *
 * `decide()` reads everything it needs from its input and returns what must happen:
 * either an allow with the counters to increment and the approvals to consume, or a
 * refusal naming its code and the risk that caused it. It performs no IO; the
 * `SessionService` runs it inside the store's `BEGIN IMMEDIATE` transaction and applies
 * the result. The three dimensions are checked in order across every touched risk:
 *
 *   1. quota    — any risk whose consumed count reached its quota: `budget-exhausted`;
 *   2. rate     — any risk whose sliding window is full: `rate-limited`;
 *   3. gate     — any risk gated `approval` (and not opened for the period) without a
 *                 matching approval: `approval-required`.
 *
 * Dimension-major order means a human is never asked to approve an action the budget
 * would refuse anyway. A refusal on one risk refuses the whole call (§3.5): nothing is
 * decremented, no approval is consumed.
 */

import type { MissionPolicy, MissionPolicyEntry, RateLimit, RiskId } from '@vaubaan/shared';
import { BudgetInvariantError } from './errors.ts';
import type { CurrentPeriod } from './period.ts';

/** What the rate window of one risk looks like at decision time. */
export interface RateProbe {
  /** Actions recorded inside the window. */
  readonly count: number;
  /** Seconds until the oldest action leaves the window (0 when the window is empty). */
  readonly retry_after_seconds: number;
}

export interface DecideInput {
  readonly policy: MissionPolicy;
  /** Risks the call touches (the risk stage guarantees they are accepted). */
  readonly risks_touched: readonly RiskId[];
  /** Consumed actions per touched risk in the current period (0 when absent). */
  readonly counters: ReadonlyMap<RiskId, number>;
  /** Rate window per touched risk (an empty window when absent). */
  readonly rate_windows: ReadonlyMap<RiskId, RateProbe>;
  readonly period: CurrentPeriod;
  /** Canonical fingerprint of the call's arguments (`fingerprintArguments`). */
  readonly fingerprint: string;
  /** Approval id available for this fingerprint, per gated risk (looked up by the
   *  caller inside the transaction; consumed only when the call is allowed). */
  readonly approvals?: ReadonlyMap<RiskId, string>;
  /** Risks whose gate the creator opened for the rest of the period (spec §3.5,
   *  `gate-opened` session event): treated as `auto` until the next period. */
  readonly opened_gates?: ReadonlySet<RiskId>;
}

export interface ApprovalToConsume {
  readonly risk_id: RiskId;
  readonly approval_id: string;
}

export interface Allow {
  readonly kind: 'allow';
  /** Distinct risks whose counter gains one action, in call order. */
  readonly decrements: readonly RiskId[];
  /** Remaining quota per touched risk after the decrement. */
  readonly remaining: Readonly<Record<RiskId, number>>;
  readonly approvals_to_consume: readonly ApprovalToConsume[];
}

export type BudgetRefusalCode = 'budget-exhausted' | 'rate-limited' | 'approval-required';

export type Refuse =
  | {
      readonly kind: 'refuse';
      readonly code: 'budget-exhausted';
      readonly risk_id: RiskId;
      readonly details: {
        readonly quota: number;
        readonly consumed: number;
        readonly period_end: string | null;
      };
    }
  | {
      readonly kind: 'refuse';
      readonly code: 'rate-limited';
      readonly risk_id: RiskId;
      readonly details: { readonly limit: RateLimit; readonly retry_after_seconds: number };
    }
  | {
      readonly kind: 'refuse';
      readonly code: 'approval-required';
      readonly risk_id: RiskId;
      readonly details: { readonly fingerprint: string };
    };

export type BudgetOutcome = Allow | Refuse;

const EMPTY_WINDOW: RateProbe = { count: 0, retry_after_seconds: 0 };

/** Distinct risks in first-seen order: one action per distinct risk per call. */
export function distinctRisks(risks: readonly RiskId[]): RiskId[] {
  return [...new Set(risks)];
}

function entryOf(policy: MissionPolicy, riskId: RiskId): MissionPolicyEntry {
  const entry = policy.find((e) => e.risk_id === riskId);
  if (!entry) {
    throw new BudgetInvariantError(
      `risk '${riskId}' is touched but absent from the mission policy; the risk stage must refuse it first`,
    );
  }
  return entry;
}

function exhaustedRefusal(
  entry: MissionPolicyEntry,
  consumed: number,
  period: CurrentPeriod,
): Refuse {
  return {
    kind: 'refuse',
    code: 'budget-exhausted',
    risk_id: entry.risk_id,
    details: { quota: entry.quota, consumed, period_end: period.end },
  };
}

function rateLimitedRefusal(entry: MissionPolicyEntry, probe: RateProbe): Refuse {
  return {
    kind: 'refuse',
    code: 'rate-limited',
    risk_id: entry.risk_id,
    details: {
      limit: entry.rate_limit,
      // The agent is told to wait at least one second: a sub-second window would
      // otherwise read "wait 0s" while still refusing.
      retry_after_seconds: Math.max(1, probe.retry_after_seconds),
    },
  };
}

/** Gate that applies to the risk now: `approval` unless the creator opened it. */
function effectiveGate(
  entry: MissionPolicyEntry,
  openedGates: ReadonlySet<RiskId>,
): 'auto' | 'approval' {
  return entry.gate === 'approval' && !openedGates.has(entry.risk_id) ? 'approval' : 'auto';
}

export function decide(input: DecideInput): BudgetOutcome {
  const risks = distinctRisks(input.risks_touched);
  const entries = risks.map((riskId) => entryOf(input.policy, riskId));
  const openedGates = input.opened_gates ?? new Set<RiskId>();
  const approvals = input.approvals ?? new Map<RiskId, string>();

  for (const entry of entries) {
    const consumed = input.counters.get(entry.risk_id) ?? 0;
    if (consumed >= entry.quota) return exhaustedRefusal(entry, consumed, input.period);
  }

  for (const entry of entries) {
    const probe = input.rate_windows.get(entry.risk_id) ?? EMPTY_WINDOW;
    if (probe.count >= entry.rate_limit.max) return rateLimitedRefusal(entry, probe);
  }

  const approvalsToConsume: ApprovalToConsume[] = [];
  for (const entry of entries) {
    if (effectiveGate(entry, openedGates) !== 'approval') continue;
    const approvalId = approvals.get(entry.risk_id);
    if (approvalId === undefined) {
      return {
        kind: 'refuse',
        code: 'approval-required',
        risk_id: entry.risk_id,
        details: { fingerprint: input.fingerprint },
      };
    }
    approvalsToConsume.push({ risk_id: entry.risk_id, approval_id: approvalId });
  }

  const remaining: Record<RiskId, number> = {};
  for (const entry of entries) {
    remaining[entry.risk_id] = entry.quota - (input.counters.get(entry.risk_id) ?? 0) - 1;
  }
  return { kind: 'allow', decrements: risks, remaining, approvals_to_consume: approvalsToConsume };
}
