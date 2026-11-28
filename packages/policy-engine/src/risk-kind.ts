/**
 * What a catalog entry does, in three words a person sorts by: it only reads, it writes, or it
 * writes something that cannot be undone. One definition for the gateway's catalog views and the
 * service pages (`@vaubaan/plugin-page`). A grouping aid for long catalogs: nothing is decided
 * from it.
 */
import type { RiskEntry, RiskVector } from '@vaubaan/shared';

export const RISK_KINDS = ['read', 'write', 'destructive'] as const;
export type RiskKind = (typeof RISK_KINDS)[number];

/**
 * An entry is a read when every one of its patterns ends with the read action; a write that the
 * vector calls irreversible is destructive.
 */
export function riskKindOf(entry: Pick<RiskEntry, 'matches'>, vector: RiskVector): RiskKind {
  const patterns = typeof entry.matches === 'string' ? [entry.matches] : entry.matches;
  if (patterns.every((pattern) => pattern.endsWith('.R'))) return 'read';
  return vector.reversibility === 'irreversible' ? 'destructive' : 'write';
}
