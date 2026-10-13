import { describe, expect, test } from 'vitest';
import type { RiskCatalog } from '@vaubaan/shared';

import { checkAcceptableInEnv, prepareCatalog } from '../../src/risk-policy.ts';
import { hasFallbackRisk } from '../../src/risk-evaluator.ts';

const catalog: RiskCatalog = {
  provider: 'supabase',
  risks: [
    {
      id: 'supabase.read-rows',
      label: 'Read rows',
      reason: 'OK',
      matches: 'supabase.project[**].schema[**].table[**].row[**].R',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      },
    },
    {
      id: 'supabase[staging].bulk-row-write',
      label: 'Bulk staging',
      reason: 'No rollback.',
      matches: 'supabase.project[**].schema[**].table[**].row[*].W',
      vector: {
        reversibility: 'irreversible',
        blast: 'bulk',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'session',
      },
      acceptable_in_envs: ['staging', 'preview'],
    },
    {
      id: 'supabase.uncategorized-write',
      label: 'Fallback',
      reason: 'Catch.',
      matches: 'supabase.**.W',
      vector: {
        reversibility: 'costly',
        blast: 'env',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'session',
      },
    },
  ],
};

describe('checkAcceptableInEnv', () => {
  const bulkEntry = catalog.risks[1]!;

  test('OK on allowed env', () => {
    expect(checkAcceptableInEnv(bulkEntry, 'staging')).toBeNull();
    expect(checkAcceptableInEnv(bulkEntry, 'preview')).toBeNull();
  });

  test('refuses on prod', () => {
    expect(checkAcceptableInEnv(bulkEntry, 'prod')).toContain("not acceptable in env 'prod'");
  });

  test('refuses on account-scope when restricted', () => {
    expect(checkAcceptableInEnv(bulkEntry, null)).toContain('no environment label');
  });

  test('no restriction → OK', () => {
    const free = catalog.risks[0]!;
    expect(checkAcceptableInEnv(free, 'prod')).toBeNull();
    expect(checkAcceptableInEnv(free, null)).toBeNull();
  });

  test('an empty list is "not env-scoped", like isEnvScopedEntry says', () => {
    const empty = { ...catalog.risks[0]!, acceptable_in_envs: [] };
    expect(checkAcceptableInEnv(empty, 'prod')).toBeNull();
    expect(checkAcceptableInEnv(empty, null)).toBeNull();
  });
});

describe('prepareCatalog', () => {
  test('OK with valid catalog', () => {
    expect(() => prepareCatalog(catalog)).not.toThrow();
  });

  test('rejects duplicate ids', () => {
    const dup: RiskCatalog = {
      ...catalog,
      risks: [...catalog.risks, catalog.risks[0]!],
    };
    expect(() => prepareCatalog(dup)).toThrow(/Duplicate/);
  });

  test('rejects bad RiskId format', () => {
    const bad: RiskCatalog = {
      ...catalog,
      risks: [...catalog.risks, { ...catalog.risks[0]!, id: 'NOT_KEBAB.WTF' }],
    };
    expect(() => prepareCatalog(bad)).toThrow(/format/);
  });
});

describe('prepareCatalog — fallback warning is injectable', () => {
  test('calls the provided warn when the fallback is missing, nothing otherwise', () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    const noFallback: RiskCatalog = {
      provider: 'acme',
      risks: [
        {
          id: 'acme.read',
          label: 'r',
          reason: 'r',
          matches: 'acme.thing[**].R',
          vector: {
            reversibility: 'reversible',
            blast: 'single',
            data: 'metadata',
            cost: 'free',
            visibility: 'internal',
            persistence: 'stateless',
          },
        },
      ],
    };
    expect(hasFallbackRisk(noFallback)).toBe(false);
    prepareCatalog(noFallback, { warn });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/uncategorized/);

    const withFallback: RiskCatalog = {
      ...noFallback,
      risks: [
        ...noFallback.risks,
        { ...noFallback.risks[0]!, id: 'acme.uncategorized-write', matches: 'acme.**.W' },
      ],
    };
    expect(hasFallbackRisk(withFallback)).toBe(true);
    prepareCatalog(withFallback, { warn });
    expect(warnings).toHaveLength(1);
  });
});
