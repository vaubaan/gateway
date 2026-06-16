/**
 * Unit tests for the pure-compute risk-preview layer (post drop-confirm).
 *
 * Lives at `lib/mint/risk-preview.ts`. Replaces the old gate-resolution
 * shape with `{ acceptable, inherited }` per row.
 */
import { describe, expect, test } from 'vitest';
import type { Provider, RiskCatalog } from '@vaubaan/shared';
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

const parentAll = new Set([
  'supabase.read-data',
  'supabase[staging].bulk-row-write',
  'supabase[prod].bulk-row-write',
  'supabase.policy.W',
]);

describe('resolveRiskRow', () => {
  test('marks an unknown risk as blocked with a clear reason', () => {
    const row = resolveRiskRow('supabase.unknown-risk', stagingBinding, supabaseIndexed, parentAll);
    expect(row.acceptable).toBe(false);
    expect(row.blocked_reason).toContain("unknown risk 'supabase.unknown-risk'");
  });

  test('marks risk as blocked when catalog is undefined', () => {
    const row = resolveRiskRow('supabase.read-data', stagingBinding, undefined, parentAll);
    expect(row.acceptable).toBe(false);
    expect(row.blocked_reason).toContain('not loaded');
  });

  test('acceptable + inherited when catalog OK and parent carries the risk', () => {
    const row = resolveRiskRow('supabase.read-data', stagingBinding, supabaseIndexed, parentAll);
    expect(row.acceptable).toBe(true);
    expect(row.inherited).toBe(true);
    expect(row.label).toBe('Read');
  });

  test('qualifies env-scoped ids and leaves account-scoped ones alone', () => {
    const bulk = resolveRiskRow(
      'supabase.bulk-row-write',
      stagingBinding,
      supabaseIndexed,
      parentAll,
    );
    expect(bulk.id).toBe('supabase[staging].bulk-row-write');
    expect(bulk.acceptable).toBe(true);
    const read = resolveRiskRow('supabase.read-data', stagingBinding, supabaseIndexed, parentAll);
    expect(read.id).toBe('supabase.read-data');
  });

  test('not acceptable on env outside acceptable_in_envs', () => {
    const row = resolveRiskRow('supabase.bulk-row-write', prodBinding, supabaseIndexed, parentAll);
    expect(row.acceptable).toBe(false);
    expect(row.blocked_reason).toMatch(/not acceptable in env 'prod'/);
  });

  test('not inherited when parent does not carry the risk', () => {
    const emptyParent = new Set<string>();
    const row = resolveRiskRow('supabase.read-data', stagingBinding, supabaseIndexed, emptyParent);
    expect(row.acceptable).toBe(true);
    expect(row.inherited).toBe(false);
    expect(row.blocked_reason).toMatch(/parent token's accepted_risks/);
  });

  test('null parent → inherited optimistic true', () => {
    const row = resolveRiskRow('supabase.read-data', stagingBinding, supabaseIndexed, null);
    expect(row.inherited).toBe(true);
  });
});

describe('computePreview', () => {
  test('ok=false when at least one row is not acceptable', () => {
    const result = computePreview({
      bindings: [stagingBinding, prodBinding],
      accepted_risks: ['supabase.bulk-row-write'],
      catalogs,
      parent_accepted_risks: Array.from(parentAll),
    });
    expect(result.ok).toBe(false);
    expect(result.not_acceptable.length).toBeGreaterThan(0);
  });

  test('ok=true when every row is acceptable + inherited', () => {
    const result = computePreview({
      bindings: [stagingBinding],
      accepted_risks: ['supabase.read-data'],
      catalogs,
      parent_accepted_risks: Array.from(parentAll),
    });
    expect(result.ok).toBe(true);
    expect(result.not_acceptable).toEqual([]);
    expect(result.not_inherited).toEqual([]);
  });

  test('rejects a risk whose provider is not in the bindings list', () => {
    const result = computePreview({
      bindings: [stagingBinding],
      accepted_risks: ['github.read-code'],
      catalogs,
      parent_accepted_risks: Array.from(parentAll),
    });
    expect(result.ok).toBe(false);
    expect(result.not_acceptable).toContain('github.read-code');
    expect(result.risks[0]!.blocked_reason).toContain("no binding for provider 'github'");
  });

  test('expands risks per binding when several env bindings exist', () => {
    const result = computePreview({
      bindings: [stagingBinding, prodBinding],
      accepted_risks: ['supabase.bulk-row-write'],
      catalogs,
      parent_accepted_risks: Array.from(parentAll),
    });
    expect(result.risks.length).toBe(2);
    const stagingRow = result.risks.find((r) => r.env === 'staging')!;
    const prodRow = result.risks.find((r) => r.env === 'prod')!;
    expect(stagingRow.acceptable).toBe(true);
    expect(prodRow.acceptable).toBe(false);
  });

  test('emits one row per (risk, binding) pair', () => {
    const result = computePreview({
      bindings: [stagingBinding, prodBinding],
      accepted_risks: ['supabase.read-data'],
      catalogs,
      parent_accepted_risks: Array.from(parentAll),
    });
    expect(result.risks.length).toBe(2);
    expect(result.risks[0]!.id).toBe('supabase.read-data');
    expect(result.risks[1]!.id).toBe('supabase.read-data');
  });
});
