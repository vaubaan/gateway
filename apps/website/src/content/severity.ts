/**
 * The one severity word of a permission, as the gateway's interface prints it
 * (style guide §2: "its severity is one word"). Computed from the risk's six
 * axes exactly as `apps/gateway/src/server/missions/catalog-view.ts`
 * (`severityOf`, `severityLevel`) computes it; the site may not import the
 * gateway (ADR website-nextjs-on-vercel D1), so `severity.test.ts` compares
 * the two functions over every possible vector.
 */
import type { RiskVector } from '@vaubaan/shared';

export const SEVERITY_RANKS: { readonly [K in keyof RiskVector]: readonly RiskVector[K][] } = {
  reversibility: ['reversible', 'costly', 'irreversible'],
  blast: ['single', 'env', 'account', 'bulk'],
  data: ['metadata', 'data', 'secret', 'pii'],
  cost: ['free', 'moderate', 'unbounded'],
  visibility: ['internal', 'team', 'public'],
  persistence: ['stateless', 'session', 'posture'],
};

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export function severityOf(vector: RiskVector): Severity {
  let score = 0;
  for (const axis of Object.keys(SEVERITY_RANKS) as (keyof RiskVector)[]) {
    const rank = (SEVERITY_RANKS[axis] as readonly string[]).indexOf(vector[axis]);
    score += Math.max(rank, 0);
  }
  if (score >= 10) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}
