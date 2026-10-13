/**
 * What the creator reads on an orphaned mission (spec §2.3, §7.8 "refuse
 * everything, with the reason"): why the authority is missing, and whether
 * the mission can serve again.
 *
 * `orphaned` is derived from the creator's current authority on every read,
 * so the answer is always about now: the lines disappear with the state.
 *
 * Pure and browser-safe.
 */
import type { RiskId } from '@vaubaan/shared';

import type { OrphanCause } from '../authority/mission-grounds';

export interface OrphanExplanationInput {
  readonly cause: OrphanCause;
  readonly connection_id: string | null;
  readonly uncovered: readonly RiskId[];
}

export interface OrphanExplanation {
  /** False when nothing can bring the authority back (a revoked connection). */
  readonly reversible: boolean;
  readonly title: string;
  readonly lines: readonly string[];
}

const KEPT = 'Its token, its session and its counters are kept as they are.';
const REVOKE_AND_REISSUE =
  'Nothing brings it back: revoke this mission and issue a new one on a connection you hold.';

/** Longest list of risk ids quoted in full. */
const RISKS_SHOWN = 6;

function quoted(ids: readonly RiskId[]): string {
  const shown = ids.slice(0, RISKS_SHOWN).join(', ');
  const more = ids.length - RISKS_SHOWN;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

export function explainOrphan(
  orphan: OrphanExplanationInput,
  connections: readonly { readonly id: string; readonly display_name: string }[],
): OrphanExplanation {
  const named = connections.find((c) => c.id === orphan.connection_id);
  const connection = named ? `connection “${named.display_name}”` : 'one of its connections';
  switch (orphan.cause) {
    case 'connection-revoked':
      return {
        reversible: false,
        title: 'Orphaned: a connection of this mission was revoked',
        lines: [
          `The ${connection} was revoked by its owner, and a revoked connection never comes back. Every call is refused.`,
          REVOKE_AND_REISSUE,
        ],
      };
    case 'connection-missing':
      return {
        reversible: false,
        title: 'Orphaned: a connection of this mission no longer exists',
        lines: [`Every call is refused.`, REVOKE_AND_REISSUE],
      };
    case 'creator-removed':
      return {
        reversible: true,
        title: 'Orphaned: your account is no longer active at the identity provider',
        lines: [
          'Every call is refused while it is so. The mission serves calls again as soon as your account is active again.',
          KEPT,
        ],
      };
    case 'authority-lost':
      return {
        reversible: true,
        title: 'Orphaned: you no longer hold the authority this mission was issued under',
        lines: [
          `On the ${connection} you no longer cover ${orphan.uncovered.length === 1 ? 'this accepted risk' : 'these accepted risks'}: ${quoted(orphan.uncovered)}. Every call is refused while it is so.`,
          'The mission serves calls again as soon as that authority is back: the owner shares the connection with you again, or your next sign-in carries the group that held it.',
          KEPT,
        ],
      };
  }
}
