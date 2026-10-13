/**
 * Unit tests for the RiskId qualify / unqualify helpers.
 *
 * Mirrors and supersedes the older copy in
 * `apps/gateway/tests/unit/lib/risk-catalog/loader.test.ts` (the loader now
 * re-exports from `@vaubaan/policy-engine`).
 *
 * The "round-trip" tests are the load-bearing ones : if `qualifyRiskId`
 * and `unqualifyRiskId` ever drift apart (e.g. the bracket regex tightens
 * on one side and not the other), set-membership checks at the runtime
 * silently break.
 */
import { describe, expect, test } from 'vitest';
import type { Resource, RiskEntry, RiskId } from '@vaubaan/shared';
import { parseSlice } from '../../src/slice-dsl.ts';

import {
  isEnvScopedEntry,
  noEnvResolver,
  qualifyRiskId,
  resourceEnvResolver,
  unqualifyRiskId,
} from '../../src/qualify.ts';

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

describe('isEnvScopedEntry', () => {
  test('true when acceptable_in_envs is non-empty', () => {
    expect(isEnvScopedEntry(envScopedEntry)).toBe(true);
  });
  test('false when acceptable_in_envs is absent or empty', () => {
    expect(isEnvScopedEntry(accountScopedEntry)).toBe(false);
    expect(isEnvScopedEntry({ ...envScopedEntry, acceptable_in_envs: [] })).toBe(false);
  });
  test('false when entry is undefined', () => {
    expect(isEnvScopedEntry(undefined)).toBe(false);
  });
});

describe('qualifyRiskId', () => {
  test('returns base id when env is null or empty', () => {
    expect(qualifyRiskId('supabase.bulk-row-write', null, envScopedEntry)).toBe(
      'supabase.bulk-row-write',
    );
    expect(qualifyRiskId('supabase.bulk-row-write', '', envScopedEntry)).toBe(
      'supabase.bulk-row-write',
    );
    expect(qualifyRiskId('supabase.bulk-row-write', undefined, envScopedEntry)).toBe(
      'supabase.bulk-row-write',
    );
  });

  test('injects [env] before the first dot for env-scoped risks', () => {
    expect(qualifyRiskId('supabase.bulk-row-write', 'staging', envScopedEntry)).toBe(
      'supabase[staging].bulk-row-write',
    );
    expect(qualifyRiskId('supabase.bulk-row-write', 'prod', envScopedEntry)).toBe(
      'supabase[prod].bulk-row-write',
    );
  });

  test('does not qualify account-scoped risks', () => {
    expect(qualifyRiskId('github.mint-install-token', 'prod', accountScopedEntry)).toBe(
      'github.mint-install-token',
    );
  });

  test('leaves already-qualified ids alone (defensive double-qualify)', () => {
    expect(qualifyRiskId('supabase[staging].bulk-row-write', 'prod', envScopedEntry)).toBe(
      'supabase[staging].bulk-row-write',
    );
  });

  test('returns base id when entry is undefined', () => {
    expect(qualifyRiskId('supabase.bulk-row-write', 'staging', undefined)).toBe(
      'supabase.bulk-row-write',
    );
  });
});

describe('unqualifyRiskId', () => {
  test('strips [env] when present', () => {
    expect(unqualifyRiskId('supabase[staging].bulk-row-write')).toBe('supabase.bulk-row-write');
    expect(unqualifyRiskId('vercel[prod].env-var-write')).toBe('vercel.env-var-write');
  });
  test('leaves non-qualified ids unchanged', () => {
    expect(unqualifyRiskId('github.mint-install-token')).toBe('github.mint-install-token');
    expect(unqualifyRiskId('supabase.read-data')).toBe('supabase.read-data');
  });
});

describe('qualify / unqualify round-trip', () => {
  const ids: ReadonlyArray<[RiskId, string]> = [
    ['supabase.bulk-row-write', 'staging'],
    ['supabase.bulk-row-write', 'prod'],
    ['vercel.env-var-write', 'production'],
    ['vercel.env-var-write', 'preview'],
  ];

  for (const [base, env] of ids) {
    test(`unqualify(qualify(${base}, ${env})) === ${base}`, () => {
      const qualified = qualifyRiskId(base, env, envScopedEntry);
      expect(unqualifyRiskId(qualified)).toBe(base);
    });
  }

  test('account-scoped id stays untouched through both ops', () => {
    const base: RiskId = 'github.mint-install-token';
    const qualified = qualifyRiskId(base, 'prod', accountScopedEntry);
    expect(qualified).toBe(base);
    expect(unqualifyRiskId(qualified)).toBe(base);
  });
});

describe('resourceEnvResolver', () => {
  const staging: Resource = {
    provider: 'supabase',
    ref: 'stg-ref',
    env: 'staging',
    displayName: 'Staging',
  };
  const prod: Resource = { provider: 'supabase', ref: 'prd-ref', env: 'prod', displayName: 'Prod' };
  const unlabelled: Resource = { provider: 'github', ref: 'acme/app', displayName: 'acme/app' };

  test('matches the first ident segment equal to a resource ref', () => {
    const r = resourceEnvResolver([staging, prod]);
    expect(
      r.resolveEnv(parseSlice('supabase.project[prd-ref].schema[public].table[t].row[*].W')),
    ).toBe('prod');
    expect(
      r.resolveEnv(parseSlice('supabase.project[stg-ref].schema[public].table[t].row[*].W')),
    ).toBe('staging');
  });

  test('null when the slice provider has no resource', () => {
    expect(
      resourceEnvResolver([staging]).resolveEnv(parseSlice('vercel.project[x].deployment[*].W')),
    ).toBeNull();
  });

  test('falls back to the single resource env when the path carries no ref', () => {
    expect(resourceEnvResolver([prod]).resolveEnv(parseSlice('supabase.account.R'))).toBe('prod');
  });

  test('ambiguous (several resources, no ref in path) → null', () => {
    expect(
      resourceEnvResolver([staging, prod]).resolveEnv(parseSlice('supabase.account.R')),
    ).toBeNull();
  });

  test('unlabelled resource resolves to null even when matched', () => {
    expect(
      resourceEnvResolver([unlabelled]).resolveEnv(
        parseSlice('github.repo[acme/app].branch[main].W'),
      ),
    ).toBeNull();
  });

  test('noEnvResolver never qualifies', () => {
    expect(noEnvResolver.resolveEnv(parseSlice('supabase.project[prd-ref].R'))).toBeNull();
  });
});
