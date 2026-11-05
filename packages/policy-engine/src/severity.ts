/**
 * Severity — the one word a permission is printed with, and the score that
 * orders permissions. Pure and browser-safe: the gateway's interface and the
 * site compute it with this one function (style guide §2: "its severity is
 * one word").
 *
 * The score orders, it never decides (risk model: "no gate is derived from
 * the vector"); gates come from the trust level's tier (`trust-level.ts`).
 */

import type { RiskVector } from '@vaubaan/shared';

/**
 * Rank of each axis value, mildest first — the order of `RISK_VECTOR_AXES`
 * in `@vaubaan/shared`, restated here because that constant lives in the
 * server-only barrel. A unit test keeps the two in step.
 */
export const SEVERITY_RANKS: { readonly [K in keyof RiskVector]: readonly RiskVector[K][] } = {
  reversibility: ['reversible', 'costly', 'irreversible'],
  blast: ['single', 'env', 'account', 'bulk'],
  data: ['metadata', 'data', 'secret', 'pii'],
  cost: ['free', 'moderate', 'unbounded'],
  visibility: ['internal', 'team', 'public'],
  persistence: ['stateless', 'session', 'posture'],
};

/** Highest possible `severityOf` (every axis at its worst). */
export const MAX_SEVERITY = Object.values(SEVERITY_RANKS).reduce(
  (sum, values) => sum + values.length - 1,
  0,
);

export const SEVERITY_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type SeverityLevel = (typeof SEVERITY_LEVELS)[number];

/**
 * Sum of the axis ranks, 0 (harmless read) to `MAX_SEVERITY`. It orders
 * risks in the interface and names "the most severe one" of a policy.
 */
export function severityOf(vector: RiskVector): number {
  let score = 0;
  for (const axis of Object.keys(SEVERITY_RANKS) as (keyof RiskVector)[]) {
    const rank = (SEVERITY_RANKS[axis] as readonly string[]).indexOf(vector[axis]);
    score += Math.max(rank, 0);
  }
  return score;
}

/** The word of a score: low, medium, high or critical. */
export function severityLevel(score: number): SeverityLevel {
  if (score >= 10) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}
