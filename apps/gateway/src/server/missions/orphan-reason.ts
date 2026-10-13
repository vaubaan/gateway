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

const KEPT = 'Its keys, its activity and what it counted are kept as they are.';
const REVOKE_AND_REISSUE =
  'Nothing brings it back: stop this mission and create a new one on an account you can use.';

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
  const connection = named ? `the account “${named.display_name}”` : 'one of its accounts';
  const Connection = `${connection.charAt(0).toUpperCase()}${connection.slice(1)}`;
  switch (orphan.cause) {
    case 'connection-revoked':
      return {
        reversible: false,
        title: 'Needs an owner: an account of this mission was disconnected',
        lines: [
          `${Connection} was disconnected by its owner, and a disconnected account never comes back. Every call is refused.`,
          REVOKE_AND_REISSUE,
        ],
      };
    case 'connection-missing':
      return {
        reversible: false,
        title: 'Needs an owner: an account of this mission no longer exists',
        lines: [`Every call is refused.`, REVOKE_AND_REISSUE],
      };
    case 'creator-removed':
      return {
        reversible: true,
        title: 'Needs an owner: your sign-in is no longer active at your company',
        lines: [
          'Every call is refused while it is so. The mission serves calls again as soon as your sign-in is active again.',
          KEPT,
        ],
      };
    case 'authority-lost':
      return {
        reversible: true,
        title: 'Needs an owner: you may no longer allow what this mission allows',
        lines: [
          `On ${connection} you may no longer allow ${orphan.uncovered.length === 1 ? 'this permission' : 'these permissions'}: ${quoted(orphan.uncovered)}. Every call is refused while it is so.`,
          'The mission serves calls again as soon as you may allow them again: the owner gives you access to the account again, or your next sign-in carries the team that held it.',
          KEPT,
        ],
      };
  }
}
