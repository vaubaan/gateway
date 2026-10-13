/**
 * Unit tests for the decision core.
 *
 * Stubs the `Classifier` (the `classify` half of the plugin contract, plus
 * the optional `envOf`) so we can drive specific slice outputs without a
 * real provider plugin. The catalog is built in memory from a minimal
 * `RiskCatalog`; environments are resolved from the plugin's `envOf` first,
 * then from the mission's resources.
 */
import { describe, expect, test } from 'vitest';
import type { Resource, RiskCatalog, Slice } from '@vaubaan/shared';
import { indexCatalog, noEnvResolver } from '@vaubaan/policy-engine';

import {
  evaluateCallForToken,
  type AcceptedRisksSnapshot,
  type Classifier,
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
    },
  ],
};

const indexed = indexCatalog(catalog);

const resources: Resource[] = [{ provider: 'supabase', ref: 'prj_x', displayName: 'prj_x' }];

function makeAdapter(outcome: 'read' | 'bulk' | 'deny'): Classifier {
  return {
    classify: () => {
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
  const token: AcceptedRisksSnapshot = {
    id: 'tok1',
    accepted_risks: ['supabase.read-data', 'supabase.row-write-one'],
    denied_risks: [],
  };

  test('allow when classified slice intersects an accepted risk', () => {
    const verdict = evaluateCallForToken({
      tool: 'supabase__execute_sql',
      args: { query: 'select 1' },
      resources,
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
    // (which has read + row-write-one) → deny with it missing. The fallback
    // is not co-touched by a categorized write (ADR fallback-risk-only-when-uncategorized).
    const verdict = evaluateCallForToken({
      tool: 'supabase__bulk_update',
      args: {},
      resources,
      token,
      adapter: makeAdapter('bulk'),
      catalog: indexed,
    });
    expect(verdict.kind).toBe('deny');
    if (verdict.kind === 'deny') {
      expect(verdict.code).toBe('risk-not-accepted');
      expect(verdict.missing_risks).toContain('supabase.bulk-row-write');
      expect(verdict.missing_risks).not.toContain('supabase.uncategorized-write');
      expect(verdict.hint).toBeTruthy();
    }
  });

  test('the classifier receives the tool, the args and the resources', () => {
    const seen: unknown[] = [];
    const adapter: Classifier = {
      classify: (tool, args, res) => {
        seen.push(tool, args, res);
        return { denied: 'stop' };
      },
    };
    evaluateCallForToken({
      tool: 'supabase__execute_sql',
      args: { query: 'select 1' },
      resources,
      token,
      adapter,
      catalog: indexed,
    });
    expect(seen).toEqual(['supabase__execute_sql', { query: 'select 1' }, resources]);
  });

  test('environment qualification comes from the resources by default', () => {
    const envCatalog = indexCatalog({
      provider: 'supabase',
      risks: [{ ...catalog.risks[2]!, acceptable_in_envs: ['staging', 'prod'] }],
    });
    const staging: Resource = {
      provider: 'supabase',
      ref: 'prj_x',
      env: 'staging',
      displayName: 'staging',
    };
    const qualifiedToken: AcceptedRisksSnapshot = {
      id: 'tok3',
      accepted_risks: ['supabase[staging].bulk-row-write'],
      denied_risks: [],
    };
    const verdict = evaluateCallForToken({
      tool: 'supabase__bulk_update',
      args: {},
      resources: [staging],
      token: qualifiedToken,
      adapter: makeAdapter('bulk'),
      catalog: envCatalog,
    });
    expect(verdict.kind).toBe('allow');
    if (verdict.kind === 'allow') {
      expect(verdict.risks_touched).toEqual(['supabase[staging].bulk-row-write']);
    }

    // The adapter's `envOf` wins over the resource label (plugin-first,
    // ADR fallback-risk-only-when-uncategorized D4) : the slice says prod,
    // the owner labelled the resource staging, the call is a prod write.
    const prodToken: AcceptedRisksSnapshot = {
      id: 'tok4',
      accepted_risks: ['supabase[prod].bulk-row-write'],
      denied_risks: [],
    };
    const envOfAdapter: Classifier = {
      ...makeAdapter('bulk'),
      envOf: (slice) => (slice.action === 'W' ? 'prod' : undefined),
    };
    const derived = evaluateCallForToken({
      tool: 'supabase__bulk_update',
      args: {},
      resources: [staging],
      token: prodToken,
      adapter: envOfAdapter,
      catalog: envCatalog,
    });
    expect(derived.kind).toBe('allow');
    if (derived.kind === 'allow') {
      expect(derived.risks_touched).toEqual(['supabase[prod].bulk-row-write']);
    }
    // ...and an `envOf` that abstains falls back to the label.
    const abstaining: Classifier = { ...makeAdapter('bulk'), envOf: () => undefined };
    const labelled = evaluateCallForToken({
      tool: 'supabase__bulk_update',
      args: {},
      resources: [staging],
      token: qualifiedToken,
      adapter: abstaining,
      catalog: envCatalog,
    });
    expect(labelled.kind).toBe('allow');

    // An explicit resolver replaces the default one. One that knows no
    // environment leaves the env-scoped risk unqualified, where no mission
    // can hold it : the call is refused.
    const unqualified = evaluateCallForToken({
      tool: 'supabase__bulk_update',
      args: {},
      resources: [staging],
      token: qualifiedToken,
      adapter: makeAdapter('bulk'),
      catalog: envCatalog,
      envResolver: noEnvResolver,
    });
    expect(unqualified.kind).toBe('deny');
    if (unqualified.kind === 'deny') {
      expect(unqualified.missing_risks).toEqual(['supabase.bulk-row-write']);
    }
  });

  test("`envResolver: 'unqualified'` names the mode without a resolver", () => {
    const envCatalog = indexCatalog({
      provider: 'supabase',
      risks: [{ ...catalog.risks[2]!, acceptable_in_envs: ['staging', 'prod'] }],
    });
    const staging: Resource = {
      provider: 'supabase',
      ref: 'prj_x',
      env: 'staging',
      displayName: 'staging',
    };
    const verdict = evaluateCallForToken({
      tool: 'supabase__bulk_update',
      args: {},
      resources: [staging],
      token: { id: 'tok_u', accepted_risks: ['supabase.bulk-row-write'], denied_risks: [] },
      adapter: makeAdapter('bulk'),
      catalog: envCatalog,
      envResolver: 'unqualified',
    });
    expect(verdict.kind).toBe('allow');
    if (verdict.kind === 'allow') {
      expect(verdict.risks_touched).toEqual(['supabase.bulk-row-write']);
    }
  });

  test('`denied_risks` may be left out : a v5 mission carries none', () => {
    const verdict = evaluateCallForToken({
      tool: 'supabase__select',
      args: {},
      resources,
      token: { id: 'tok3', accepted_risks: ['supabase.read-data'] },
      adapter: makeAdapter('read'),
      catalog: indexed,
    });
    expect(verdict.kind).toBe('allow');
  });

  test('classify-denied surfaces the adapter denial reason', () => {
    const verdict = evaluateCallForToken({
      tool: 'whatever',
      args: {},
      resources,
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
      resources,
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
      resources,
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
