/**
 * The words a person reads for the risk model — the six facts and their
 * values, the gate, a mission's Can / Asks first / Cannot, the trust levels.
 * Pure and browser-safe. The gateway's interface (`lib/vocabulary.ts`
 * re-exports them) and the public site (`apps/website`) print these, never a
 * copy (ADR interface-redesign-vocabulary-and-design-system, amendment
 * 2026-11-05; website spec §1.1, no second source of truth).
 *
 * Protocol names never come from here: risk ids, `auto` / `approval`, the
 * vector's values stay as the catalog spells them.
 */

import type { Gate, RiskVector } from '@vaubaan/shared';

import type { Tier, TrustLevel } from './trust-level.ts';

/** The label of the severity chip. The word itself is `severityLevel`'s. */
export const SEVERITY_LABEL = 'Risk';

/** The six facts behind a severity, as the "why?" disclosure labels them. Keyed by `RiskVector` axis. */
export const WHY_LABELS = {
  reversibility: 'Undo',
  blast: 'Blast radius',
  data: 'Data',
  cost: 'Cost',
  visibility: 'Visible to',
  persistence: 'Lasts',
} as const satisfies Record<keyof RiskVector, string>;

export type WhyAxis = keyof typeof WHY_LABELS;

/** The order the six cells are drawn in. */
export const WHY_ORDER: readonly WhyAxis[] = [
  'reversibility',
  'blast',
  'data',
  'cost',
  'visibility',
  'persistence',
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
  persistence: { stateless: 'nothing', session: 'the session', posture: 'until reverted' },
} as const satisfies { readonly [K in WhyAxis]: Readonly<Record<RiskVector[K], string>> };

/** The undo fact in words: what the rows of a plugin's map are named by. */
export type UndoWord = (typeof WHY_VALUES.reversibility)[RiskVector['reversibility']];

/**
 * The rows of a plugin's map, worst first: the undo fact, its easy value split
 * in two by what `tierOf` reads beyond it (secrets or personal data, a whole
 * account or many items, an unbounded cost). Keyed by what the trust levels
 * read, so a row and the gates it gets never disagree; the word "tier" is
 * never printed (website spec §2.3).
 */
export const UNDO_ROW_WORDS: Readonly<Record<Tier, string>> = {
  4: WHY_VALUES.reversibility.irreversible,
  3: WHY_VALUES.reversibility.costly,
  2: `${WHY_VALUES.reversibility.reversible}, but sensitive`,
  1: WHY_VALUES.reversibility.reversible,
};

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
