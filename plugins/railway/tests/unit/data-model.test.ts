import { describe, expect, test } from 'vitest';
import { validateDataModel } from '@vaubaan/shared';

import { railwayDataModel } from '../../src/data-model.ts';

describe('railwayDataModel — referential integrity', () => {
  test('every entity.parent references an existing entity in the same plane', () => {
    expect(validateDataModel(railwayDataModel)).toEqual([]);
  });
});
