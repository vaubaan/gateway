/**
 * Unit tests for the pure-compute risk-preview layer.
 *
 * Now lives at `lib/mint/risk-preview.ts` (extracted from the deleted mgmt
 * route per the unified-tokens ADR).
 */
import { describe, expect, test } from 'vitest';
import type { Provider, RiskCatalog, RiskPolicyOverride } from '@vaubaan/shared';
import { indexCatalog } from '@vaubaan/policy-engine';

import { computePreview, resolveRiskRow, type PreviewBinding } from '@/lib/mint/risk-preview';

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
      reason: 'Posture.',
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
      default_gate: 'confirm',
    },
  ],
};

const supabaseIndexed = indexCatalog(supabaseCatalog);
const catalogs: Partial<Record<Provider, ReturnType<typeof indexCatalog>>> = {
  supabase: supabaseIndexed,
};

const stagingBinding: PreviewBinding = {
  provider: 'supabase',
  resource_ref: 'prj_staging',
  env: 'staging',
};
const prodBinding: PreviewBinding = {
  provider: 'supabase',
  resource_ref: 'prj_prod',
  env: 'prod',
};

describe('resolveRiskRow', () => {
  test('marks an unknown risk as denied with a clear reason', () => {
    const row = resolveRiskRow('supabase.unknown-risk', stagingBinding, supabaseIndexed, []);
    expect(row.effective_gate).toBe('deny');
    expect(row.blocked_reason).toContain("unknown risk 'supabase.unknown-risk'");
  });

  test('marks all risks denied when catalog is undefined', () => {
    const row = resolveRiskRow('supabase.read-data', stagingBinding, undefined, []);
    expect(row.effective_gate).toBe('deny');
    expect(row.blocked_reason).toContain('not loaded');
  });

  test('returns the catalog default_gate when no override exists', () => {
    const row = resolveRiskRow('supabase.read-data', stagingBinding, supabaseIndexed, []);
    expect(row.effective_gate).toBe('allow');
    expect(row.origin).toBe('catalog-default');
    expect(row.label).toBe('Read');
  });

  test('qualifies env-scoped ids and leaves account-scoped ones alone', () => {
    const bulk = resolveRiskRow('supabase.bulk-row-write', stagingBinding, supabaseIndexed, []);
    expect(bulk.id).toBe('supabase[staging].bulk-row-write');
    expect(bulk.effective_gate).toBe('confirm');
    const read = resolveRiskRow('supabase.read-data', stagingBinding, supabaseIndexed, []);
    expect(read.id).toBe('supabase.read-data');
  });

  test('denies env-scoped risk on an env not in acceptable_in_envs', () => {
    const row = resolveRiskRow('supabase.bulk-row-write', prodBinding, supabaseIndexed, []);
    expect(row.effective_gate).toBe('deny');
    expect(row.blocked_reason).toMatch(/not acceptable in env 'prod'/);
  });

  test('honors env-scoped policy override over global override', () => {
    const overrides: RiskPolicyOverride[] = [
      {
        id: 'o1',
        project_id: 'p',
        risk_id: 'supabase.read-data',
        env_scope: null,
        gate: 'confirm',
        created_at: '2026-01-01',
      },
      {
        id: 'o2',
        project_id: 'p',
        risk_id: 'supabase.read-data',
        env_scope: 'staging',
        gate: 'deny',
        created_at: '2026-01-01',
      },
    ];
    const row = resolveRiskRow('supabase.read-data', stagingBinding, supabaseIndexed, overrides);
    expect(row.effective_gate).toBe('deny');
    expect(row.origin).toBe('project-policy-env-scoped');
  });
});

describe('computePreview', () => {
  test('summarises all_allowed / needs_approval / denied lists', () => {
    const result = computePreview({
      bindings: [stagingBinding],
      accepted_risks: ['supabase.read-data', 'supabase.bulk-row-write', 'supabase.policy.W'],
      denied_risks: [],
      catalogs,
      overrides: [],
    });
    expect(result.all_allowed).toBe(false);
    expect(result.needs_approval).toEqual(['supabase[staging].bulk-row-write']);
    expect(result.denied).toEqual(['supabase.policy.W']);
    expect(result.risks.length).toBe(3);
  });

  test('all_allowed true when every effective_gate is allow', () => {
    const result = computePreview({
      bindings: [stagingBinding],
      accepted_risks: ['supabase.read-data'],
      denied_risks: [],
      catalogs,
      overrides: [],
    });
    expect(result.all_allowed).toBe(true);
    expect(result.needs_approval).toEqual([]);
    expect(result.denied).toEqual([]);
  });

  test('rejects a risk whose provider is not in the bindings list', () => {
    const result = computePreview({
      bindings: [stagingBinding],
      accepted_risks: ['github.read-code'],
      denied_risks: [],
      catalogs,
      overrides: [],
    });
    expect(result.all_allowed).toBe(false);
    expect(result.denied).toContain('github.read-code');
    expect(result.risks[0]!.blocked_reason).toContain("no binding for provider 'github'");
  });

  test('expands risks per binding when several env bindings exist', () => {
    const result = computePreview({
      bindings: [stagingBinding, prodBinding],
      accepted_risks: ['supabase.bulk-row-write'],
      denied_risks: [],
      catalogs,
      overrides: [],
    });
    expect(result.risks.length).toBe(2);
    const stagingRow = result.risks.find((r) => r.env === 'staging')!;
    const prodRow = result.risks.find((r) => r.env === 'prod')!;
    expect(stagingRow.effective_gate).toBe('confirm');
    expect(prodRow.effective_gate).toBe('deny');
  });

  test('denied_risks on wire short-circuits to deny', () => {
    const result = computePreview({
      bindings: [stagingBinding],
      accepted_risks: ['supabase.read-data'],
      denied_risks: ['supabase.read-data'],
      catalogs,
      overrides: [],
    });
    expect(result.risks[0]!.effective_gate).toBe('deny');
    expect(result.denied).toContain('supabase.read-data');
  });

  test('emits one row per (risk, binding) pair', () => {
    const result = computePreview({
      bindings: [stagingBinding, prodBinding],
      accepted_risks: ['supabase.read-data'],
      denied_risks: [],
      catalogs,
      overrides: [],
    });
    expect(result.risks.length).toBe(2);
    expect(result.risks[0]!.id).toBe('supabase.read-data');
    expect(result.risks[1]!.id).toBe('supabase.read-data');
  });
});
