import { describe, expect, it } from 'vitest';

import { safeReturnTo } from './handlers';

describe('safeReturnTo', () => {
  it('keeps same-origin absolute paths', () => {
    expect(safeReturnTo('/admin')).toBe('/admin');
    expect(safeReturnTo('/admin/identity-provider?test=1')).toBe('/admin/identity-provider?test=1');
  });
  it('falls back for URLs, protocol-relative paths and junk', () => {
    expect(safeReturnTo('https://evil.example.net/')).toBe('/login');
    expect(safeReturnTo('//evil.example.net/')).toBe('/login');
    expect(safeReturnTo('/\\evil.example.net')).toBe('/login');
    expect(safeReturnTo('admin')).toBe('/login');
    expect(safeReturnTo(null, '/x')).toBe('/x');
  });
});
