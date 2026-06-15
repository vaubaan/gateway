/**
 * Unit tests for the v4 risk-based gateway path.
 *
 * Mocks the V4ClassifierAdapter so we can drive specific slice outputs
 * without spinning up a real provider plugin. The catalog is built in
 * memory from a minimal `RiskCatalog`.
 */
import { describe, expect, test } from 'vitest';
import type { ProviderBinding, RiskCatalog, Slice } from '@vaubaan/shared';
import { indexCatalog } from '@vaubaan/policy-engine';

import {
  denyResponseBody,
  evaluateCallForToken,
  type CallVerdict,
  type V4ClassifierAdapter,
  type V4TokenSnapshot,
} from '../../src/risk-gateway.ts';

const catalog: RiskCatalog = {
  provider: 'supabase',
  risks: [
    {
      id: 'supabase.read-data',
      label: 'Read',
      reason: 'reads',
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
      id: 'supabase.row-write-one',
      label: 'Row',
      reason: 'row',
      matches: 'supabase.project[**].schema[**].table[**].row[one].W',
      vector: {
        reversibility: 'costly',
        blast: 'single',
        data: 'data',
        cost: 'free',
        visibility: 'internal',
        persistence: 'session',
      },
      default_gate: 'allow',
    },
    {
      id: 'supabase.bulk-row-write',
      label: 'Bulk',
      reason: 'bulk',
      matches: 'supabase.project[**].schema[**].table[**].row[bulk].W',
      vector: {
        reversibility: 'costly',
        blast: 'bulk',
        data: 'data',
        cost: 'moderate',
        visibility: 'internal',
        persistence: 'session',
      },
      default_gate: 'confirm',
    },
    {
      id: 'supabase.uncategorized-write',
      label: 'Fallback',
      reason: 'catch',
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

const indexed = indexCatalog(catalog);

const bindings: ProviderBinding[] = [
  {
    id: 'b1',
    project_id: 'p1',
    provider: 'supabase',
    resource_ref: 'prj_x',
    display_name: null,
    created_at: '2026-01-01',
  },
];

function makeAdapter(outcome: 'read' | 'bulk' | 'deny'): V4ClassifierAdapter {
  return {
    classifyV4: () => {
      if (outcome === 'deny') return { denied: 'bad args' };
      const action = outcome === 'read' ? 'R' : 'W';
      const cardinality = outcome === 'bulk' ? 'bulk' : 'one';
      const slice: Slice = {
        provider: 'supabase',
        path: [
          { kind: 'name', value: 'project' },
          { kind: 'ident', value: 'prj_x' },
          { kind: 'name', value: 'schema' },
          { kind: 'ident', value: 'public' },
          { kind: 'name', value: 'table' },
          { kind: 'ident', value: 'users' },
          { kind: 'name', value: 'row' },
          { kind: 'ident', value: cardinality },
        ],
        action,
      };
      return { slices: [slice] };
    },
  };
}

describe('evaluateCallForToken', () => {
  const token: V4TokenSnapshot = {
    id: 'tok1',
    accepted_risks: ['supabase.read-data', 'supabase.row-write-one'],
    denied_risks: [],
  };

  test('allow when classified slice intersects an accepted risk', () => {
    const verdict = evaluateCallForToken({
      tool: 'supabase__execute_sql',
      args: { query: 'select 1' },
      bindings,
      token,
      adapter: makeAdapter('read'),
      catalog: indexed,
    });
    expect(verdict.kind).toBe('allow');
    if (verdict.kind === 'allow') {
      expect(verdict.risks_touched).toContain('supabase.read-data');
      expect(verdict.executed_slices.length).toBe(1);
    }
  });

  test('deny when classified slice touches a non-accepted risk', () => {
    // bulk-row-write is in the catalog but not in token.accepted_risks
    // (which has read + row-write-one). The fallback uncategorized-write
    // also catches `.W`, also not accepted → deny with both missing.
    const verdict = evaluateCallForToken({
      tool: 'supabase__bulk_update',
      args: {},
      bindings,
      token,
      adapter: makeAdapter('bulk'),
      catalog: indexed,
    });
    expect(verdict.kind).toBe('deny');
    if (verdict.kind === 'deny') {
      expect(verdict.missing_risks).toContain('supabase.bulk-row-write');
      expect(verdict.missing_risks).toContain('supabase.uncategorized-write');
      expect(verdict.hint).toBeTruthy();
    }
  });

  test('classify-denied surfaces the adapter denial reason', () => {
    const verdict = evaluateCallForToken({
      tool: 'whatever',
      args: {},
      bindings,
      token,
      adapter: makeAdapter('deny'),
      catalog: indexed,
    });
    expect(verdict.kind).toBe('classify-denied');
    if (verdict.kind === 'classify-denied') {
      expect(verdict.reason).toBe('bad args');
    }
  });

  test('no-catalog when catalog is undefined', () => {
    const verdict = evaluateCallForToken({
      tool: 't',
      args: {},
      bindings,
      token,
      adapter: makeAdapter('read'),
      catalog: undefined,
    });
    expect(verdict.kind).toBe('no-catalog');
  });

  test('explicit denied_risks deny even when accepted_risks would allow', () => {
    const verdict = evaluateCallForToken({
      tool: 'supabase__select',
      args: {},
      bindings,
      token: {
        id: 'tok2',
        accepted_risks: ['supabase.read-data'],
        denied_risks: ['supabase.read-data'],
      },
      adapter: makeAdapter('read'),
      catalog: indexed,
    });
    expect(verdict.kind).toBe('deny');
  });
});

describe('denyResponseBody', () => {
  test('shapes the spec-mandated 403 body', () => {
    const verdict: Extract<CallVerdict, { kind: 'deny' }> = {
      kind: 'deny',
      missing_risks: ['supabase.bulk-row-write'],
      executed_slices: [
        {
          provider: 'supabase',
          path: [{ kind: 'name', value: 'project' }],
          action: 'W',
        },
      ],
      hint: 'rerun with broader risk',
    };
    const body = denyResponseBody(verdict);
    expect(body.error).toBe('risk-not-accepted');
    expect(body.missing_risks).toEqual(['supabase.bulk-row-write']);
    expect(body.executed_slices.length).toBe(1);
    expect(body.hint).toBe('rerun with broader risk');
  });
});
