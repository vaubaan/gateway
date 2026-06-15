import { describe, expect, test } from 'vitest';
import type { RiskCatalog } from '@vaubaan/shared';

import { indexCatalog } from '../../src/risk-evaluator.ts';
import { evaluateCall, evaluateCallSimple } from '../../src/risk-runtime.ts';
import { parseSlice } from '../../src/slice-dsl.ts';

const catalog: RiskCatalog = {
  provider: 'github',
  risks: [
    {
      id: 'github.read-code',
      label: 'read',
      reason: 'r',
      matches: 'github.repo[**].file[**].R',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
      default_gate: 'allow',
    },
    {
      id: 'github.feature-branch-write',
      label: 'feat',
      reason: 'r',
      matches: 'github.repo[**].branch[feature/*,fix/*].file[**].W',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'session',
      },
      default_gate: 'allow',
    },
    {
      id: 'github.merge-protected',
      label: 'merge',
      reason: 'r',
      matches: 'github.repo[**].branch[main,master,prod].W',
      vector: {
        reversibility: 'costly',
        blast: 'env',
        data: 'data',
        cost: 'moderate',
        visibility: 'team',
        persistence: 'session',
      },
      default_gate: 'confirm',
    },
    {
      id: 'github.uncategorized-write',
      label: 'fallback',
      reason: 'r',
      matches: 'github.**.W',
      vector: {
        reversibility: 'costly',
        blast: 'env',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'session',
      },
      default_gate: 'confirm',
    },
  ],
};

const idx = indexCatalog(catalog);

describe('evaluateCall — allow path', () => {
  test('feature branch write with feature-branch-write + fallback accepted', () => {
    const d = evaluateCall({
      executed_slices: [parseSlice('github.repo[foo].branch[feature/x].file[a.ts].W')],
      token_accepted_risks: new Set(['github.feature-branch-write', 'github.uncategorized-write']),
      catalog: idx,
    });
    expect(d.outcome).toBe('allowed');
    if (d.outcome === 'allowed') {
      expect(d.risks_touched).toContain('github.feature-branch-write');
      expect(d.risks_touched).toContain('github.uncategorized-write');
    }
  });

  test('read code accepted', () => {
    const d = evaluateCall({
      executed_slices: [parseSlice('github.repo[foo].file[a.ts].R')],
      token_accepted_risks: new Set(['github.read-code']),
      catalog: idx,
    });
    expect(d.outcome).toBe('allowed');
  });
});

describe('evaluateCall — denied paths', () => {
  test('missing risk → deny with missing_risks', () => {
    const d = evaluateCall({
      executed_slices: [parseSlice('github.repo[foo].branch[main].W')],
      token_accepted_risks: new Set(['github.read-code']),
      catalog: idx,
    });
    expect(d.outcome).toBe('denied');
    if (d.outcome === 'denied') {
      expect(d.missing_risks).toContain('github.merge-protected');
      expect(d.missing_risks).toContain('github.uncategorized-write');
      expect(d.hint).toContain('not granted');
    }
  });

  test('explicit deny wins over acceptance', () => {
    const d = evaluateCall({
      executed_slices: [parseSlice('github.repo[foo].file[a.ts].R')],
      token_accepted_risks: new Set(['github.read-code']),
      token_denied_risks: new Set(['github.read-code']),
      catalog: idx,
    });
    expect(d.outcome).toBe('denied');
    if (d.outcome === 'denied') {
      expect(d.missing_risks).toEqual(['github.read-code']);
      expect(d.hint).toContain('explicitly denies');
    }
  });

  test('no slice → deny (classification gap)', () => {
    const d = evaluateCall({
      executed_slices: [],
      token_accepted_risks: new Set(),
      catalog: idx,
    });
    expect(d.outcome).toBe('denied');
    if (d.outcome === 'denied') {
      expect(d.hint).toContain('no slice');
    }
  });

  test('no risk in catalog matches the slice → deny', () => {
    const otherCatalog: RiskCatalog = { provider: 'github', risks: [] };
    const d = evaluateCall({
      executed_slices: [parseSlice('github.repo[foo].W')],
      token_accepted_risks: new Set(),
      catalog: indexCatalog(otherCatalog),
    });
    expect(d.outcome).toBe('denied');
    if (d.outcome === 'denied') {
      expect(d.hint).toContain('no risk');
      expect(d.hint).toContain('catalog matches');
    }
  });
});

describe('evaluateCall — multi-slice scenarios', () => {
  test('multi-slice : all risks must be covered', () => {
    const d = evaluateCall({
      executed_slices: [
        parseSlice('github.repo[foo].file[a.ts].R'),
        parseSlice('github.repo[foo].branch[main].W'),
      ],
      token_accepted_risks: new Set([
        'github.read-code',
        'github.merge-protected',
        'github.uncategorized-write',
      ]),
      catalog: idx,
    });
    expect(d.outcome).toBe('allowed');
  });

  test('multi-slice : missing one fails the whole call', () => {
    const d = evaluateCall({
      executed_slices: [
        parseSlice('github.repo[foo].file[a.ts].R'),
        parseSlice('github.repo[foo].branch[main].W'),
      ],
      token_accepted_risks: new Set(['github.read-code']), // missing merge-protected + fallback
      catalog: idx,
    });
    expect(d.outcome).toBe('denied');
  });
});

describe('evaluateCallSimple — convenience wrapper', () => {
  test('end-to-end happy path', () => {
    const d = evaluateCallSimple(
      catalog,
      [parseSlice('github.repo[foo].file[a.ts].R')],
      ['github.read-code'],
    );
    expect(d.outcome).toBe('allowed');
  });
});
