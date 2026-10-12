import { describe, expect, test } from 'vitest';
import { validateDataModel } from '@vaubaan/shared';

import { githubDataModel } from '../../src/data-model.ts';

describe('githubDataModel — referential integrity', () => {
  test('every entity.parent references an existing entity in the same plane', () => {
    expect(validateDataModel(githubDataModel)).toEqual([]);
  });
});
