/**
 * The words a person reads for the risk model — the four rows and the reason
 * of a permission, the five facts and their values, the gate, a mission's Can / Asks first / Cannot, the trust levels.
 * Pure and browser-safe. The gateway's interface (`lib/vocabulary`
 * re-exports them) and the public site (`apps/website`) print these, never a
 * copy (ADR interface-redesign-vocabulary-and-design-system, amendment
 * 2026-11-05; website spec §1.1, no second source of truth).
 *
 * Protocol names never come from here: risk ids, `auto` / `approval`, the
 * vector's values stay as the catalog spells them.
 */

import type { Gate, RiskVector } from '@vaubaan/shared';

import type { Reason, Row, TrustLevel } from './trust-level.ts';

/** The heading of the column that carries the row of a permission. */
export const ROW_LABEL = 'Risk';

/**
 * The four rows of the risk model, worst first in the interface: the word a
 * permission is printed with (`rowOf`). Keyed by what the trust levels read,
 * so a row and the gates it gets never disagree; the word "tier" is never
 * printed (risk model §4.6).
 */
export const ROW_WORDS: Readonly<Record<Row, string>> = {
  4: 'Cannot be repaired',
  3: 'Repairable, at a price',
  2: 'Worth a look',
  1: 'Harmless',
};

/** The branch of the tree that put a permission in its row (`reasonOf`), in quiet type. */
export const REASON_WORDS: Readonly<Record<Reason, string>> = {
  irreversible: 'irreversible',
  'costly-to-undo': 'costly to undo',
  'unbounded-cost': 'unbounded cost',
  'secret-data': 'secret data',
  'personal-data': 'personal data',
  'whole-account': 'whole account',
  'in-bulk': 'in bulk',
  'moderate-cost': 'moderate cost',
  public: 'public',
};

/** What the trust levels do with each row, in one sentence (risk model §4.6). */
export const ROW_GATE_SENTENCES: Readonly<Record<Row, string>> = {
  4: 'Careful: no. Trusting, Autonomous: ask me.',
  3: 'Careful, Trusting: ask me. Autonomous: runs freely.',
  2: 'Careful: ask me. Trusting, Autonomous: runs freely.',
  1: 'Runs freely at every level.',
};

/** How a permission finds its row, in one sentence. */
export const TREE_LEGEND =
  'A permission sits in the first row its facts answer: irreversible; costly to undo or unbounded cost; secret or personal data, whole account or bulk, moderate cost, public; otherwise harmless.';

/** The five facts behind a row, as the "why?" disclosure labels them. Keyed by `RiskVector` axis. */
export const WHY_LABELS = {
  reversibility: 'Undo',
  blast: 'Blast radius',
  data: 'Data',
  cost: 'Cost',
  visibility: 'Visible to',
} as const satisfies Record<keyof RiskVector, string>;

export type WhyAxis = keyof typeof WHY_LABELS;

/** The order the five cells are drawn in. */
export const WHY_ORDER: readonly WhyAxis[] = [
  'reversibility',
  'blast',
  'data',
  'cost',
  'visibility',
];

/** Each value of the risk model, said in words. */
export const WHY_VALUES = {
  reversibility: { reversible: 'easy', costly: 'costly', irreversible: 'impossible' },
  blast: {
    single: 'one thing',
    env: 'one environment',
    account: 'whole account',
    bulk: 'many at once',
  },
  data: { metadata: 'metadata', data: 'contents', secret: 'secrets', pii: 'personal data' },
  cost: { free: 'free', moderate: 'moderate', unbounded: 'unbounded' },
  visibility: { internal: 'internal', team: 'the team', public: 'public' },
} as const satisfies { readonly [K in WhyAxis]: Readonly<Record<RiskVector[K], string>> };

/** A value said in words; a value the model does not list is printed as it is. */
export function whyValue(axis: WhyAxis, value: string): string {
  const words: Readonly<Record<string, string>> = WHY_VALUES[axis];
  return words[value] ?? value;
}

/** The class of word the interface draws for a gate, `off` when a level leaves the permission out. */
export type GateWord = 'free' | 'ask' | 'off';

/** The protocol's gate as the word class the interface draws. */
export function gateWordOf(gate: Gate): GateWord {
  return gate === 'approval' ? 'ask' : 'free';
}

export const GATE_WORDS: Readonly<Record<GateWord, string>> = {
  free: 'runs freely',
  ask: 'ask me first',
  off: 'not included',
};

/** The same three, as the headings of the summary of a mission. */
export const ALLOW_WORDS = {
  can: 'Can',
  asks: 'Asks you first',
  cannot: 'Cannot',
  limits: 'Limits today',
} as const;

/** A trust level as the interface names it (risk model §4.6). */
export const TRUST_LEVEL_LABELS: Readonly<Record<TrustLevel, string>> = {
  careful: 'Careful',
  trusting: 'Trusting',
  autonomous: 'Autonomous',
};

/** What each trust level does, in one line, wherever its chip shows a tooltip. */
export const TRUST_LEVEL_HINTS: Readonly<Record<TrustLevel, string>> = {
  careful:
    'Mild actions run freely; sensitive or costly ones ask first; irreversible ones are left out.',
  trusting:
    'Up to sensitive actions run freely; costly and irreversible ones ask first. Limits ×3.',
  autonomous: 'Everything but irreversible actions runs freely; those ask first. Limits ×10.',
};
