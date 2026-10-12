import { describe, expect, test } from 'vitest';
import { validateDataModel } from '@vaubaan/shared';

import { sshDataModel } from '../../src/data-model.ts';

describe('sshDataModel — referential integrity', () => {
  test('every entity.parent references an existing entity in the same plane', () => {
    expect(validateDataModel(sshDataModel)).toEqual([]);
  });
});
