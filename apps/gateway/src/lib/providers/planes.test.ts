import { createRegistry } from '@vaubaan/plugin-sdk';
import type { DataModel } from '@vaubaan/shared';
import { describe, expect, it } from 'vitest';

import { SHIPPED_PLUGINS } from '../../server/compose/shipped-plugins';
import {
  hasSeveralPlanes,
  OTHER_PLANE,
  planesOfPatterns,
  planesOfToolName,
  riskPlanesOf,
} from './planes';
import { providerReference } from './reference';

const entity = (name: string, parent: string | null = 'root') => ({
  name,
  parent,
  cardinalities: ['bounded' as const],
  description: name,
});

/** Two planes that share their root, as Supabase's do. */
const MODEL: DataModel = {
  provider: 'acme',
  planes: [
    { slug: 'db', entities: [entity('root', null), entity('table'), entity('db-function')] },
    {
      slug: 'files',
      entities: [entity('root', null), entity('bucket'), entity('signed-url', 'bucket')],
    },
  ],
};

const registry = createRegistry(SHIPPED_PLUGINS);
const supabase = registry.get('supabase');
if (!supabase) throw new Error('the supabase plugin is not shipped');

describe('planesOfPatterns', () => {
  it('files a pattern under the plane of its first entity that one plane alone declares', () => {
    expect(planesOfPatterns(MODEL, ['acme.root[**].table[*].W'])).toEqual(['db']);
    expect(planesOfPatterns(MODEL, ['acme.root[**].bucket[**].signed-url[**].R'])).toEqual([
      'files',
    ]);
  });

  it('answers every plane the patterns reach, in the order of the model', () => {
    expect(
      planesOfPatterns(MODEL, ['acme.root[**].bucket[**].W', 'acme.root[**].table[*].W']),
    ).toEqual(['db', 'files']);
  });

  it('answers "other" for a pattern that names no entity of a single plane, never a guess', () => {
    expect(planesOfPatterns(MODEL, ['acme.**.R'])).toEqual([OTHER_PLANE]);
    expect(planesOfPatterns(MODEL, ['acme.root[**].W'])).toEqual([OTHER_PLANE]);
    expect(planesOfPatterns(MODEL, ['not a pattern'])).toEqual([OTHER_PLANE]);
  });
});

describe('planesOfToolName', () => {
  it('files a tool under the plane of the entity its name contains, plural or not', () => {
    expect(planesOfToolName(MODEL, 'acme__list_buckets')).toEqual(['files']);
    expect(planesOfToolName(MODEL, 'acme__create_signed_url')).toEqual(['files']);
    expect(planesOfToolName(MODEL, 'acme__list_tables')).toEqual(['db']);
    expect(planesOfToolName(MODEL, 'acme__call_db_function')).toEqual(['db']);
  });

  it('answers "other" when the name contains no entity of a single plane', () => {
    expect(planesOfToolName(MODEL, 'acme__get_root')).toEqual([OTHER_PLANE]);
    // `function` alone is not `db-function`: a part of an entity name is not the entity.
    expect(planesOfToolName(MODEL, 'acme__create_function')).toEqual([OTHER_PLANE]);
    expect(planesOfToolName(MODEL, 'acme__execute_sql')).toEqual([OTHER_PLANE]);
  });

  it('answers "other" when two planes match at the same length', () => {
    expect(planesOfToolName(MODEL, 'acme__copy_table_to_bucket')).toEqual([OTHER_PLANE]);
  });
});

describe('the planes of the shipped plugins', () => {
  it('offers a plane control for a model with several planes only', () => {
    expect(hasSeveralPlanes(supabase.plugin.dataModel)).toBe(true);
    expect(riskPlanesOf(supabase.plugin.dataModel, supabase.plugin.catalog)).not.toBeNull();
    const github = registry.get('github');
    expect(github && riskPlanesOf(github.plugin.dataModel, github.plugin.catalog)).toBeNull();
    expect(providerReference(registry, 'github')?.plane_filters).toEqual([]);
  });

  it('files every Supabase risk under a plane, and the two catch-alls under "other"', () => {
    const planes = riskPlanesOf(supabase.plugin.dataModel, supabase.plugin.catalog);
    expect(planes?.planes).toEqual(['db', 'storage', 'auth', 'functions', OTHER_PLANE]);
    expect(planes?.by_risk['supabase.migration-write']).toEqual(['db']);
    expect(planes?.by_risk['supabase.storage.bulk-object-write']).toEqual(['storage']);
    expect(planes?.by_risk['supabase.auth.generate-link']).toEqual(['auth']);
    expect(planes?.by_risk['supabase.function-secret-write']).toEqual(['functions']);
    const other = Object.entries(planes?.by_risk ?? {})
      .filter(([, slugs]) => slugs.includes(OTHER_PLANE))
      .map(([id]) => id);
    expect(other).toEqual(['supabase.read-data', 'supabase.uncategorized-write']);
  });

  it('counts, per plane, the risks and the tools the reference files there', () => {
    const reference = providerReference(registry, 'supabase');
    const filters = reference?.plane_filters ?? [];
    expect(filters.map((filter) => filter.slug)).toEqual([
      'db',
      'storage',
      'auth',
      'functions',
      OTHER_PLANE,
    ]);
    const entries = reference?.risk_groups.flatMap((group) => group.entries) ?? [];
    // An entry is counted under each of its planes, and under one at least.
    expect(filters.reduce((sum, filter) => sum + filter.risks, 0)).toBeGreaterThanOrEqual(
      entries.length,
    );
    expect(entries.every((entry) => entry.planes.length > 0)).toBe(true);
    expect(reference?.tools.every((tool) => tool.planes.length === 1)).toBe(true);
    const storage = reference?.tools.filter((tool) => tool.planes.includes('storage')) ?? [];
    expect(storage.map((tool) => tool.name)).toContain('supabase__list_buckets');
  });
});
