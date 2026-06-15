/**
 * Unit tests for `computeMintPreview` — the DB-bound wrapper around the
 * pure `computePreview` from the mgmt route. We mock the supabase client
 * to return a fixed set of policy overrides and inject a minimal catalog
 * via the loader's test seam.
 *
 * The cardinal cases we want to lock in (cf. coding spec) :
 *   1. all-allow risks → preview.all_allowed = true, no approval needed
 *   2. mix of allow + confirm → all_allowed = false, needs_approval populated
 *   3. at least one deny → all_allowed = false, denied populated
 */
import { afterEach, describe, expect, test } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RiskCatalog, RiskPolicyOverride } from '@vaubaan/shared';
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
      default_gate: 'allow',
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
      default_gate: 'confirm',
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
      default_gate: 'deny',
    },
  ],
};

/** Make a stub Supabase client that returns the given policy overrides for
 *  `from('project_risk_policies').select(...).eq('project_id', X)`. We only
 *  implement the chain `computeMintPreview` actually uses. */
function makeMockSvc(rules: RiskPolicyOverride[]): SupabaseClient {
  return {
    from(table: string) {
      if (table !== 'project_risk_policies') {
        throw new Error(`unexpected table ${table}`);
      }
      return {
        select() {
          return {
            eq() {
              return Promise.resolve({ data: rules, error: null });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
}

afterEach(() => {
  __resetForTests();
});

describe('computeMintPreview', () => {
  test('all-allow scenario — ready to mint, no approval, no deny', async () => {
    __setCatalogForTests('supabase', indexCatalog(supabaseCatalog));
    const svc = makeMockSvc([]);
    const out = await computeMintPreview(svc, 'proj_1', {
      bindings: [{ provider: 'supabase', resource_ref: 'prj_staging', env: 'staging' }],
      accepted_risks: ['supabase.read-data'],
    });
    expect(out.all_allowed).toBe(true);
    expect(out.needs_approval).toEqual([]);
    expect(out.denied).toEqual([]);
    expect(out.risks).toHaveLength(1);
    expect(out.risks[0]!.effective_gate).toBe('allow');
  });

  test('mix of allow + confirm — not all_allowed, needs_approval set', async () => {
    __setCatalogForTests('supabase', indexCatalog(supabaseCatalog));
    const svc = makeMockSvc([]);
    const out = await computeMintPreview(svc, 'proj_1', {
      bindings: [{ provider: 'supabase', resource_ref: 'prj_staging', env: 'staging' }],
      accepted_risks: ['supabase.read-data', 'supabase.bulk-row-write'],
    });
    expect(out.all_allowed).toBe(false);
    // bulk-row-write is env-scoped → qualified id surfaces with [staging]
    expect(out.needs_approval).toEqual(['supabase[staging].bulk-row-write']);
    expect(out.denied).toEqual([]);
  });

  test('contains deny — blocked, denied list populated', async () => {
    __setCatalogForTests('supabase', indexCatalog(supabaseCatalog));
    const svc = makeMockSvc([]);
    const out = await computeMintPreview(svc, 'proj_1', {
      bindings: [{ provider: 'supabase', resource_ref: 'prj_staging', env: 'staging' }],
      accepted_risks: ['supabase.read-data', 'supabase.policy.W'],
    });
    expect(out.all_allowed).toBe(false);
    expect(out.denied).toEqual(['supabase.policy.W']);
  });

  test('honors project policy override (allow → deny)', async () => {
    __setCatalogForTests('supabase', indexCatalog(supabaseCatalog));
    const rules: RiskPolicyOverride[] = [
      {
        id: 'r1',
        project_id: 'proj_1',
        risk_id: 'supabase.read-data',
        env_scope: null,
        gate: 'deny',
        created_at: '2026-01-01',
      },
    ];
    const svc = makeMockSvc(rules);
    const out = await computeMintPreview(svc, 'proj_1', {
      bindings: [{ provider: 'supabase', resource_ref: 'prj_staging', env: 'staging' }],
      accepted_risks: ['supabase.read-data'],
    });
    expect(out.all_allowed).toBe(false);
    expect(out.denied).toEqual(['supabase.read-data']);
  });
});
