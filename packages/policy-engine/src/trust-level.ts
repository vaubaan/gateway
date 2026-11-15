/**
 * Trust levels — how a macro-action ticked at a trust level becomes explicit policy
 * lines. Pure and browser-safe : the creation form, the preview and the
 * management door call the same functions.
 *
 * ADR  : docs/decisions/macro-actions-and-trust-levels-prefill-the-policy.md.
 * Spec : docs/spec/gateway-risk-model.md §4.6 (macro-actions), §9 (preview).
 *
 * The vector pre-fills, it never decides : the lines this module writes are
 * shown, editable, and stored as the explicit list ; the runtime never reads
 * a row or a trust level.
 */

import type {
  Budget,
  Gate,
  MacroAction,
  RateLimit,
  RiskCatalog,
  RiskId,
  RiskVector,
} from '@vaubaan/shared';
import { SECONDS_PER_MINUTE } from '@vaubaan/shared/time';

import { isFallbackEntry } from './risk-evaluator.ts';

/**
 * The four rows of the risk model, from the mildest: 4 is the hardest to
 * repair. The word "tier" is never printed; the interface names a row with
 * `ROW_WORDS` (spec gateway-risk-model §4.6).
 */
export type Row = 1 | 2 | 3 | 4;

/** The one branch of the decision tree that put a permission in its row (rows 2 to 4). */
export const REASONS = [
  'irreversible',
  'costly-to-undo',
  'unbounded-cost',
  'secret-data',
  'personal-data',
  'whole-account',
  'in-bulk',
  'moderate-cost',
  'public',
] as const;
export type Reason = (typeof REASONS)[number];

/**
 * The decision tree over the five facts, read in order; the first branch a
 * vector answers decides (spec gateway-risk-model §4.6). `null` for row 1,
 * where no branch answered.
 */
export function reasonOf(vector: RiskVector): Reason | null {
  if (vector.reversibility === 'irreversible') return 'irreversible';
  if (vector.reversibility === 'costly') return 'costly-to-undo';
  if (vector.cost === 'unbounded') return 'unbounded-cost';
  if (vector.data === 'secret') return 'secret-data';
  if (vector.data === 'pii') return 'personal-data';
  if (vector.blast === 'account') return 'whole-account';
  if (vector.blast === 'bulk') return 'in-bulk';
  if (vector.cost === 'moderate') return 'moderate-cost';
  if (vector.visibility === 'public') return 'public';
  return null;
}

/** The row each branch of the tree leads to. */
export const ROW_OF_REASON: Readonly<Record<Reason, Row>> = {
  irreversible: 4,
  'costly-to-undo': 3,
  'unbounded-cost': 3,
  'secret-data': 2,
  'personal-data': 2,
  'whole-account': 2,
  'in-bulk': 2,
  'moderate-cost': 2,
  public: 2,
};

/** The fact each branch reads: what a page tints as "the fact that moved the gate". */
export const REASON_AXIS: Readonly<Record<Reason, keyof RiskVector>> = {
  irreversible: 'reversibility',
  'costly-to-undo': 'reversibility',
  'unbounded-cost': 'cost',
  'secret-data': 'data',
  'personal-data': 'data',
  'whole-account': 'blast',
  'in-bulk': 'blast',
  'moderate-cost': 'cost',
  public: 'visibility',
};

/**
 * The row of a vector: irreversible → 4 "Cannot be repaired"; costly to undo
 * or of unbounded cost → 3 "Repairable, at a price"; secret or personal
 * data, a whole account or many items, a moderate cost, or public → 2
 * "Repairable, worth a look"; otherwise 1 "Harmless".
 */
export function rowOf(vector: RiskVector): Row {
  const reason = reasonOf(vector);
  return reason === null ? 1 : ROW_OF_REASON[reason];
}

export const TRUST_LEVELS = ['careful', 'trusting', 'autonomous'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

/** The lowest trust level : where a new macro-action starts. */
export const DEFAULT_TRUST_LEVEL: TrustLevel = 'careful';

export function isTrustLevel(raw: unknown): raw is TrustLevel {
  return typeof raw === 'string' && (TRUST_LEVELS as readonly string[]).includes(raw);
}

/** Per trust level and row : the gate of the line, or `null` when the risk is not accepted. */
export const TRUST_LEVEL_GATES: Readonly<Record<TrustLevel, Readonly<Record<Row, Gate | null>>>> = {
  careful: { 1: 'auto', 2: 'approval', 3: 'approval', 4: null },
  trusting: { 1: 'auto', 2: 'auto', 3: 'approval', 4: 'approval' },
  autonomous: { 1: 'auto', 2: 'auto', 3: 'auto', 4: 'approval' },
};

/** What the trust level multiplies the base budget by (quota and rate). */
export const TRUST_LEVEL_BUDGET_FACTOR: Readonly<Record<TrustLevel, number>> = {
  careful: 1,
  trusting: 3,
  autonomous: 10,
};

/** The id the gateway gives the macro-action holding the fallback ; no catalog may declare it. */
export const ANYTHING_ELSE_MACRO_ACTION = 'anything-else';

/** The base budget of the fallback in "Anything else" : the catalogs' default base budget. */
export const ANYTHING_ELSE_BASE_BUDGET: Budget = {
  quota: 50,
  rate_limit: { max: 10, window_seconds: SECONDS_PER_MINUTE },
};

/**
 * The catalog's macro-actions, then "Anything else" holding the catalog's
 * fallback entries when it has any, each at `ANYTHING_ELSE_BASE_BUDGET`: the
 * macro-actions a mission ticks on an account, as the creation form, the
 * management door and the public site list them.
 */
export function macroActionsOf(catalog: RiskCatalog): MacroAction[] {
  const fallbacks = catalog.risks.filter((entry) => isFallbackEntry(entry, catalog.service));
  const own = [...(catalog.macro_actions ?? [])];
  if (fallbacks.length === 0) return own;
  return [
    ...own,
    {
      id: ANYTHING_ELSE_MACRO_ACTION,
      label: 'Anything else',
      description: 'Any write no other permission of this service names, which nobody reviewed.',
      entries: fallbacks.map((entry) => ({ risk_id: entry.id, ...ANYTHING_ELSE_BASE_BUDGET })),
    },
  ];
}

/**
 * The base budget at a trust level : quota and rate multiplied, the rate then held
 * under the catalog's per-minute ceiling when the entry declares one (never
 * below one call per window).
 */
export function budgetAtTrustLevel(
  base: Budget,
  trustLevel: TrustLevel,
  rateCeilingPerMinute: number | null,
): Budget {
  const factor = TRUST_LEVEL_BUDGET_FACTOR[trustLevel];
  const window = base.rate_limit.window_seconds;
  let max = base.rate_limit.max * factor;
  if (rateCeilingPerMinute !== null) {
    const cap = Math.floor((rateCeilingPerMinute * window) / SECONDS_PER_MINUTE);
    max = Math.max(1, Math.min(max, cap));
  }
  const rate_limit: RateLimit = { max, window_seconds: window };
  return { quota: base.quota * factor, rate_limit };
}

/** One risk a macro-action offers, as the caller resolved it for the mission's resources. */
export interface TrustLevelCandidate {
  /** Unqualified, or qualified with one environment the mission reaches. */
  readonly risk_id: RiskId;
  /** The vector in that environment (`resolveVector`). */
  readonly vector: RiskVector;
  readonly base: Budget;
  readonly rate_ceiling_per_minute: number | null;
}

/** A policy line a trust level wrote, with the row that chose its gate. */
export interface TrustLevelLine extends Budget {
  readonly risk_id: RiskId;
  readonly gate: Gate;
  readonly row: Row;
}

/** What a macro-action at a trust level yields : the lines, and the risks it leaves out. */
export interface TrustLevelExpansion {
  readonly lines: readonly TrustLevelLine[];
  readonly left_out: readonly { readonly risk_id: RiskId; readonly row: Row }[];
}

/** The explicit lines of one macro-action at one trust level. */
export function expandAtTrustLevel(
  candidates: readonly TrustLevelCandidate[],
  trustLevel: TrustLevel,
): TrustLevelExpansion {
  const lines: TrustLevelLine[] = [];
  const leftOut: { risk_id: RiskId; row: Row }[] = [];
  for (const candidate of candidates) {
    const row = rowOf(candidate.vector);
    const gate = TRUST_LEVEL_GATES[trustLevel][row];
    if (gate === null) {
      leftOut.push({ risk_id: candidate.risk_id, row });
      continue;
    }
    lines.push({
      risk_id: candidate.risk_id,
      gate,
      row,
      ...budgetAtTrustLevel(candidate.base, trustLevel, candidate.rate_ceiling_per_minute),
    });
  }
  return { lines, left_out: leftOut };
}
