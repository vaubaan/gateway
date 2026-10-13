import { describe, expect, it } from 'vitest';

import { shapeOfPattern } from './shape';

describe('shapeOfPattern', () => {
  it('says a literal prefix', () => {
    expect(shapeOfPattern('^re_[A-Za-z0-9_-]+$')).toBe('starts with re_');
  });

  it('says a choice of prefixes, each written whole', () => {
    expect(shapeOfPattern('^(sk|rk)_test_[A-Za-z0-9]+$')).toBe('starts with sk_test_ or rk_test_');
    expect(shapeOfPattern('^(a|b|c)-[a-z]+$')).toBe('starts with a-, b- or c-');
  });

  it('says a minimum, an exact or a bounded length', () => {
    expect(shapeOfPattern('^[A-Za-z0-9_-]{20,}$')).toBe('20 characters or more');
    expect(shapeOfPattern('^[a-f0-9]{64}$')).toBe('64 characters');
    expect(shapeOfPattern('^[a-z]{3,8}$')).toBe('3 to 8 characters');
    expect(shapeOfPattern('^rk_[A-Za-z0-9]{32,}$')).toBe('starts with rk_, 32 characters or more');
  });

  it('says digits only', () => {
    expect(shapeOfPattern('^[0-9]+$')).toBe('digits only');
  });

  it('says nothing of a pattern it cannot read whole, or that states no shape', () => {
    expect(shapeOfPattern(undefined)).toBeNull();
    expect(shapeOfPattern('')).toBeNull();
    expect(shapeOfPattern('[a-z]+')).toBeNull();
    expect(shapeOfPattern('^[A-Za-z0-9._-]+$')).toBeNull();
    expect(shapeOfPattern('^[a-zA-Z0-9][a-zA-Z0-9._-]*$')).toBeNull();
    expect(shapeOfPattern('^team_[a-z]+(\\.[a-z]+)?$')).toBeNull();
    expect(shapeOfPattern('^(?=.{1,253}$)[a-z.]+$')).toBeNull();
  });
});
