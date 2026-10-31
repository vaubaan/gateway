/**
 * Trust crans — how a macro-action ticked at a cran becomes explicit policy
 * lines. Pure and browser-safe : the creation form, the preview and the
 * management door call the same functions.
 *
 * ADR  : docs/decisions/macro-actions-and-trust-crans-prefill-the-policy.md.
 * Spec : docs/spec/gateway-risk-model.md §4.7 (macro-actions), §9 (preview).
 *
 * The vector pre-fills, it never decides : the lines this module writes are
 * shown, editable, and stored as the explicit list ; the runtime never reads
 * a palier or a cran.
 */

import type { Budget, Gate, RateLimit, RiskId, RiskVector } from '@vaubaan/shared';

/** The four paliers, from the mildest. */
export type Palier = 1 | 2 | 3 | 4;

/**
 * "Consequence and sensitivity" : irreversible → 4, costly → 3, reversible
 * but touching pii or secrets, reaching a whole account or many items, or of
 * unbounded cost → 2, else 1.
 */
export function palierOf(vector: RiskVector): Palier {
  if (vector.reversibility === 'irreversible') return 4;
  if (vector.reversibility === 'costly') return 3;
  if (
    vector.data === 'pii' ||
    vector.data === 'secret' ||
    vector.blast === 'bulk' ||
    vector.blast === 'account' ||
    vector.cost === 'unbounded'
  ) {
    return 2;
  }
  return 1;
}

export const TRUST_CRANS = ['prudent', 'confiant', 'autonome'] as const;
export type TrustCran = (typeof TRUST_CRANS)[number];

/** The lowest cran : where a new macro-action starts. */
export const DEFAULT_CRAN: TrustCran = 'prudent';

export function isTrustCran(raw: unknown): raw is TrustCran {
  return typeof raw === 'string' && (TRUST_CRANS as readonly string[]).includes(raw);
}

/** Per cran and palier : the gate of the line, or `null` when the risk is not accepted. */
export const CRAN_GATES: Readonly<Record<TrustCran, Readonly<Record<Palier, Gate | null>>>> = {
  prudent: { 1: 'auto', 2: 'approval', 3: 'approval', 4: null },
  confiant: { 1: 'auto', 2: 'auto', 3: 'approval', 4: 'approval' },
  autonome: { 1: 'auto', 2: 'auto', 3: 'auto', 4: 'approval' },
};

/** What the cran multiplies the base budget by (quota and rate). */
export const CRAN_BUDGET_FACTOR: Readonly<Record<TrustCran, number>> = {
  prudent: 1,
  confiant: 3,
  autonome: 10,
};

const SECONDS_PER_MINUTE = 60;

/** The id the gateway gives the macro-action holding the fallback ; no catalog may declare it. */
export const ANYTHING_ELSE_MACRO_ACTION = 'anything-else';

/** The base budget of the fallback in "Anything else" : the catalogs' default base budget. */
export const ANYTHING_ELSE_BASE_BUDGET: Budget = {
  quota: 50,
  rate_limit: { max: 10, window_seconds: SECONDS_PER_MINUTE },
};

/**
 * The base budget at a cran : quota and rate multiplied, the rate then held
 * under the catalog's per-minute ceiling when the entry declares one (never
 * below one call per window).
 */
export function budgetAtCran(
  base: Budget,
  cran: TrustCran,
  rateCeilingPerMinute: number | null,
): Budget {
  const factor = CRAN_BUDGET_FACTOR[cran];
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
export interface CranCandidate {
  /** Unqualified, or qualified with one environment the mission reaches. */
  readonly risk_id: RiskId;
  /** The vector in that environment (`resolveVector`). */
  readonly vector: RiskVector;
  readonly base: Budget;
  readonly rate_ceiling_per_minute: number | null;
}

/** A policy line a cran wrote, with the palier that chose its gate. */
export interface CranLine extends Budget {
  readonly risk_id: RiskId;
  readonly gate: Gate;
  readonly palier: Palier;
}

/** What a macro-action at a cran yields : the lines, and the risks it leaves out. */
export interface CranExpansion {
  readonly lines: readonly CranLine[];
  readonly left_out: readonly { readonly risk_id: RiskId; readonly palier: Palier }[];
}

/** The explicit lines of one macro-action at one cran. */
export function expandAtCran(candidates: readonly CranCandidate[], cran: TrustCran): CranExpansion {
  const lines: CranLine[] = [];
  const leftOut: { risk_id: RiskId; palier: Palier }[] = [];
  for (const candidate of candidates) {
    const palier = palierOf(candidate.vector);
    const gate = CRAN_GATES[cran][palier];
    if (gate === null) {
      leftOut.push({ risk_id: candidate.risk_id, palier });
      continue;
    }
    lines.push({
      risk_id: candidate.risk_id,
      gate,
      palier,
      ...budgetAtCran(candidate.base, cran, candidate.rate_ceiling_per_minute),
    });
  }
  return { lines, left_out: leftOut };
}
