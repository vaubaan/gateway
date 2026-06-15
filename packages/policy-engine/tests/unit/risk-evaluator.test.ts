import { describe, expect, test } from 'vitest';
import type { RiskCatalog, Slice } from '@vaubaan/shared';

import {
  findRiskEntry,
  indexCatalog,
  risksTouchedBy,
  risksTouchedByAll,
} from '../../src/risk-evaluator.ts';
import { parseSlice } from '../../src/slice-dsl.ts';

const githubCatalog: RiskCatalog = {
  provider: 'github',
  risks: [
    {
      id: 'github.read-code',
      label: 'Lire le code',
      reason: 'Lectures du code, peuvent contenir des secrets via commits.',
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
      label: 'Branches feature',
      reason: 'Réversible.',
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
      label: 'Merge protected',
      reason: 'Trigger CI prod.',
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
      id: 'github.branch-protection-write',
      label: 'Branch protection',
      reason: 'Posture shift.',
      matches: 'github.repo[**].branch-protection[**].W',
      vector: {
        reversibility: 'costly',
        blast: 'env',
        data: 'metadata',
        cost: 'free',
        visibility: 'team',
        persistence: 'posture',
      },
      default_gate: 'deny',
    },
    {
      id: 'github.uncategorized-write',
      label: 'Fallback W',
      reason: 'Catch-all.',
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

const indexed = indexCatalog(githubCatalog);
const s = (str: string): Slice => parseSlice(str);

describe('risksTouchedBy', () => {
  test('a code read touches read-code only', () => {
    const touched = risksTouchedBy(s('github.repo[foo/bar].file[src/x.ts].R'), indexed);
    expect(touched).toEqual(['github.read-code']);
  });

  test('a feature branch write touches feature + fallback', () => {
    const touched = risksTouchedBy(
      s('github.repo[foo/bar].branch[feature/auth].file[src/x.ts].W'),
      indexed,
    );
    expect(touched).toEqual(['github.feature-branch-write', 'github.uncategorized-write']);
  });

  test('a merge-to-main touches merge-protected + fallback', () => {
    const touched = risksTouchedBy(s('github.repo[foo/bar].branch[main].W'), indexed);
    expect(touched).toEqual(['github.merge-protected', 'github.uncategorized-write']);
  });

  test('branch protection write touches protection + fallback', () => {
    const touched = risksTouchedBy(s('github.repo[foo/bar].branch-protection[main].W'), indexed);
    expect(touched).toEqual(['github.branch-protection-write', 'github.uncategorized-write']);
  });

  test('different provider returns empty', () => {
    const touched = risksTouchedBy(s('vercel.project[gateway].deployment[*].W'), indexed);
    expect(touched).toEqual([]);
  });
});

describe('risksTouchedByAll', () => {
  test('union deduplicated, stable order', () => {
    const slices = [
      s('github.repo[foo].file[a].R'),
      s('github.repo[foo].file[b].R'),
      s('github.repo[foo].branch[main].W'),
    ];
    const touched = risksTouchedByAll(slices, indexed);
    expect(touched).toEqual([
      'github.read-code',
      'github.merge-protected',
      'github.uncategorized-write',
    ]);
  });
});

describe('indexCatalog', () => {
  test('rejects pattern for wrong provider', () => {
    const bogus: RiskCatalog = {
      provider: 'github',
      risks: [
        {
          id: 'github.bogus',
          label: '',
          reason: '',
          matches: 'vercel.project[*].W',
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
      ],
    };
    expect(() => indexCatalog(bogus)).toThrow(/provider/);
  });

  test('rejects unparseable pattern', () => {
    const bogus: RiskCatalog = {
      provider: 'github',
      risks: [
        {
          id: 'github.bogus',
          label: '',
          reason: '',
          matches: 'not.a.valid.slice',
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
      ],
    };
    expect(() => indexCatalog(bogus)).toThrow(/Invalid 'matches'/);
  });

  test('rejects duplicate risk ids', () => {
    // W8 — two entries with the same id silently lost `findRiskEntry`
    // lookups to "first match wins". Reject up front.
    const dup: RiskCatalog = {
      provider: 'github',
      risks: [
        {
          id: 'github.dup',
          label: 'a',
          reason: '',
          matches: 'github.repo[*].W',
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
          id: 'github.dup',
          label: 'b',
          reason: '',
          matches: 'github.repo[*].R',
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
      ],
    };
    expect(() => indexCatalog(dup)).toThrow(/Duplicate risk id/);
  });
});

describe('findRiskEntry', () => {
  test('finds by id', () => {
    expect(findRiskEntry(indexed, 'github.read-code')?.label).toBe('Lire le code');
  });
  test('returns undefined for unknown', () => {
    expect(findRiskEntry(indexed, 'github.no-such')).toBeUndefined();
  });
});
