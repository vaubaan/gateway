/**
 * The derivations of the home — pure, browser-safe.
 *
 * `nearestLimit` is the one figure a mission's row may show: the permission
 * closest to its limit in the current period. The page draws it only near the
 * limit (the `Meter`'s threshold); below, the row shows a dash.
 */
import { policyLineKey, type PolicyLineKey } from '@vaubaan/shared/domain';
import type { RiskId } from '@vaubaan/shared';

export interface LimitLine {
  readonly risk_id: RiskId;
  readonly label: string;
  /** Actions used in the current period, never above `limit`. */
  readonly used: number;
  readonly limit: number;
}

interface PolicyLine {
  readonly resourceSetId: string;
  readonly riskId: RiskId;
  readonly quota: number;
}

/**
 * The accepted permission whose usage is the largest share of its limit; ties
 * go to the one listed first. `null` for an empty policy. A limit of zero
 * counts as reached.
 */
export function nearestLimit(
  policy: readonly PolicyLine[],
  /** Per line (`policyLineKey`): a risk in two resource sets is two lines. */
  remaining: Readonly<Record<PolicyLineKey, number>>,
  labelOf: (riskId: RiskId) => string,
): LimitLine | null {
  let nearest: LimitLine | null = null;
  let nearestShare = -1;
  for (const entry of policy) {
    const left = Math.max(
      0,
      Math.min(
        entry.quota,
        remaining[policyLineKey(entry.resourceSetId, entry.riskId)] ?? entry.quota,
      ),
    );
    const used = entry.quota - left;
    const share = entry.quota <= 0 ? 1 : used / entry.quota;
    if (share > nearestShare) {
      nearestShare = share;
      nearest = { risk_id: entry.riskId, label: labelOf(entry.riskId), used, limit: entry.quota };
    }
  }
  return nearest;
}

/** Most recent first; a mission nobody called yet comes after the ones that were, newest first. */
export function byLastActivity<
  T extends { readonly last_activity_at: string | null; readonly created_at: string },
>(a: T, b: T): number {
  if (a.last_activity_at !== null && b.last_activity_at !== null) {
    return b.last_activity_at.localeCompare(a.last_activity_at);
  }
  if (a.last_activity_at !== null) return -1;
  if (b.last_activity_at !== null) return 1;
  return b.created_at.localeCompare(a.created_at);
}
