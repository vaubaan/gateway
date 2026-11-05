/**
 * Tiers, trust levels and the expansion of a macro-action
 * (ADR macro-actions-and-trust-levels-prefill-the-policy).
 */
import { describe, expect, test } from 'vitest';

import type { RiskCatalog, RiskVector } from '@vaubaan/shared';

import { SEVERITY_RANKS } from '../../src/severity.ts';
import {
  ANYTHING_ELSE_BASE_BUDGET,
  ANYTHING_ELSE_MACRO_ACTION,
  budgetAtTrustLevel,
  macroActionsOf,
  tierFactsOf,
  TRUST_LEVEL_GATES,
  expandAtTrustLevel,
  tierOf,
  TRUST_LEVELS,
  type TrustLevelCandidate,
} from '../../src/trust-level.ts';

const mild: RiskVector = {
  reversibility: 'reversible',
  blast: 'single',
  data: 'data',
  cost: 'free',
  visibility: 'internal',
  persistence: 'stateless',
};

describe('tierOf — consequence and sensitivity', () => {
  test('reversibility first', () => {
    expect(tierOf({ ...mild, reversibility: 'irreversible' })).toBe(4);
    expect(tierOf({ ...mild, reversibility: 'costly', data: 'pii' })).toBe(3);
  });

  test('reversible but sensitive, wide or unbounded is tier 2', () => {
    expect(tierOf({ ...mild, data: 'pii' })).toBe(2);
    expect(tierOf({ ...mild, data: 'secret' })).toBe(2);
    expect(tierOf({ ...mild, blast: 'bulk' })).toBe(2);
    expect(tierOf({ ...mild, blast: 'account' })).toBe(2);
    expect(tierOf({ ...mild, cost: 'unbounded' })).toBe(2);
  });

  test('the rest is tier 1, visibility and persistence aside', () => {
    expect(tierOf(mild)).toBe(1);
    expect(tierOf({ ...mild, blast: 'env', visibility: 'public', persistence: 'posture' })).toBe(1);
  });
});

describe('the trust levels', () => {
  test('a higher trust level never asks more nor accepts less', () => {
    const rank = (g: string | null) => (g === null ? 0 : g === 'approval' ? 1 : 2);
    for (const tier of [1, 2, 3, 4] as const) {
      const ranks = TRUST_LEVELS.map((c) => rank(TRUST_LEVEL_GATES[c][tier]));
      expect([...ranks].sort()).toEqual(ranks);
    }
  });

  test('tier 1 always runs freely ; tier 4 never does', () => {
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

  test('Careful leaves the irreversible out and asks for the rest but tier 1', () => {
    const { lines, left_out } = expandAtTrustLevel(candidates, 'careful');
    expect(lines.map((l) => [l.risk_id, l.gate, l.tier])).toEqual([
      ['acme.read', 'auto', 1],
      ['acme.export', 'approval', 2],
      ['acme.rewrite', 'approval', 3],
    ]);
    expect(left_out).toEqual([{ risk_id: 'acme.destroy', tier: 4 }]);
  });

  test('Autonomous accepts everything, asking only before the irreversible', () => {
    const { lines, left_out } = expandAtTrustLevel(candidates, 'autonomous');
    expect(left_out).toEqual([]);
    expect(lines.map((l) => l.gate)).toEqual(['auto', 'auto', 'auto', 'approval']);
    expect(lines[0]).toMatchObject({ quota: 100, rate_limit: { max: 50, window_seconds: 60 } });
  });
});

describe('tierFactsOf — the facts that move the gate', () => {
  test('none for tier 1, reversibility alone for tiers 3 and 4', () => {
    expect(tierFactsOf(mild)).toEqual([]);
    expect(tierFactsOf({ ...mild, reversibility: 'costly', data: 'pii' })).toEqual([
      'reversibility',
    ]);
    expect(tierFactsOf({ ...mild, reversibility: 'irreversible' })).toEqual(['reversibility']);
  });

  test('for tier 2, each sensitive fact, in vector order', () => {
    expect(tierFactsOf({ ...mild, blast: 'account', data: 'secret', cost: 'unbounded' })).toEqual([
      'blast',
      'data',
      'cost',
    ]);
  });

  test('agrees with tierOf on every vector: no fact exactly when tier 1', () => {
    const axes = Object.keys(SEVERITY_RANKS) as (keyof RiskVector)[];
    const vectors: RiskVector[] = [mild];
    for (const axis of axes) {
      for (const value of SEVERITY_RANKS[axis]) vectors.push({ ...mild, [axis]: value });
    }
    for (const vector of vectors) {
      expect(tierFactsOf(vector).length === 0, JSON.stringify(vector)).toBe(tierOf(vector) === 1);
    }
  });
});

describe('macroActionsOf — the catalog\'s macro-actions, then "Anything else"', () => {
  const catalog = {
    provider: 'acme',
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
