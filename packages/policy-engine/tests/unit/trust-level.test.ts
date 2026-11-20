/**
 * Rows (the decision tree), trust levels and the expansion of a macro-action
 * (ADR macro-actions-and-trust-levels-prefill-the-policy, amendment 2026-11-13).
 */
import { describe, expect, test } from 'vitest';

import { RISK_VECTOR_AXES, type RiskCatalog, type RiskVector } from '@vaubaan/shared';

import {
  REASON_WORDS,
  ROW_GATE_SENTENCES,
  ROW_WORDS,
  TRUST_LEVEL_LABELS,
} from '../../src/risk-words.ts';
import {
  ANYTHING_ELSE_BASE_BUDGET,
  ANYTHING_ELSE_MACRO_ACTION,
  budgetAtTrustLevel,
  macroActionsOf,
  REASON_AXIS,
  REASONS,
  reasonOf,
  type Reason,
  type Row,
  ROW_OF_REASON,
  rowOf,
  TRUST_LEVEL_GATES,
  expandAtTrustLevel,
  TRUST_LEVELS,
  type TrustLevelCandidate,
} from '../../src/trust-level.ts';

const mild: RiskVector = {
  reversibility: 'reversible',
  blast: 'single',
  data: 'data',
  cost: 'free',
  visibility: 'internal',
};

/** Every vector of the model: 3 × 4 × 4 × 3 × 3 = 432. */
function everyVector(): RiskVector[] {
  let out: Partial<RiskVector>[] = [{}];
  for (const axis of Object.keys(RISK_VECTOR_AXES) as (keyof RiskVector)[]) {
    out = out.flatMap((partial) =>
      RISK_VECTOR_AXES[axis].map((value) => ({ ...partial, [axis]: value })),
    );
  }
  return out as RiskVector[];
}

describe('reasonOf and rowOf — the decision tree, read in order', () => {
  test.each<[string, Partial<RiskVector>, Reason | null, Row]>([
    ['irreversible', { reversibility: 'irreversible' }, 'irreversible', 4],
    ['costly to undo', { reversibility: 'costly' }, 'costly-to-undo', 3],
    ['unbounded cost', { cost: 'unbounded' }, 'unbounded-cost', 3],
    ['secret data', { data: 'secret' }, 'secret-data', 2],
    ['personal data', { data: 'pii' }, 'personal-data', 2],
    ['whole account', { blast: 'account' }, 'whole-account', 2],
    ['in bulk', { blast: 'bulk' }, 'in-bulk', 2],
    ['moderate cost', { cost: 'moderate' }, 'moderate-cost', 2],
    ['public', { visibility: 'public' }, 'public', 2],
    ['harmless', {}, null, 1],
    ['harmless, one environment, seen by the team', { blast: 'env', visibility: 'team' }, null, 1],
    ['harmless, metadata', { data: 'metadata' }, null, 1],
  ])('%s', (_label, facts, reason, row) => {
    const vector = { ...mild, ...facts };
    expect(reasonOf(vector)).toBe(reason);
    expect(rowOf(vector)).toBe(row);
  });

  test('the first branch decides: one reason, never a sum', () => {
    const worst: RiskVector = {
      reversibility: 'irreversible',
      blast: 'bulk',
      data: 'pii',
      cost: 'unbounded',
      visibility: 'public',
    };
    expect(reasonOf(worst)).toBe('irreversible');
    expect(reasonOf({ ...worst, reversibility: 'costly' })).toBe('costly-to-undo');
    expect(reasonOf({ ...worst, reversibility: 'reversible' })).toBe('unbounded-cost');
    expect(reasonOf({ ...worst, reversibility: 'reversible', cost: 'moderate' })).toBe(
      'personal-data',
    );
    expect(reasonOf({ ...mild, data: 'secret', blast: 'account', visibility: 'public' })).toBe(
      'secret-data',
    );
    expect(reasonOf({ ...mild, blast: 'bulk', cost: 'moderate', visibility: 'public' })).toBe(
      'in-bulk',
    );
  });

  test('over every vector: no reason exactly in row 1, and the row is the reason’s', () => {
    const vectors = everyVector();
    expect(vectors).toHaveLength(432);
    const seen = new Set<Reason>();
    for (const vector of vectors) {
      const reason = reasonOf(vector);
      if (reason === null) {
        expect(rowOf(vector), JSON.stringify(vector)).toBe(1);
      } else {
        seen.add(reason);
        expect(rowOf(vector), JSON.stringify(vector)).toBe(ROW_OF_REASON[reason]);
      }
    }
    expect([...seen].sort()).toEqual([...REASONS].sort());
  });

  test('each reason names the fact it read: changing that fact alone changes the reason', () => {
    for (const vector of everyVector()) {
      const reason = reasonOf(vector);
      if (reason === null) continue;
      const axis = REASON_AXIS[reason];
      const mildest = RISK_VECTOR_AXES[axis][0] as RiskVector[typeof axis];
      expect(reasonOf({ ...vector, [axis]: mildest }), JSON.stringify(vector)).not.toBe(reason);
    }
  });

  test('a harder fact never lowers the row', () => {
    for (const vector of everyVector()) {
      for (const axis of Object.keys(RISK_VECTOR_AXES) as (keyof RiskVector)[]) {
        const values: readonly string[] = RISK_VECTOR_AXES[axis];
        const next = values[values.indexOf(vector[axis]) + 1];
        if (next === undefined) continue;
        const harder = { ...vector, [axis]: next };
        expect(rowOf(harder), `${JSON.stringify(vector)} → ${axis}`).toBeGreaterThanOrEqual(
          rowOf(vector),
        );
      }
    }
  });
});

describe('the words of the rows', () => {
  test('four row names and a word for every reason', () => {
    expect(ROW_WORDS).toEqual({
      4: 'Cannot be repaired',
      3: 'Repairable, at a price',
      2: 'Worth a look',
      1: 'Harmless',
    });
    expect(Object.keys(REASON_WORDS).sort()).toEqual([...REASONS].sort());
    for (const word of [...Object.values(ROW_WORDS), ...Object.values(REASON_WORDS)]) {
      expect(word.toLowerCase()).not.toMatch(/tier|severity|low|medium|high|critical/);
    }
  });

  test('the gate sentence of a row says what TRUST_LEVEL_GATES writes', () => {
    const say = { auto: 'runs freely', approval: 'ask me' } as const;
    for (const row of [1, 2, 3, 4] as const) {
      const sentence = ROW_GATE_SENTENCES[row].toLowerCase();
      for (const level of TRUST_LEVELS) {
        const gate = TRUST_LEVEL_GATES[level][row];
        const label = TRUST_LEVEL_LABELS[level].toLowerCase();
        if (row === 1) {
          expect(gate).toBe('auto');
          continue;
        }
        const clause = sentence.split('.').find((part) => part.includes(label)) ?? '';
        expect(clause, `${row} ${level}`).toContain(gate === null ? 'no' : say[gate]);
      }
    }
  });
});

describe('the trust levels', () => {
  test('a higher trust level never asks more nor accepts less', () => {
    const rank = (g: string | null) => (g === null ? 0 : g === 'approval' ? 1 : 2);
    for (const row of [1, 2, 3, 4] as const) {
      const ranks = TRUST_LEVELS.map((c) => rank(TRUST_LEVEL_GATES[c][row]));
      expect([...ranks].sort()).toEqual(ranks);
    }
  });

  test('row 1 always runs freely ; row 4 never does', () => {
    for (const trustLevel of TRUST_LEVELS) {
      expect(TRUST_LEVEL_GATES[trustLevel][1]).toBe('auto');
      expect(TRUST_LEVEL_GATES[trustLevel][4]).not.toBe('auto');
    }
  });
});

describe('budgetAtTrustLevel', () => {
  const base = { quota: 100, rate_limit: { max: 20, window_seconds: 60 } };

  test('×1, ×3, ×10', () => {
    expect(budgetAtTrustLevel(base, 'careful', null)).toEqual(base);
    expect(budgetAtTrustLevel(base, 'trusting', null)).toEqual({
      quota: 300,
      rate_limit: { max: 60, window_seconds: 60 },
    });
    expect(budgetAtTrustLevel(base, 'autonomous', null).quota).toBe(1000);
  });

  test('the rate stays under the catalog ceiling, per its own window', () => {
    expect(budgetAtTrustLevel(base, 'autonomous', 50).rate_limit).toEqual({
      max: 50,
      window_seconds: 60,
    });
    const hourly = { quota: 10, rate_limit: { max: 2, window_seconds: 3600 } };
    expect(budgetAtTrustLevel(hourly, 'autonomous', 1).rate_limit).toEqual({
      max: 20,
      window_seconds: 3600,
    });
    expect(
      budgetAtTrustLevel({ ...base, rate_limit: { max: 1, window_seconds: 10 } }, 'careful', 1),
    ).toEqual({ quota: 100, rate_limit: { max: 1, window_seconds: 10 } });
  });
});

describe('expandAtTrustLevel', () => {
  const candidate = (risk_id: string, vector: RiskVector): TrustLevelCandidate => ({
    risk_id,
    vector,
    base: { quota: 10, rate_limit: { max: 5, window_seconds: 60 } },
    rate_ceiling_per_minute: null,
  });
  const candidates = [
    candidate('acme.read', mild),
    candidate('acme.export', { ...mild, blast: 'bulk' }),
    candidate('acme.rewrite', { ...mild, reversibility: 'costly' }),
    candidate('acme.destroy', { ...mild, reversibility: 'irreversible' }),
  ];

  test('Careful leaves the irreversible out and asks for the rest but row 1', () => {
    const { lines, left_out } = expandAtTrustLevel(candidates, 'careful');
    expect(lines.map((l) => [l.risk_id, l.gate, l.row])).toEqual([
      ['acme.read', 'auto', 1],
      ['acme.export', 'approval', 2],
      ['acme.rewrite', 'approval', 3],
    ]);
    expect(left_out).toEqual([{ risk_id: 'acme.destroy', row: 4 }]);
  });

  test('Autonomous accepts everything, asking only before the irreversible', () => {
    const { lines, left_out } = expandAtTrustLevel(candidates, 'autonomous');
    expect(left_out).toEqual([]);
    expect(lines.map((l) => l.gate)).toEqual(['auto', 'auto', 'auto', 'approval']);
    expect(lines[0]).toMatchObject({ quota: 100, rate_limit: { max: 50, window_seconds: 60 } });
  });
});

describe('macroActionsOf — the catalog\'s macro-actions, then "Anything else"', () => {
  const catalog = {
    service: 'acme',
    risks: [
      { id: 'acme.read', label: 'Read', reason: 'r', matches: 'acme.x.R', vector: mild },
      {
        id: 'acme.uncategorized-write',
        label: 'Uncategorized write',
        reason: 'r',
        matches: 'acme.**.W',
        fallback: true,
        vector: mild,
      },
    ],
    macro_actions: [
      {
        id: 'read',
        label: 'Read',
        description: 'd',
        entries: [{ risk_id: 'acme.read', quota: 10, rate_limit: { max: 1, window_seconds: 60 } }],
      },
    ],
  } as unknown as RiskCatalog;

  test('appends the fallback at the base budget of "Anything else"', () => {
    const actions = macroActionsOf(catalog);
    expect(actions.map((a) => a.id)).toEqual(['read', ANYTHING_ELSE_MACRO_ACTION]);
    expect(actions[1]?.entries).toEqual([
      { risk_id: 'acme.uncategorized-write', ...ANYTHING_ELSE_BASE_BUDGET },
    ]);
  });

  test('adds nothing to a catalog without a fallback', () => {
    const risks = catalog.risks.filter((r) => r.fallback !== true);
    expect(macroActionsOf({ ...catalog, risks }).map((a) => a.id)).toEqual(['read']);
  });
});
