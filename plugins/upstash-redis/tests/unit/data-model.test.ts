import { describe, expect, test } from 'vitest';
import { validateDataModel } from '@vaubaan/shared';

import { upstashRedisDataModel } from '../../src/index.ts';

describe('upstashRedisDataModel — referential integrity', () => {
  test('every entity.parent references an existing entity in the same plane', () => {
    expect(validateDataModel(upstashRedisDataModel)).toEqual([]);
  });
});
