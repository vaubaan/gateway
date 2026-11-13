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
  evaluateCallForMission,
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

describe('evaluateCallForMission', () => {
  const token: AcceptedRisksSnapshot = {
    id: 'tok1',
    accepted_risks: ['supabase.read-data', 'supabase.row-write-one'],
  };

  test('allow when classified slice intersects an accepted risk', () => {
    const verdict = evaluateCallForMission({
      tool: 'supabase__execute_sql',
      args: { query: 'select 1' },
      resources,
      mission: token,
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
    const verdict = evaluateCallForMission({
      tool: 'supabase__bulk_update',
      args: {},
      resources,
      mission: token,
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
    evaluateCallForMission({
      tool: 'supabase__execute_sql',
      args: { query: 'select 1' },
      resources,
      mission: token,
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
    };
    const verdict = evaluateCallForMission({
      tool: 'supabase__bulk_update',
      args: {},
      resources: [staging],
      mission: qualifiedToken,
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
    };
    const envOfAdapter: Classifier = {
      ...makeAdapter('bulk'),
      envOf: (slice) => (slice.action === 'W' ? 'prod' : undefined),
    };
    const derived = evaluateCallForMission({
      tool: 'supabase__bulk_update',
      args: {},
      resources: [staging],
      mission: prodToken,
      adapter: envOfAdapter,
      catalog: envCatalog,
    });
    expect(derived.kind).toBe('allow');
    if (derived.kind === 'allow') {
      expect(derived.risks_touched).toEqual(['supabase[prod].bulk-row-write']);
    }
    // ...and an `envOf` that abstains falls back to the label.
    const abstaining: Classifier = { ...makeAdapter('bulk'), envOf: () => undefined };
    const labelled = evaluateCallForMission({
      tool: 'supabase__bulk_update',
      args: {},
      resources: [staging],
      mission: qualifiedToken,
      adapter: abstaining,
      catalog: envCatalog,
    });
    expect(labelled.kind).toBe('allow');

    // An explicit resolver replaces the default one. One that knows no
    // environment leaves the env-scoped risk unqualified, where no mission
    // can hold it : the call is refused.
    const unqualified = evaluateCallForMission({
      tool: 'supabase__bulk_update',
      args: {},
      resources: [staging],
      mission: qualifiedToken,
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
    const verdict = evaluateCallForMission({
      tool: 'supabase__bulk_update',
      args: {},
      resources: [staging],
      mission: { id: 'tok_u', accepted_risks: ['supabase.bulk-row-write'] },
      adapter: makeAdapter('bulk'),
      catalog: envCatalog,
      envResolver: 'unqualified',
    });
    expect(verdict.kind).toBe('allow');
    if (verdict.kind === 'allow') {
      expect(verdict.risks_touched).toEqual(['supabase.bulk-row-write']);
    }
  });

  test('classify-denied surfaces the adapter denial reason', () => {
    const verdict = evaluateCallForMission({
      tool: 'whatever',
      args: {},
      resources,
      mission: token,
      adapter: makeAdapter('deny'),
      catalog: indexed,
    });
    expect(verdict.kind).toBe('classify-denied');
    if (verdict.kind === 'classify-denied') {
      expect(verdict.reason).toBe('bad args');
    }
  });

  test('no-catalog when catalog is undefined', () => {
    const verdict = evaluateCallForMission({
      tool: 't',
      args: {},
      resources,
      mission: token,
      adapter: makeAdapter('read'),
      catalog: undefined,
    });
    expect(verdict.kind).toBe('no-catalog');
  });
});
