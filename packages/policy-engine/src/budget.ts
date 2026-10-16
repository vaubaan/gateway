/**
 * The budget rule — one pure function for every place a budget is judged.
 *
 * Spec : docs/spec/vaubaan-gateway.md §3.2 ("always numbers, never
 *        unbounded" : a quota and a rate limit per accepted risk, a gate
 *        from the closed set).
 *
 * A preset entry and a mission policy entry carry the same three fields
 * (`quota`, `rate_limit`, `gate`). Whether they are acceptable is decided
 * here and nowhere else : the SDK's YAML loader, `presetIssues` (the path of
 * a catalog written in TypeScript : `definePlugin`, the registry, the test
 * kit) and the application's issuance preview all call `budgetIssues`.
 *
 * Browser-safe : the gate set comes from `@vaubaan/shared/domain`, never
 * from the server-only barrel.
 */

import type { Gate, RateLimit } from '@vaubaan/shared';
import { GATES, isGate } from '@vaubaan/shared/domain';

/** The three budget fields as they arrive : from YAML, from a TypeScript literal, from a form. */
export interface BudgetInput {
  readonly quota: unknown;
  readonly rate_limit: unknown;
  readonly gate: unknown;
}

/** What `BudgetInput` is once `budgetIssues` found nothing. */
export interface ValidBudget {
  readonly quota: number;
  readonly rate_limit: RateLimit;
  readonly gate: Gate;
}

/** The path of an illegal value inside the entry. */
export type BudgetField =
  | 'quota'
  | 'rate_limit'
  | 'rate_limit.max'
  | 'rate_limit.window_seconds'
  | 'gate';

export interface BudgetIssue {
  readonly field: BudgetField;
  /** What was expected, without the path : callers prefix their own (`presets[0].entries[2].quota: …`). */
  readonly message: string;
}

export const SECONDS_PER_MINUTE = 60;

/** A whole number of at least 1. `Infinity`, `NaN`, fractions, zero and negatives are not. */
export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/**
 * Every reason a budget is not acceptable, in field order ; empty = valid.
 * The quota and both members of the rate limit are positive integers (no
 * infinite budget, no zero or negative rate, no zero window) and the gate
 * is one of `GATES`. An absent `gate` is an issue : a caller that defaults
 * it (the YAML loader : `auto`) does so before calling.
 */
export function budgetIssues(entry: BudgetInput): BudgetIssue[] {
  const issues: BudgetIssue[] = [];
  if (!isPositiveInteger(entry.quota)) {
    issues.push({
      field: 'quota',
      message: 'expected a positive integer (no infinite budget, spec §3.2)',
    });
  }
  const rate = entry.rate_limit;
  if (!isRateLimitShape(rate)) {
    issues.push({ field: 'rate_limit', message: 'expected { max, window_seconds }' });
  } else {
    if (!isPositiveInteger(rate.max)) {
      issues.push({ field: 'rate_limit.max', message: 'expected a positive integer' });
    }
    if (!isPositiveInteger(rate.window_seconds)) {
      issues.push({ field: 'rate_limit.window_seconds', message: 'expected a positive integer' });
    }
  }
  if (typeof entry.gate !== 'string' || !isGate(entry.gate)) {
    issues.push({ field: 'gate', message: `expected one of ${GATES.join(' | ')}` });
  }
  return issues;
}

/** Type guard over `budgetIssues` : the entry carries a budget the gateway can enforce. */
export function isValidBudget<T extends BudgetInput>(entry: T): entry is T & ValidBudget {
  return budgetIssues(entry).length === 0;
}

/** The rate limit expressed per minute, the unit of a catalog's rate ceiling. */
export function ratePerMinute(rate: RateLimit): number {
  return (rate.max * SECONDS_PER_MINUTE) / rate.window_seconds;
}

/** True iff a rate limit is faster than a per-minute ceiling. No ceiling (`null` / `undefined`) : never. */
export function exceedsRateCeiling(
  rate: RateLimit,
  ceilingPerMinute: number | null | undefined,
): boolean {
  if (ceilingPerMinute === null || ceilingPerMinute === undefined) return false;
  return ratePerMinute(rate) > ceilingPerMinute;
}

function isRateLimitShape(
  x: unknown,
): x is { readonly max: unknown; readonly window_seconds: unknown } {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
