import { describe, expect, it } from 'vitest';

import { safeReturnTo } from './handlers';

const PUBLIC_URL = new URL('https://gateway.example.com');

describe('safeReturnTo', () => {
  it('keeps same-origin absolute paths', () => {
    expect(safeReturnTo('/admin', PUBLIC_URL)).toBe('/admin');
    expect(safeReturnTo('/admin/identity-provider?test=1', PUBLIC_URL)).toBe(
      '/admin/identity-provider?test=1',
    );
  });

  it('falls back for URLs, protocol-relative paths and junk', () => {
    expect(safeReturnTo('https://evil.example.net/', PUBLIC_URL)).toBe('/login');
    expect(safeReturnTo('https://gateway.example.com/admin', PUBLIC_URL)).toBe('/login');
    expect(safeReturnTo('//evil.example.net/', PUBLIC_URL)).toBe('/login');
    expect(safeReturnTo('/\\evil.example.net', PUBLIC_URL)).toBe('/login');
    expect(safeReturnTo('admin', PUBLIC_URL)).toBe('/login');
    expect(safeReturnTo(null, PUBLIC_URL, '/x')).toBe('/x');
  });

  // A browser strips tab, LF and CR before parsing: "/\t/host" is "//host" to it.
  it.each([
    '/\t/evil.example.net/login',
    '/\n/evil.example.net/login',
    '/\r/evil.example.net/login',
    '/\t\\evil.example.net',
    '/\u0000/evil.example.net',
    '/.//a//evil.example.net/login',
    '/x/..//a//evil.example.net',
  ])('falls back for %j, which a browser resolves to another origin', (raw) => {
    expect(safeReturnTo(raw, PUBLIC_URL)).toBe('/login');
  });
});
