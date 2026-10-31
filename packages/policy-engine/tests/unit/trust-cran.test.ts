/**
 * Paliers, crans and the expansion of a macro-action
 * (ADR macro-actions-and-trust-levels-prefill-the-policy).
 */
import { describe, expect, test } from 'vitest';

import type { RiskVector } from '@vaubaan/shared';

import {
  budgetAtCran,
  CRAN_GATES,
  expandAtCran,
  palierOf,
  TRUST_CRANS,
  type CranCandidate,
} from '../../src/trust-cran.ts';

const mild: RiskVector = {
  reversibility: 'reversible',
  blast: 'single',
  data: 'data',
  cost: 'free',
  visibility: 'internal',
  persistence: 'stateless',
};

describe('palierOf — consequence and sensitivity', () => {
  test('reversibility first', () => {
    expect(palierOf({ ...mild, reversibility: 'irreversible' })).toBe(4);
    expect(palierOf({ ...mild, reversibility: 'costly', data: 'pii' })).toBe(3);
  });

  test('reversible but sensitive, wide or unbounded is palier 2', () => {
    expect(palierOf({ ...mild, data: 'pii' })).toBe(2);
    expect(palierOf({ ...mild, data: 'secret' })).toBe(2);
    expect(palierOf({ ...mild, blast: 'bulk' })).toBe(2);
    expect(palierOf({ ...mild, blast: 'account' })).toBe(2);
    expect(palierOf({ ...mild, cost: 'unbounded' })).toBe(2);
  });

  test('the rest is palier 1, visibility and persistence aside', () => {
    expect(palierOf(mild)).toBe(1);
    expect(palierOf({ ...mild, blast: 'env', visibility: 'public', persistence: 'posture' })).toBe(
      1,
    );
  });
});

describe('the crans', () => {
  test('a higher cran never asks more nor accepts less', () => {
    const rank = (g: string | null) => (g === null ? 0 : g === 'approval' ? 1 : 2);
    for (const palier of [1, 2, 3, 4] as const) {
      const ranks = TRUST_CRANS.map((c) => rank(CRAN_GATES[c][palier]));
      expect([...ranks].sort()).toEqual(ranks);
    }
  });

  test('palier 1 always runs freely ; palier 4 never does', () => {
    for (const cran of TRUST_CRANS) {
      expect(CRAN_GATES[cran][1]).toBe('auto');
      expect(CRAN_GATES[cran][4]).not.toBe('auto');
    }
  });
});

describe('budgetAtCran', () => {
  const base = { quota: 100, rate_limit: { max: 20, window_seconds: 60 } };

  test('×1, ×3, ×10', () => {
    expect(budgetAtCran(base, 'prudent', null)).toEqual(base);
    expect(budgetAtCran(base, 'confiant', null)).toEqual({
      quota: 300,
      rate_limit: { max: 60, window_seconds: 60 },
    });
    expect(budgetAtCran(base, 'autonome', null).quota).toBe(1000);
  });

  test('the rate stays under the catalog ceiling, per its own window', () => {
    expect(budgetAtCran(base, 'autonome', 50).rate_limit).toEqual({ max: 50, window_seconds: 60 });
    const hourly = { quota: 10, rate_limit: { max: 2, window_seconds: 3600 } };
    expect(budgetAtCran(hourly, 'autonome', 1).rate_limit).toEqual({
      max: 20,
      window_seconds: 3600,
    });
    expect(
      budgetAtCran({ ...base, rate_limit: { max: 1, window_seconds: 10 } }, 'prudent', 1),
    ).toEqual({ quota: 100, rate_limit: { max: 1, window_seconds: 10 } });
  });
});

describe('expandAtCran', () => {
  const candidate = (risk_id: string, vector: RiskVector): CranCandidate => ({
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

  test('Prudent leaves the irreversible out and asks for the rest but palier 1', () => {
    const { lines, left_out } = expandAtCran(candidates, 'prudent');
    expect(lines.map((l) => [l.risk_id, l.gate, l.palier])).toEqual([
      ['acme.read', 'auto', 1],
      ['acme.export', 'approval', 2],
      ['acme.rewrite', 'approval', 3],
    ]);
    expect(left_out).toEqual([{ risk_id: 'acme.destroy', palier: 4 }]);
  });

  test('Autonome accepts everything, asking only before the irreversible', () => {
    const { lines, left_out } = expandAtCran(candidates, 'autonome');
    expect(left_out).toEqual([]);
    expect(lines.map((l) => l.gate)).toEqual(['auto', 'auto', 'auto', 'approval']);
    expect(lines[0]).toMatchObject({ quota: 100, rate_limit: { max: 50, window_seconds: 60 } });
  });

  test('a risk handing the agent a token that can write asks first at every cran', () => {
    const minted = { ...candidate('acme.mint-token', mild), hands_write_token: true };
    expect(expandAtCran([minted], 'autonome').lines.map((l) => [l.gate, l.palier])).toEqual([
      ['approval', 1],
    ]);
  });
});
