import { describe, it, expect } from 'vitest';

import * as core from '../../src/index.js';

describe('@crm/core', () => {
  it('is an empty module placeholder in v1 init', () => {
    expect(Object.keys(core)).toHaveLength(0);
  });
});
