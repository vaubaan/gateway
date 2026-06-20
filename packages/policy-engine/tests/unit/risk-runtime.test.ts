import { describe, expect, test } from 'vitest';
import type { ProviderBinding, RiskCatalog } from '@vaubaan/shared';

import { indexCatalog } from '../../src/risk-evaluator.ts';
import { evaluateCall, evaluateCallSimple } from '../../src/risk-runtime.ts';
import { parseSlice } from '../../src/slice-dsl.ts';

const catalog: RiskCatalog = {
  provider: 'github',
  risks: [
    {
      id: 'github.read-code',
      label: 'read',
      reason: 'r',
      matches: 'github.repo[**].file[**].R',
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
      id: 'github.feature-branch-write',
      label: 'feat',
      reason: 'r',
      matches: 'github.repo[**].branch[feature/*,fix/*].file[**].W',
      vector: {
        reversibility: 'reversible',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'session',
      },
    },
    {
      id: 'github.merge-protected',
      label: 'merge',
      reason: 'r',
      matches: 'github.repo[**].branch[main,master,prod].W',
      vector: {
        reversibility: 'costly',
        blast: 'env',
        data: 'data',
        cost: 'moderate',
        visibility: 'team',
        persistence: 'session',
      },
    },
    {
      id: 'github.uncategorized-write',
      label: 'fallback',
      reason: 'r',
      matches: 'github.**.W',
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

const idx = indexCatalog(catalog);

describe('evaluateCall — allow path', () => {
  test('feature branch write with feature-branch-write + fallback accepted', () => {
    const d = evaluateCall({
      executed_slices: [parseSlice('github.repo[foo].branch[feature/x].file[a.ts].W')],
      token_accepted_risks: new Set(['github.feature-branch-write', 'github.uncategorized-write']),
      catalog: idx,
    });
    expect(d.outcome).toBe('allowed');
    if (d.outcome === 'allowed') {
      expect(d.risks_touched).toContain('github.feature-branch-write');
      expect(d.risks_touched).toContain('github.uncategorized-write');
    }
  });

  test('read code accepted', () => {
    const d = evaluateCall({
      executed_slices: [parseSlice('github.repo[foo].file[a.ts].R')],
      token_accepted_risks: new Set(['github.read-code']),
      catalog: idx,
    });
    expect(d.outcome).toBe('allowed');
  });
});

describe('evaluateCall — denied paths', () => {
  test('missing risk → deny with missing_risks', () => {
    const d = evaluateCall({
      executed_slices: [parseSlice('github.repo[foo].branch[main].W')],
      token_accepted_risks: new Set(['github.read-code']),
      catalog: idx,
    });
    expect(d.outcome).toBe('denied');
    if (d.outcome === 'denied') {
      expect(d.missing_risks).toContain('github.merge-protected');
      expect(d.missing_risks).toContain('github.uncategorized-write');
      expect(d.hint).toContain('not granted');
    }
  });

  test('explicit deny wins over acceptance', () => {
    const d = evaluateCall({
      executed_slices: [parseSlice('github.repo[foo].file[a.ts].R')],
      token_accepted_risks: new Set(['github.read-code']),
      token_denied_risks: new Set(['github.read-code']),
      catalog: idx,
    });
    expect(d.outcome).toBe('denied');
    if (d.outcome === 'denied') {
      expect(d.missing_risks).toEqual(['github.read-code']);
      expect(d.hint).toContain('explicitly denies');
    }
  });

  test('no slice → deny (classification gap)', () => {
    const d = evaluateCall({
      executed_slices: [],
      token_accepted_risks: new Set(),
      catalog: idx,
    });
    expect(d.outcome).toBe('denied');
    if (d.outcome === 'denied') {
      expect(d.hint).toContain('no slice');
    }
  });

  test('no risk in catalog matches the slice → deny', () => {
    const otherCatalog: RiskCatalog = { provider: 'github', risks: [] };
    const d = evaluateCall({
      executed_slices: [parseSlice('github.repo[foo].W')],
      token_accepted_risks: new Set(),
      catalog: indexCatalog(otherCatalog),
    });
    expect(d.outcome).toBe('denied');
    if (d.outcome === 'denied') {
      expect(d.hint).toContain('no risk');
      expect(d.hint).toContain('catalog matches');
    }
  });
});

describe('evaluateCall — multi-slice scenarios', () => {
  test('multi-slice : all risks must be covered', () => {
    const d = evaluateCall({
      executed_slices: [
        parseSlice('github.repo[foo].file[a.ts].R'),
        parseSlice('github.repo[foo].branch[main].W'),
      ],
      token_accepted_risks: new Set([
        'github.read-code',
        'github.merge-protected',
        'github.uncategorized-write',
      ]),
      catalog: idx,
    });
    expect(d.outcome).toBe('allowed');
  });

  test('multi-slice : missing one fails the whole call', () => {
    const d = evaluateCall({
      executed_slices: [
        parseSlice('github.repo[foo].file[a.ts].R'),
        parseSlice('github.repo[foo].branch[main].W'),
      ],
      token_accepted_risks: new Set(['github.read-code']), // missing merge-protected + fallback
      catalog: idx,
    });
    expect(d.outcome).toBe('denied');
  });
});

describe('evaluateCallSimple — convenience wrapper', () => {
  test('end-to-end happy path', () => {
    const d = evaluateCallSimple(
      catalog,
      [parseSlice('github.repo[foo].file[a.ts].R')],
      ['github.read-code'],
    );
    expect(d.outcome).toBe('allowed');
  });
});

// ─── env-scoped subset check (spec §4.4) ─────────────────────────────────────

describe('evaluateCall — env-qualified subset check', () => {
  const supabaseCatalog: RiskCatalog = {
    provider: 'supabase',
    risks: [
      {
        id: 'supabase.bulk-row-write',
        label: 'bulk',
        reason: 'bulk row write',
        matches: 'supabase.project[**].schema[**].table[**].row[bulk].W',
        vector: {
          reversibility: 'costly',
          blast: 'bulk',
          data: 'data',
          cost: 'moderate',
          visibility: 'internal',
          persistence: 'session',
        },
        acceptable_in_envs: ['staging', 'prod'],
      },
    ],
  };
  const supabaseIdx = indexCatalog(supabaseCatalog);

  const stagingBinding: ProviderBinding = {
    id: 'b1',
    project_id: 'p1',
    provider: 'supabase',
    resource_ref: 'staging-ref',
    display_name: null,
    environment: 'staging',
    created_at: '2026-01-01',
  };
  const prodBinding: ProviderBinding = {
    id: 'b2',
    project_id: 'p1',
    provider: 'supabase',
    resource_ref: 'prod-ref',
    display_name: null,
    environment: 'prod',
    created_at: '2026-01-01',
  };

  const stagingBulkSlice = parseSlice(
    'supabase.project[staging-ref].schema[any].table[any].row[bulk].W',
  );
  const prodBulkSlice = parseSlice('supabase.project[prod-ref].schema[any].table[any].row[bulk].W');

  test('token accepted `supabase[staging].bulk-row-write` allows staging binding call', () => {
    const d = evaluateCall({
      executed_slices: [stagingBulkSlice],
      token_accepted_risks: new Set(['supabase[staging].bulk-row-write']),
      catalog: supabaseIdx,
      bindings: [stagingBinding, prodBinding],
    });
    expect(d.outcome).toBe('allowed');
    if (d.outcome === 'allowed') {
      expect(d.risks_touched).toEqual(['supabase[staging].bulk-row-write']);
    }
  });

  test('token accepted `supabase[staging].bulk-row-write` denies prod binding call', () => {
    const d = evaluateCall({
      executed_slices: [prodBulkSlice],
      token_accepted_risks: new Set(['supabase[staging].bulk-row-write']),
      catalog: supabaseIdx,
      bindings: [stagingBinding, prodBinding],
    });
    expect(d.outcome).toBe('denied');
    if (d.outcome === 'denied') {
      // The missing risk is the qualified one for the prod env.
      expect(d.missing_risks).toContain('supabase[prod].bulk-row-write');
    }
  });

  test('no bindings provided → risks_touched returned non-qualified (legacy/test mode)', () => {
    const d = evaluateCall({
      executed_slices: [stagingBulkSlice],
      // The token would have to use the non-qualified id when bindings are
      // absent (this is the legacy/test entrypoint).
      token_accepted_risks: new Set(['supabase.bulk-row-write']),
      catalog: supabaseIdx,
    });
    expect(d.outcome).toBe('allowed');
  });
});

// ─── acceptable_in_envs runtime filter (Railway upsert-variable bug) ────────

describe('evaluateCall — acceptable_in_envs runtime filter', () => {
  const railwayCatalog: RiskCatalog = {
    provider: 'railway',
    risks: [
      {
        id: 'railway.upsert-variable-staging',
        label: 'upsert var (non-prod)',
        reason: 'r',
        matches: 'railway.project[**].environment[**].service-var[**].W',
        vector: {
          reversibility: 'reversible',
          blast: 'env',
          data: 'secret',
          cost: 'moderate',
          visibility: 'internal',
          persistence: 'posture',
        },
        acceptable_in_envs: ['staging', 'preview', 'dev'],
      },
      {
        id: 'railway.upsert-variable-prod',
        label: 'upsert var (prod)',
        reason: 'r',
        matches: 'railway.project[**].environment[**].service-var[**].W',
        vector: {
          reversibility: 'costly',
          blast: 'env',
          data: 'secret',
          cost: 'moderate',
          visibility: 'internal',
          persistence: 'posture',
        },
      },
      {
        id: 'railway.uncategorized-write',
        label: 'fallback',
        reason: 'r',
        matches: 'railway.**.W',
        vector: {
          reversibility: 'costly',
          blast: 'env',
          data: 'data',
          cost: 'moderate',
          visibility: 'internal',
          persistence: 'session',
        },
      },
    ],
  };
  const railwayIdx = indexCatalog(railwayCatalog);

  const prodBinding: ProviderBinding = {
    id: 'b1',
    project_id: 'p1',
    provider: 'railway',
    resource_ref: 'pid-123',
    display_name: null,
    environment: 'prod',
    created_at: '2026-01-01',
  };

  const stagingBinding: ProviderBinding = {
    id: 'b2',
    project_id: 'p1',
    provider: 'railway',
    resource_ref: 'pid-456',
    display_name: null,
    environment: 'staging',
    created_at: '2026-01-01',
  };

  const prodSlice = parseSlice('railway.project[pid-123].environment[prod].service-var[MY_VAR].W');
  const stagingSlice = parseSlice(
    'railway.project[pid-456].environment[staging].service-var[MY_VAR].W',
  );

  test('prod binding: only upsert-variable-prod fires, staging variant is skipped', () => {
    const d = evaluateCall({
      executed_slices: [prodSlice],
      token_accepted_risks: new Set([
        'railway.upsert-variable-prod',
        'railway.uncategorized-write',
      ]),
      catalog: railwayIdx,
      bindings: [prodBinding],
    });
    expect(d.outcome).toBe('allowed');
    if (d.outcome === 'allowed') {
      expect(d.risks_touched).toContain('railway.upsert-variable-prod');
      expect(d.risks_touched).toContain('railway.uncategorized-write');
      expect(d.risks_touched).not.toContain('railway[prod].upsert-variable-staging');
    }
  });

  test('staging binding: upsert-variable-staging fires; prod variant also fires (not env-scoped)', () => {
    // upsert-variable-prod has no acceptable_in_envs → it is NOT env-scoped
    // and fires for any env. The token must include it. A follow-up catalog
    // fix should add acceptable_in_envs: ['prod'] to the -prod variant.
    const d = evaluateCall({
      executed_slices: [stagingSlice],
      token_accepted_risks: new Set([
        'railway[staging].upsert-variable-staging',
        'railway.upsert-variable-prod',
        'railway.uncategorized-write',
      ]),
      catalog: railwayIdx,
      bindings: [stagingBinding],
    });
    expect(d.outcome).toBe('allowed');
    if (d.outcome === 'allowed') {
      expect(d.risks_touched).toContain('railway[staging].upsert-variable-staging');
      expect(d.risks_touched).toContain('railway.upsert-variable-prod');
      expect(d.risks_touched).toContain('railway.uncategorized-write');
    }
  });

  test('prod binding without upsert-variable-prod accepted → deny (not phantom staging)', () => {
    const d = evaluateCall({
      executed_slices: [prodSlice],
      token_accepted_risks: new Set(['railway.uncategorized-write']),
      catalog: railwayIdx,
      bindings: [prodBinding],
    });
    expect(d.outcome).toBe('denied');
    if (d.outcome === 'denied') {
      expect(d.missing_risks).toContain('railway.upsert-variable-prod');
      expect(d.missing_risks).not.toContain('railway[prod].upsert-variable-staging');
    }
  });
});
