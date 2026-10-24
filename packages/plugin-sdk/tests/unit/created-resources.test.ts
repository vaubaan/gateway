import { describe, expect, test } from 'vitest';

import {
  CREATED_ANSWER_MAX_LENGTH,
  jsonObjectsOf,
  jsonValuesOf,
} from '../../src/created-resources.ts';

describe('jsonValuesOf / jsonObjectsOf (ADR created-resources-join-the-mission)', () => {
  test('structured content first, then every text block that is JSON', () => {
    const values = jsonValuesOf({
      structuredContent: { id: 's' },
      content: [
        { type: 'text', text: '{"id":"a"}' },
        { type: 'text', text: 'not json' },
        { type: 'text', text: '[1,2]' },
      ],
    });
    expect(values).toEqual([{ id: 's' }, { id: 'a' }, [1, 2]]);
  });

  test('objects only, arrays and scalars left out; never throws', () => {
    expect(
      jsonObjectsOf({
        content: [
          { type: 'text', text: '"x"' },
          { type: 'text', text: '[{"id":"in-a-list"}]' },
          { type: 'text', text: '{"id":"b"}' },
        ],
      }),
    ).toEqual([{ id: 'b' }]);
    expect(jsonObjectsOf({ content: [] })).toEqual([]);
  });

  test('a text block past the bound is not parsed', () => {
    const big = `{"pad":"${'x'.repeat(CREATED_ANSWER_MAX_LENGTH)}"}`;
    expect(jsonValuesOf({ content: [{ type: 'text', text: big }] })).toEqual([]);
  });
});
