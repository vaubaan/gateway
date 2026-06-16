/**
 * Unit tests for the per-plane filtering helpers in `provider-info.ts` :
 *  - `risksForPlane` : attributes a `RiskEntry` to one plane by intersecting
 *    its slice patterns with each plane's entity set.
 *  - `toolsForPlane` : filters MCP tools to a plane via the `toolPlanes` map.
 *
 * These power the per-plane pages on `/orgs/:slug/providers/:provider/:plane`
 * (Supabase = 4 planes : db, storage, auth, functions).
 */

import { describe, expect, it } from 'vitest';

import type { DataModel, RiskEntry } from '@vaubaan/shared';

import { risksForPlane, toolsForPlane } from '@/components/providers/provider-info';

const SUPABASE_MODEL: DataModel = {
  provider: 'supabase',
  planes: [
    {
      slug: 'db',
      entities: [
        { name: 'project', parent: null, cardinalities: ['one'], description: 'p' },
        { name: 'schema', parent: 'project', cardinalities: ['bounded'], description: 's' },
        { name: 'table', parent: 'schema', cardinalities: ['bounded'], description: 't' },
      ],
    },
    {
      slug: 'storage',
      entities: [
        { name: 'project', parent: null, cardinalities: ['one'], description: 'p' },
        { name: 'bucket', parent: 'project', cardinalities: ['bounded'], description: 'b' },
      ],
    },
  ],
};

function risk(id: string, matches: string | string[]): RiskEntry {
  return {
    id,
    label: id,
    reason: 'test',
    matches,
    vector: {
      reversibility: 'reversible',
      blast: 'single',
      data: 'metadata',
      cost: 'free',
      visibility: 'internal',
      persistence: 'stateless',
    },
    default_gate: 'allow',
  };
}

describe('risksForPlane', () => {
  it('returns only risks whose patterns mention plane-unique entities', () => {
    const entries: RiskEntry[] = [
      risk('db-write', 'supabase.project[**].schema[**].table[**].W'),
      risk('storage-write', 'supabase.project[**].bucket[**].W'),
    ];
    expect(risksForPlane(entries, SUPABASE_MODEL, 'db').map((e) => e.id)).toEqual(['db-write']);
    expect(risksForPlane(entries, SUPABASE_MODEL, 'storage').map((e) => e.id)).toEqual([
      'storage-write',
    ]);
  });

  it('includes wildcard-only risks in every plane (fallback patterns)', () => {
    const entries = [risk('any-write', 'supabase.**.W')];
    expect(risksForPlane(entries, SUPABASE_MODEL, 'db').map((e) => e.id)).toEqual(['any-write']);
    expect(risksForPlane(entries, SUPABASE_MODEL, 'storage').map((e) => e.id)).toEqual([
      'any-write',
    ]);
  });

  it('returns an empty list for an unknown plane slug', () => {
    const entries = [risk('db-write', 'supabase.project[**].schema[**].table[**].W')];
    expect(risksForPlane(entries, SUPABASE_MODEL, 'nope')).toEqual([]);
  });
});

describe('toolsForPlane', () => {
  it('returns all tools when the provider has a single plane', () => {
    const info = {
      slug: 'github' as const,
      label: 'GitHub',
      pitch: '',
      kind: 'cloud' as const,
      dataModel: SUPABASE_MODEL,
      tools: [
        { name: 't1', description: '', inputSchema: { type: 'object' as const, properties: {} } },
        { name: 't2', description: '', inputSchema: { type: 'object' as const, properties: {} } },
      ],
      planes: [{ slug: 'repo', label: 'Repo', pitch: '' }],
      setup: '',
      catalogPath: '',
      handbook: '',
    };
    expect(toolsForPlane(info, 'repo').map((t) => t.name)).toEqual(['t1', 't2']);
  });

  it('filters by toolPlanes when the provider has multiple planes', () => {
    const info = {
      slug: 'supabase' as const,
      label: 'Supabase',
      pitch: '',
      kind: 'cloud' as const,
      dataModel: SUPABASE_MODEL,
      tools: [
        {
          name: 'list_tables',
          description: '',
          inputSchema: { type: 'object' as const, properties: {} },
        },
        {
          name: 'list_buckets',
          description: '',
          inputSchema: { type: 'object' as const, properties: {} },
        },
      ],
      toolPlanes: { list_tables: 'db', list_buckets: 'storage' } as Record<string, string>,
      planes: [
        { slug: 'db', label: 'DB', pitch: '' },
        { slug: 'storage', label: 'Storage', pitch: '' },
      ],
      setup: '',
      catalogPath: '',
      handbook: '',
    };
    expect(toolsForPlane(info, 'db').map((t) => t.name)).toEqual(['list_tables']);
    expect(toolsForPlane(info, 'storage').map((t) => t.name)).toEqual(['list_buckets']);
  });
});
