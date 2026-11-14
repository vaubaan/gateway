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

import type { OrphanCause, PartLossCause } from '../authority/mission-grounds';

export interface OrphanExplanationInput {
  readonly cause: OrphanCause;
  readonly account_id: string | null;
  readonly uncovered: readonly RiskId[];
}

export interface OrphanExplanation {
  /** False when nothing can bring the authority back (a revoked account). */
  readonly reversible: boolean;
  readonly title: string;
  readonly lines: readonly string[];
}

const KEPT = 'Its keys, its activity and what it counted are kept as they are.';

export interface LostAccountInput {
  readonly account_id: string;
  readonly cause: PartLossCause;
  readonly final: boolean;
}

export interface LostExplanation {
  /** False when one of the accounts may come back (an access withdrawn). */
  readonly final: boolean;
  readonly title: string;
  readonly lines: readonly string[];
}

/**
 * What the creator and the members read on a mission that lost some of its accounts
 * and still serves through the others (ADR orphaned-missions-and-ownerless-connections,
 * amendment 2026-10-21). Nothing is added in place of a lost account: the account that
 * replaced it is reached by a new mission. `null` when every account serves.
 */
export function explainLost(
  lost: readonly LostAccountInput[],
  accounts: readonly { readonly id: string; readonly display_name: string }[],
): LostExplanation | null {
  if (lost.length === 0) return null;
  const nameOf = (id: string): string => {
    const named = accounts.find((c) => c.id === id);
    return named ? `“${named.display_name}”` : 'an account that no longer exists';
  };
  const lines = lost.map((part) => {
    switch (part.cause) {
      case 'account-revoked':
        return `${nameOf(part.account_id)} was disconnected by its owner. It never comes back to this mission: calls through it are refused.`;
      case 'account-missing':
        return `An account of this mission no longer exists. Calls through it are refused.`;
      case 'access-withdrawn':
        return `${nameOf(part.account_id)}: you no longer have access to it (its owner withdrew it, or you left the team that held it). Calls through it are refused until the access is given back, with this same mission.`;
    }
  });
  const final = lost.every((part) => part.final);
  return {
    final,
    title:
      lost.length === 1
        ? 'An account no longer serves this mission'
        : `${lost.length} accounts no longer serve this mission`,
    lines: [
      ...lines,
      'The mission keeps running on its other accounts, with its keys and limits as they are. Nothing is added in place of a lost account: to work on the account that replaced it, create a new mission.',
    ],
  };
}
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
  accounts: readonly { readonly id: string; readonly display_name: string }[],
): OrphanExplanation {
  const named = accounts.find((c) => c.id === orphan.account_id);
  const account = named ? `the account “${named.display_name}”` : 'one of its accounts';
  const Account = `${account.charAt(0).toUpperCase()}${account.slice(1)}`;
  switch (orphan.cause) {
    case 'account-revoked':
      return {
        reversible: false,
        title: 'Needs an owner: an account of this mission was disconnected',
        lines: [
          `${Account} was disconnected by its owner, and a disconnected account never comes back. Every call is refused.`,
          REVOKE_AND_REISSUE,
        ],
      };
    case 'account-missing':
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
          `On ${account} you may no longer allow ${orphan.uncovered.length === 1 ? 'this permission' : 'these permissions'}: ${quoted(orphan.uncovered)}. Every call is refused while it is so.`,
          'The mission serves calls again as soon as you may allow them again: the owner gives you access to the account again, or your next sign-in carries the team that held it.',
          KEPT,
        ],
      };
  }
}
