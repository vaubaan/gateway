/**
 * Tiers, trust levels and the expansion of a macro-action
 * (ADR macro-actions-and-trust-levels-prefill-the-policy).
 */
import { describe, expect, test } from 'vitest';

import type { RiskVector } from '@vaubaan/shared';

import {
  budgetAtTrustLevel,
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
