/**
 * Unit tests for the risk-catalog YAML loader and the qualify/unqualify
 * helpers.
 */
import { afterEach, describe, expect, test } from 'vitest';
import type { RiskCatalog, RiskEntry } from '@vaubaan/shared';

import {
  __resetForTests,
  __setCatalogForTests,
  getCatalog,
  qualifyRiskId,
  unqualifyRiskId,
} from '@/lib/risk-catalog/loader';
import { indexCatalog } from '@vaubaan/policy-engine';

const minimalCatalog: RiskCatalog = {
  provider: 'supabase',
  risks: [
    {
      id: 'supabase.read-data',
      label: 'Read',
      reason: 'Reads.',
      matches: 'supabase.**.R',
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
      id: 'supabase.uncategorized-write',
      label: 'Fallback',
      reason: 'Catch-all.',
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

afterEach(() => {
  __resetForTests();
});

describe('risk-catalog loader — setCatalogForTests seam', () => {
  test('seam can clear the cache and set it back to undefined', () => {
    __setCatalogForTests('vercel', undefined);
    expect(getCatalog('vercel')).toBeUndefined();
  });

  test('returns the injected catalog when set via the test seam', () => {
    const indexed = indexCatalog(minimalCatalog);
    __setCatalogForTests('supabase', indexed);
    const result = getCatalog('supabase');
    expect(result).toBeDefined();
    expect(result?.provider).toBe('supabase');
    expect(result?.entries.length).toBe(2);
  });

  test('can override the same provider twice', () => {
    __setCatalogForTests('supabase', indexCatalog(minimalCatalog));
    expect(getCatalog('supabase')?.entries.length).toBe(2);
    const trimmed: RiskCatalog = {
      provider: 'supabase',
      risks: [minimalCatalog.risks[0]!],
    };
    __setCatalogForTests('supabase', indexCatalog(trimmed));
    expect(getCatalog('supabase')?.entries.length).toBe(1);
  });

  test('can clear a provider by passing undefined', () => {
    __setCatalogForTests('supabase', indexCatalog(minimalCatalog));
    expect(getCatalog('supabase')).toBeDefined();
    __setCatalogForTests('supabase', undefined);
    expect(getCatalog('supabase')).toBeUndefined();
  });
});

describe('qualifyRiskId', () => {
  const envScopedEntry: RiskEntry = {
    id: 'supabase.bulk-row-write',
    label: 'bulk',
    reason: 'bulk',
    matches: 'supabase.project[**].schema[**].table[**].row[*].W',
    vector: {
      reversibility: 'costly',
      blast: 'bulk',
      data: 'data',
      cost: 'moderate',
      visibility: 'internal',
      persistence: 'session',
    },
    acceptable_in_envs: ['staging', 'preview'],
  };
  const accountScopedEntry: RiskEntry = {
    id: 'github.mint-install-token',
    label: 'mint',
    reason: 'mint',
    matches: 'github.repo[**].install-token[**].W',
    vector: {
      reversibility: 'reversible',
      blast: 'account',
      data: 'secret',
      cost: 'free',
      visibility: 'internal',
      persistence: 'posture',
    },
  };

  test('returns base id when env is null', () => {
    expect(qualifyRiskId('supabase.bulk-row-write', null, envScopedEntry)).toBe(
      'supabase.bulk-row-write',
    );
  });

  test('returns base id when env is empty string', () => {
    expect(qualifyRiskId('supabase.bulk-row-write', '', envScopedEntry)).toBe(
      'supabase.bulk-row-write',
    );
  });

  test('injects [env] before the first dot for an env-scoped risk', () => {
    expect(qualifyRiskId('supabase.bulk-row-write', 'staging', envScopedEntry)).toBe(
      'supabase[staging].bulk-row-write',
    );
    expect(qualifyRiskId('supabase.bulk-row-write', 'prod', envScopedEntry)).toBe(
      'supabase[prod].bulk-row-write',
    );
  });

  test('leaves already-qualified ids alone (defensive)', () => {
    expect(qualifyRiskId('supabase[staging].bulk-row-write', 'prod', envScopedEntry)).toBe(
      'supabase[staging].bulk-row-write',
    );
  });

  test('does not qualify account-scoped risks (no acceptable_in_envs)', () => {
    expect(qualifyRiskId('github.mint-install-token', 'prod', accountScopedEntry)).toBe(
      'github.mint-install-token',
    );
  });

  test('returns base id when entry is undefined (defensive)', () => {
    expect(qualifyRiskId('supabase.bulk-row-write', 'staging', undefined)).toBe(
      'supabase.bulk-row-write',
    );
  });
});

describe('unqualifyRiskId', () => {
  test('strips [env] qualifier when present', () => {
    expect(unqualifyRiskId('supabase[staging].bulk-row-write')).toBe('supabase.bulk-row-write');
    expect(unqualifyRiskId('vercel[prod].env-var-write')).toBe('vercel.env-var-write');
  });

  test('leaves non-qualified ids alone', () => {
    expect(unqualifyRiskId('github.mint-install-token')).toBe('github.mint-install-token');
    expect(unqualifyRiskId('supabase.read-data')).toBe('supabase.read-data');
  });
});
