/**
 * Validate `supabaseDataModel` — every entity's `parent` references an
 * entity that exists in the same plane.
 *
 * The catalog's mermaid renderer drops orphan parents silently ; without
 * this gate a typo in `parent: 'tabel'` would never surface until a human
 * eyeballs the rendered diagram.
 */
import { describe, expect, test } from 'vitest';
import { validateDataModel } from '@vaubaan/plugin-sdk';

import { supabaseDataModel } from '../../src/data-model.ts';

describe('supabaseDataModel — referential integrity', () => {
  test('every entity.parent references an existing entity in the same plane', () => {
    const errors = validateDataModel(supabaseDataModel);
    expect(errors).toEqual([]);
  });
});
