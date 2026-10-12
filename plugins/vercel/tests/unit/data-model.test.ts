import { describe, expect, test } from 'vitest';
import { validateDataModel } from '@vaubaan/shared';

import { vercelDataModel } from '../../src/index.ts';

describe('vercelDataModel — referential integrity', () => {
  test('every entity.parent references an existing entity in the same plane', () => {
    expect(validateDataModel(vercelDataModel)).toEqual([]);
  });
});
