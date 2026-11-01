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
 *   3. gate     — any risk gated `approval` (and not opened for the period, `gates.ts`)
 *                 without a matching approval: `approval-required`, naming EVERY
 *                 gated risk of the call, so that one request covers the call.
 *
 * Dimension-major order means a human is never asked to approve an action the budget
 * would refuse anyway. A refusal on one risk refuses the whole call (§3.5): nothing is
 * decremented, no approval is consumed.
 */

import {
  policyLineKey,
  type MissionPolicy,
  type MissionPolicyEntry,
  type PolicyLineKey,
  type RateLimit,
  type RiskId,
} from '@vaubaan/shared';
import { BudgetInvariantError } from './errors.ts';
import { effectiveGate } from './gates.ts';
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
  /** Approval id available for this call, per gated risk it covers (looked up by the
   *  caller inside the transaction; consumed only when the call is allowed). One
   *  approval may cover several risks: the same id then stands under each. */
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
      /** The first gated risk of the call no approval covers. */
      readonly risk_id: RiskId;
      readonly details: {
        readonly fingerprint: string;
        /**
         * Every risk of the call whose gate asks the creator now, in call order — the
         * ones an approval already covers included: the request dropped for this
         * refusal covers the call, not the missing part of it.
         */
        readonly gated_risks: readonly RiskId[];
      };
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

  const gated = entries
    .filter((entry) => effectiveGate(entry, openedGates) === 'approval')
    .map((entry) => entry.risk_id);
  const uncovered = gated.find((riskId) => !approvals.has(riskId));
  if (uncovered !== undefined) {
    return {
      kind: 'refuse',
      code: 'approval-required',
      risk_id: uncovered,
      details: { fingerprint: input.fingerprint, gated_risks: gated },
    };
  }
  const approvalsToConsume: ApprovalToConsume[] = gated.map((riskId) => ({
    risk_id: riskId,
    // `uncovered` is undefined: every gated risk has an approval.
    approval_id: approvals.get(riskId)!,
  }));

  const remaining: Record<RiskId, number> = {};
  for (const entry of entries) {
    remaining[entry.risk_id] = entry.quota - (input.counters.get(entry.risk_id) ?? 0) - 1;
  }
  return { kind: 'allow', decrements: risks, remaining, approvals_to_consume: approvalsToConsume };
}

// ─────────────────────────────────────────────────────────────────────────────
// Several resource sets (risk model §4.7)
// ─────────────────────────────────────────────────────────────────────────────

/** One line of the policy a call is charged on: a risk in one resource set. */
export interface BudgetLine {
  readonly resource_set_id: string;
  readonly risk_id: RiskId;
}

/** The decision of one candidate set: `decide()` over that set's lines. */
export interface SetDecision {
  readonly resource_set_id: string;
  readonly outcome: BudgetOutcome;
}

export interface AllowAcrossSets {
  readonly kind: 'allow';
  /** Every (set, touched risk) line whose counter gains one action. */
  readonly decrements: readonly BudgetLine[];
  /** Remaining quota per touched line after the decrement. */
  readonly remaining: Readonly<Record<PolicyLineKey, number>>;
  /** Approvals consumed, each once whatever the number of sets it stood under. */
  readonly approvals_to_consume: readonly ApprovalToConsume[];
}

/** A refusal of one set, with the set that caused it; an approval names every gated line. */
export type RefuseAcrossSets = Refuse & {
  readonly resource_set_id: string;
  /** For `approval-required`: the gated line of each set whose gate asks now. */
  readonly gated_lines: readonly BudgetLine[];
};

export type BudgetOutcomeAcrossSets = AllowAcrossSets | RefuseAcrossSets;

const REFUSAL_ORDER: readonly BudgetRefusalCode[] = [
  'budget-exhausted',
  'rate-limited',
  'approval-required',
];

/**
 * The call's outcome from the decision of each candidate set (risk model §4.7): each
 * set's quota and rate limit are checked and charged, and the most restrictive gate
 * applies. The order stays dimension-major across the sets: a quota refusal in any set
 * comes before a rate refusal in any, and both before an approval, so a human is never
 * asked to approve what another set's budget refuses. An approval request covers the
 * call: every gated risk of every set. Pure.
 */
export function combineSetDecisions(decisions: readonly SetDecision[]): BudgetOutcomeAcrossSets {
  if (decisions.length === 0) {
    throw new BudgetInvariantError('a call is charged on at least one resource set');
  }
  const gatedLines: BudgetLine[] = [];
  for (const { resource_set_id, outcome } of decisions) {
    const gated =
      outcome.kind === 'allow'
        ? outcome.approvals_to_consume.map((a) => a.risk_id)
        : outcome.code === 'approval-required'
          ? outcome.details.gated_risks
          : [];
    for (const risk_id of gated) gatedLines.push({ resource_set_id, risk_id });
  }
  for (const code of REFUSAL_ORDER) {
    const refused = decisions.find(
      (d): d is SetDecision & { readonly outcome: Refuse } =>
        d.outcome.kind === 'refuse' && d.outcome.code === code,
    );
    if (!refused) continue;
    const { outcome } = refused;
    if (outcome.code === 'approval-required') {
      return {
        ...outcome,
        details: {
          ...outcome.details,
          gated_risks: distinctRisks(gatedLines.map((line) => line.risk_id)),
        },
        resource_set_id: refused.resource_set_id,
        gated_lines: gatedLines,
      };
    }
    return { ...outcome, resource_set_id: refused.resource_set_id, gated_lines: [] };
  }
  const decrements: BudgetLine[] = [];
  const remaining: Record<PolicyLineKey, number> = {};
  const approvals = new Map<string, ApprovalToConsume>();
  for (const { resource_set_id, outcome } of decisions) {
    if (outcome.kind !== 'allow') continue;
    for (const risk_id of outcome.decrements) decrements.push({ resource_set_id, risk_id });
    for (const [risk_id, left] of Object.entries(outcome.remaining)) {
      remaining[policyLineKey(resource_set_id, risk_id)] = left;
    }
    for (const approval of outcome.approvals_to_consume) {
      if (!approvals.has(approval.approval_id)) approvals.set(approval.approval_id, approval);
    }
  }
  return {
    kind: 'allow',
    decrements,
    remaining,
    approvals_to_consume: [...approvals.values()],
  };
}
