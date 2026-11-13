import { describe, expect, test } from 'vitest';
import type { RiskCatalog, Slice } from '@vaubaan/shared';

import {
  fallbackEntriesOf,
  findRiskEntry,
  hasFallbackRisk,
  indexCatalog,
  fallbackRiskPrefix,
  hasCatchAllWritePattern,
  isFallbackEntry,
  risksTouchedBy,
  risksTouchedByAll,
} from '../../src/risk-evaluator.ts';
import { parseSlice } from '../../src/slice-dsl.ts';

const githubCatalog: RiskCatalog = {
  provider: 'github',
  risks: [
    {
      id: 'github.read-code',
      label: 'Read code',
      reason: 'Code reads ; commits may contain secrets.',
      matches: 'github.repo[**].file[**].R',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
      },
    },
    {
      id: 'github.feature-branch-write',
      label: 'Feature branches',
      reason: 'Reversible.',
      matches: 'github.repo[**].branch[feature/*,fix/*].file[**].W',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
      },
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
      },
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
      },
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
      },
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

  // The next three cases used to assert that the fallback co-fires with the
  // dedicated entry. Inverted on purpose : ADR
  // fallback-risk-only-when-uncategorized — the fallback counts only when
  // no other entry matched the slice.
  test('a feature branch write touches feature only (no fallback co-fire)', () => {
    const touched = risksTouchedBy(
      s('github.repo[foo/bar].branch[feature/auth].file[src/x.ts].W'),
      indexed,
    );
    expect(touched).toEqual(['github.feature-branch-write']);
  });

  test('a merge-to-main touches merge-protected only', () => {
    const touched = risksTouchedBy(s('github.repo[foo/bar].branch[main].W'), indexed);
    expect(touched).toEqual(['github.merge-protected']);
  });

  test('branch protection write touches protection only', () => {
    const touched = risksTouchedBy(s('github.repo[foo/bar].branch-protection[main].W'), indexed);
    expect(touched).toEqual(['github.branch-protection-write']);
  });

  test('a write no dedicated entry covers touches the fallback alone', () => {
    const touched = risksTouchedBy(s('github.repo[foo/bar].webhook[hook-1].W'), indexed);
    expect(touched).toEqual(['github.uncategorized-write']);
  });

  test('a slice nothing covers — not even the fallback — yields an empty result', () => {
    // Reads are not caught by `github.**.W` ; the runtime refuses an empty set.
    const touched = risksTouchedBy(s('github.repo[foo/bar].webhook[hook-1].R'), indexed);
    expect(touched).toEqual([]);
  });

  test('overlapping dedicated entries still co-fire with each other', () => {
    // Two non-fallback entries matching the same slice both count : only the
    // fallback is subject to the "nothing else matched" rule.
    const overlapping = indexCatalog({
      provider: 'ssh',
      risks: [
        entry('ssh.exec-read', 'ssh.host[**].command.R'),
        entry('ssh.exec-read-secret-files', 'ssh.host[**].command.R'),
        entry('ssh.exec-write', 'ssh.host[**].command.W'),
        { ...entry('ssh.uncategorized-write', 'ssh.**.W'), fallback: true },
      ],
    });
    expect(risksTouchedBy(s('ssh.host[vps].command.R'), overlapping)).toEqual([
      'ssh.exec-read',
      'ssh.exec-read-secret-files',
    ]);
    expect(risksTouchedBy(s('ssh.host[vps].command.W'), overlapping)).toEqual(['ssh.exec-write']);
  });

  test('a flagged fallback whose pattern is not a bare catch-all follows the same rule', () => {
    // GitHub's fallback is `github.repo[**].W`, not `github.**.W` : the
    // explicit flag — or the `uncategorized-` id — identifies it.
    const flagged = indexCatalog({
      provider: 'github',
      risks: [
        entry('github.create-pr', 'github.repo[**].pr[**].W'),
        { ...entry('github.catch-all', 'github.repo[**].W'), fallback: true },
      ],
    });
    expect(risksTouchedBy(s('github.repo[foo].pr[12].W'), flagged)).toEqual(['github.create-pr']);
    expect(risksTouchedBy(s('github.repo[foo].release[v1].W'), flagged)).toEqual([
      'github.catch-all',
    ]);
  });

  test('different provider returns empty', () => {
    const touched = risksTouchedBy(s('vercel.project[gateway].deployment[*].W'), indexed);
    expect(touched).toEqual([]);
  });
});

describe('risksTouchedByAll', () => {
  test('union deduplicated, stable order, fallback rule applied per slice', () => {
    const slices = [
      s('github.repo[foo].file[a].R'),
      s('github.repo[foo].file[b].R'),
      s('github.repo[foo].branch[main].W'),
      s('github.repo[foo].webhook[h].W'),
    ];
    const touched = risksTouchedByAll(slices, indexed);
    expect(touched).toEqual([
      'github.read-code',
      'github.merge-protected',
      'github.uncategorized-write',
    ]);
  });
});

describe('fallback detection', () => {
  test('explicit flag wins over the pattern and the id', () => {
    expect(isFallbackEntry({ ...entry('x.anything', 'x.a[**].W'), fallback: true }, 'x')).toBe(
      true,
    );
    expect(
      isFallbackEntry({ ...entry('x.uncategorized-write', 'x.**.W'), fallback: false }, 'x'),
    ).toBe(false);
  });

  test('without the flag : catch-all write pattern (bare or bracketed) or uncategorized- id', () => {
    expect(isFallbackEntry(entry('x.catch', 'x.**.W'), 'x')).toBe(true);
    expect(isFallbackEntry(entry('x.catch', 'x.[**].W'), 'x')).toBe(true);
    expect(isFallbackEntry(entry('x.uncategorized-write', 'x.repo[**].W'), 'x')).toBe(true);
    expect(isFallbackEntry(entry('x.read-all', 'x.**.R'), 'x')).toBe(false);
    expect(isFallbackEntry(entry('x.repo-write', 'x.repo[**].W'), 'x')).toBe(false);
    expect(isFallbackEntry(entry('x.broken', 'not a slice'), 'x')).toBe(false);
  });

  test('the id convention is `<provider>.uncategorized-`, dash included', () => {
    expect(fallbackRiskPrefix('x')).toBe('x.uncategorized-');
    expect(isFallbackEntry(entry('x.uncategorizedfoo', 'x.repo[**].W'), 'x')).toBe(false);
    expect(isFallbackEntry(entry('x.uncategorized', 'x.repo[**].W'), 'x')).toBe(false);
    expect(isFallbackEntry(entry('x.uncategorized-write', 'x.repo[**].W'), 'x')).toBe(true);
  });

  test('hasCatchAllWritePattern : one catch-all write among the patterns', () => {
    expect(hasCatchAllWritePattern(entry('x.a', 'x.**.W'))).toBe(true);
    expect(hasCatchAllWritePattern(entry('x.a', 'x.[**].W'))).toBe(true);
    expect(
      hasCatchAllWritePattern({ ...entry('x.a', 'x.**.W'), matches: ['x.r[**].W', 'x.**.W'] }),
    ).toBe(true);
    expect(hasCatchAllWritePattern(entry('x.a', 'x.repo[**].W'))).toBe(false);
    expect(hasCatchAllWritePattern(entry('x.a', 'x.**.R'))).toBe(false);
    expect(hasCatchAllWritePattern(entry('x.a', 'not a slice'))).toBe(false);
  });

  test('fallbackEntriesOf / hasFallbackRisk / indexCatalog agree', () => {
    expect(fallbackEntriesOf(githubCatalog).map((r) => r.id)).toEqual([
      'github.uncategorized-write',
    ]);
    expect(hasFallbackRisk(githubCatalog)).toBe(true);
    expect(indexed.entries.map((e) => e.fallback)).toEqual([false, false, false, false, true]);
    expect(hasFallbackRisk({ provider: 'github', risks: githubCatalog.risks.slice(0, 2) })).toBe(
      false,
    );
  });
});

function entry(id: string, matches: string): RiskCatalog['risks'][number] {
  return {
    id,
    label: id,
    reason: 'r',
    matches,
    vector: {
      reversibility: 'reversible',
      blast: 'single',
      data: 'data',
      cost: 'free',
      visibility: 'internal',
    },
  };
}

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
          },
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
          },
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
          },
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
          },
        },
      ],
    };
    expect(() => indexCatalog(dup)).toThrow(/Duplicate risk id/);
  });
});

describe('findRiskEntry', () => {
  test('finds by id', () => {
    expect(findRiskEntry(indexed, 'github.read-code')?.label).toBe('Read code');
  });
  test('returns undefined for unknown', () => {
    expect(findRiskEntry(indexed, 'github.no-such')).toBeUndefined();
  });
});
