import { describe, expect, it } from 'vitest';

import { PATH_IDENT, pathIdent, queryString } from '../../src/index.ts';

describe('pathIdent', () => {
  it('keeps an identifier a path segment carries as it is, refuses anything else', () => {
    expect(pathIdent('proj_12-ab')).toBe('proj_12-ab');
    expect(pathIdent('a'.repeat(64))).toBe('a'.repeat(64));
    for (const bad of ['', 'a'.repeat(65), 'a/b', '..', 'a?b', 'a b', 'é', 3, null]) {
      expect(pathIdent(bad)).toBeNull();
    }
    expect(PATH_IDENT.test('x')).toBe(true);
  });
});

describe('queryString', () => {
  it('encodes every name and value, a space as %20, and skips null and undefined', () => {
    expect(queryString({ q: 'a b&c', page: 2, gone: undefined, none: null, f: false })).toBe(
      '?q=a%20b%26c&page=2&f=false',
    );
    expect(queryString({})).toBe('');
    expect(queryString({ a: undefined })).toBe('');
  });
});
