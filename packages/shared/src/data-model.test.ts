import { describe, expect, test } from 'vitest';

import { validateDataModel, type DataModel } from './data-model.ts';

const model: DataModel = {
  service: 'acme',
  planes: [
    {
      slug: 'space',
      entities: [
        { name: 'space', parent: null, cardinalities: ['one'], description: 'A space.' },
        { name: 'thing', parent: 'space', cardinalities: ['unbounded'], description: 'A thing.' },
      ],
    },
    {
      slug: 'account',
      entities: [{ name: 'member', parent: null, cardinalities: ['bounded'], description: 'x' }],
    },
  ],
};

describe('validateDataModel', () => {
  test('a consistent model has no error', () => {
    expect(validateDataModel(model)).toEqual([]);
    expect(validateDataModel({ service: 'acme', planes: [] })).toEqual([]);
  });

  test('an orphan parent is reported with service, plane and entity', () => {
    const orphan: DataModel = {
      ...model,
      planes: [
        {
          slug: 'space',
          entities: [
            { name: 'thing', parent: 'ghost', cardinalities: ['one'], description: 'A thing.' },
          ],
        },
      ],
    };
    expect(validateDataModel(orphan)).toEqual([
      "service 'acme' plane 'space': entity 'thing' has parent 'ghost' which is not declared in this plane.",
    ]);
  });

  test('a parent declared in another plane does not count', () => {
    const crossPlane: DataModel = {
      ...model,
      planes: [
        model.planes[0]!,
        {
          slug: 'account',
          entities: [{ name: 'member', parent: 'space', cardinalities: ['one'], description: 'x' }],
        },
      ],
    };
    expect(validateDataModel(crossPlane)).toHaveLength(1);
    expect(validateDataModel(crossPlane)[0]).toContain("plane 'account'");
  });

  test('every orphan is listed', () => {
    const two: DataModel = {
      service: 'acme',
      planes: [
        {
          slug: 'p',
          entities: [
            { name: 'a', parent: 'x', cardinalities: ['one'], description: 'a' },
            { name: 'b', parent: 'y', cardinalities: ['one'], description: 'b' },
          ],
        },
      ],
    };
    expect(validateDataModel(two)).toHaveLength(2);
  });
});
