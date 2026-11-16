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
  readonly cause: PartLossCause;
  readonly final: boolean;
}

export interface LostExplanation {
  /** False while the account may come back (an access withdrawn). */
  readonly final: boolean;
  /** The one line the folded card shows. */
  readonly summary: string;
  /** What unfolding the card adds. */
  readonly lines: readonly string[];
}

/**
 * What the card of an account that no longer serves a mission says (ADR
 * orphaned-missions-and-ownerless-connections, amendments 2026-10-21 and 2026-11-16):
 * one line folded, the rest unfolded. The mission keeps serving through its other
 * accounts; the lost one stays on it, red, until its creator removes it in "Edit
 * mission". `name` is the account's display name, `null` when it no longer exists;
 * `creator` says whether the reader is the mission's creator.
 */
export function explainLostAccount(
  part: LostAccountInput,
  name: string | null,
  creator: boolean,
): LostExplanation {
  const named = name === null ? 'This account' : `“${name}”`;
  const you = creator ? 'You no longer have' : 'The creator of this mission no longer has';
  const summary = ((): string => {
    switch (part.cause) {
      case 'account-revoked':
        return `${named} was disconnected by its owner; calls through it are refused.`;
      case 'account-missing':
        return `${named} no longer exists; calls through it are refused.`;
      case 'access-withdrawn':
        return `${you} access to ${named}; calls through it are refused until it is given back.`;
    }
  })();
  const withdrawn = creator
    ? 'Its owner withdrew your access, or you left the team that held it.'
    : 'Its owner withdrew the creator’s access, or the creator left the team that held it.';
  const why =
    part.cause === 'access-withdrawn'
      ? `${withdrawn} When the access is given back, it serves this same mission again.`
      : 'It never comes back to this mission.';
  return {
    final: part.final,
    summary,
    lines: [
      why,
      'The mission keeps running on its other accounts, with its keys and limits as they are. Nothing takes its place: to work on another account, add it in Edit mission or create a new mission.',
      creator
        ? 'It stays here until you remove it from the mission in Edit mission.'
        : 'It stays here until the creator removes it from the mission.',
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
