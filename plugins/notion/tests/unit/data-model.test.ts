/**
 * The data model of the `notion` plugin : referential integrity, and every
 * slice the classifier emits and every catalog pattern written with the
 * declared entities, each under its declared parent. `definePlugin` checks
 * the first only ; the second is what a reviewer would otherwise compare by
 * hand (plugins/README.md, step 2).
 */
import { describe, expect, test } from 'vitest';

import { parseSlice, validateDataModel, type Slice } from '@vaubaan/plugin-sdk';

import { classifyNotion } from '../../src/classify.ts';
import { notionCatalog, notionDataModel } from '../../src/index.ts';
import { pageRoot } from './fixtures.ts';
import { SAMPLES } from './samples.ts';

const entities = new Map(
  notionDataModel.planes.flatMap((p) => p.entities.map((e) => [e.name, e] as const)),
);

/** The entity names of a slice, in order, and whether each is a child of the one before. */
function chainIssues(slice: Slice): string[] {
  const names = slice.path.flatMap((s) => (s.kind === 'name' ? [s.value] : []));
  const issues: string[] = [];
  let parent: string | null = null;
  for (const name of names) {
    const entity = entities.get(name);
    if (!entity) issues.push(`'${name}' is not an entity of the model`);
    else if (entity.parent !== parent)
      issues.push(`'${name}' is not a child of '${String(parent)}'`);
    parent = name;
  }
  return issues;
}

describe('notionDataModel', () => {
  test('every entity.parent references an existing entity in the same plane ; names are unique', () => {
    expect(validateDataModel(notionDataModel)).toEqual([]);
    const names = notionDataModel.planes.flatMap((p) => p.entities.map((e) => e.name));
    expect(new Set(names).size).toBe(names.length);
  });

  test('every emitted slice follows the model', () => {
    for (const [tool, samples] of Object.entries(SAMPLES)) {
      for (const sample of samples) {
        const out = classifyNotion(tool, sample.args, sample.resources ?? [pageRoot]);
        if ('denied' in out) continue;
        for (const slice of out.slices) expect(chainIssues(slice), tool).toEqual([]);
      }
    }
  });

  test('every catalog pattern but the fallback follows the model', () => {
    for (const risk of notionCatalog.catalog.risks) {
      if (risk.fallback) continue;
      for (const pattern of [risk.matches].flat()) {
        expect(chainIssues(parseSlice(pattern)), pattern).toEqual([]);
      }
    }
  });
});
