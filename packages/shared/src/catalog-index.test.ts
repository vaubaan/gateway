import { describe, expect, it } from 'vitest';

import { isCatalogIndex } from './catalog-index.ts';

const SHA = 'a03544c0fdf5b307329c687a397176fde9ccf437c68b1cfad8b1ac7087a90bed';
const index = (plugins: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  schema: 1,
  generated_at: '2026-11-19T17:00:00Z',
  plugins,
  ...extra,
});

describe('the catalog index an instance reads', () => {
  it('reads each plugin with its service name, version and archive sha256', () => {
    expect(
      isCatalogIndex(index({ vercel: { name: 'Vercel', version: '4.2.1', sha256: SHA } })),
    ).toBe(true);
    expect(isCatalogIndex(index({}, { later: 'field' }))).toBe(true);
  });

  it.each([
    ['another schema', { ...index({}), schema: 2 }],
    ['no date', { schema: 1, plugins: {} }],
    ['an id that is no slug', index({ Vercel: { name: 'Vercel', version: '4.2.1', sha256: SHA } })],
    ['no name', index({ vercel: { version: '4.2.1', sha256: SHA } })],
    ['a name too long', index({ vercel: { name: 'x'.repeat(81), version: '4.2.1', sha256: SHA } })],
    [
      'a version that is no semver',
      index({ vercel: { name: 'Vercel', version: 'latest', sha256: SHA } }),
    ],
    [
      'a sha256 in capitals',
      index({ vercel: { name: 'Vercel', version: '4.2.1', sha256: SHA.toUpperCase() } }),
    ],
    ['an array', []],
  ])('refuses %s', (_why, value) => {
    expect(isCatalogIndex(value)).toBe(false);
  });
});
