/**
 * Unit tests for `computeMintPreview` — the catalog-bound wrapper around
 * the pure `computePreview`. Post drop-confirm : no DB read, no policy
 * overrides — only the catalog acceptable_in_envs guard and the parent
 * accepted_risks subset check.
 */
import { afterEach, describe, expect, test } from 'vitest';
import type { RiskCatalog } from '@vaubaan/shared';
import { indexCatalog } from '@vaubaan/policy-engine';

import { __resetForTests, __setCatalogForTests } from '@/lib/risk-catalog/loader';
import { computeMintPreview } from '@/lib/mint/preview';

const supabaseCatalog: RiskCatalog = {
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
      id: 'supabase.bulk-row-write',
      label: 'Bulk',
      reason: 'No rollback.',
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
    },
    {
      id: 'supabase.policy.W',
      label: 'RLS',
      reason: 'Posture-shift.',
      matches: 'supabase.project[**].policy[**].W',
      vector: {
        reversibility: 'costly',
        blast: 'env',
        data: 'metadata',
        cost: 'free',
        visibility: 'team',
        persistence: 'posture',
      },
    },
  ],
};

afterEach(() => {
  __resetForTests();
});

describe('computeMintPreview', () => {
  test('inherited + acceptable → ok = true', () => {
    __setCatalogForTests('supabase', indexCatalog(supabaseCatalog));
    const out = computeMintPreview(
      {
        bindings: [{ provider: 'supabase', resource_ref: 'prj_staging', env: 'staging' }],
        accepted_risks: ['supabase.read-data'],
      },
      ['supabase.read-data'],
    );
    expect(out.ok).toBe(true);
    expect(out.not_acceptable).toEqual([]);
    expect(out.not_inherited).toEqual([]);
    expect(out.risks).toHaveLength(1);
    expect(out.risks[0]!.acceptable).toBe(true);
    expect(out.risks[0]!.inherited).toBe(true);
  });

  test('parent missing the risk → not_inherited', () => {
    __setCatalogForTests('supabase', indexCatalog(supabaseCatalog));
    const out = computeMintPreview(
      {
        bindings: [{ provider: 'supabase', resource_ref: 'prj_staging', env: 'staging' }],
        accepted_risks: ['supabase.bulk-row-write'],
      },
      [], // parent has no risks
    );
    expect(out.ok).toBe(false);
    // qualified id surfaces with [staging] (acceptable_in_envs declares env-scoping)
    expect(out.not_inherited).toEqual(['supabase[staging].bulk-row-write']);
    expect(out.not_acceptable).toEqual([]);
  });

  test('binding env not in acceptable_in_envs → not_acceptable', () => {
    __setCatalogForTests('supabase', indexCatalog(supabaseCatalog));
    const out = computeMintPreview(
      {
        bindings: [{ provider: 'supabase', resource_ref: 'prj_prod', env: 'prod' }],
        accepted_risks: ['supabase.bulk-row-write'],
      },
      ['supabase[prod].bulk-row-write'], // even if parent had it
    );
    expect(out.ok).toBe(false);
    expect(out.not_acceptable.length).toBeGreaterThan(0);
  });

  test('null parent → inherited optimistically true', () => {
    __setCatalogForTests('supabase', indexCatalog(supabaseCatalog));
    const out = computeMintPreview(
      {
        bindings: [{ provider: 'supabase', resource_ref: 'prj_staging', env: 'staging' }],
        accepted_risks: ['supabase.read-data'],
      },
      null,
    );
    expect(out.ok).toBe(true);
    expect(out.risks[0]!.inherited).toBe(true);
  });
});
