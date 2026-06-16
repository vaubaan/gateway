import { describe, expect, test } from 'vitest';
import type { RiskCatalog } from '@vaubaan/shared';

import { checkAcceptableInEnv, prepareCatalog } from '../../src/risk-policy.ts';

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
    expect(checkAcceptableInEnv(bulkEntry, null)).toContain('account-scope');
  });

  test('no restriction → OK', () => {
    const free = catalog.risks[0]!;
    expect(checkAcceptableInEnv(free, 'prod')).toBeNull();
    expect(checkAcceptableInEnv(free, null)).toBeNull();
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
