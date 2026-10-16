import { describe, expect, test } from 'vitest';
import { validateDataModel } from '@vaubaan/plugin-sdk';

import { context7DataModel } from '../../src/index.ts';

describe('context7DataModel — referential integrity', () => {
  test('every entity.parent references an existing entity in the same plane', () => {
    expect(validateDataModel(context7DataModel)).toEqual([]);
  });

  test('one plane, the index and its libraries, nothing environment-scoped', () => {
    expect(context7DataModel.planes.map((plane) => plane.slug)).toEqual(['docs']);
    const [docs] = context7DataModel.planes;
    expect(docs!.entities.map((e) => [e.name, e.parent])).toEqual([
      ['index', null],
      ['library', 'index'],
    ]);
    expect(docs!.entities.some((e) => e.envScopable)).toBe(false);
  });
});
