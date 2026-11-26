import { describe, expect, it } from 'vitest';

import { catalogMarkOf, isCatalogIndex } from './catalog-index.ts';

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

describe('the mark of a catalog plugin, before it is installed', () => {
  const ICON = 'M12 0C5.37 0 0 5.37 0 12s5.37 12 12 12 12-5.37 12-12S18.63 0 12 0z';

  it('reads the icon and colour an entry carries, and an index with them stays an index', () => {
    const entry = {
      name: 'Vercel',
      version: '4.2.1',
      sha256: SHA,
      icon: ICON,
      iconColor: '#000000',
    };
    expect(isCatalogIndex(index({ vercel: entry }))).toBe(true);
    expect(catalogMarkOf(entry)).toEqual({ path: ICON, color: '#000000' });
  });

  it('draws no mark for an entry without an icon: the lettered fallback stays', () => {
    expect(catalogMarkOf({ iconColor: '#000000' })).toBeNull();
    expect(catalogMarkOf({})).toBeNull();
  });

  it('drops a malformed icon, never the entry', () => {
    const entry = { name: 'Vercel', version: '4.2.1', sha256: SHA, icon: '<script>' };
    expect(isCatalogIndex(index({ vercel: entry }))).toBe(true);
    expect(catalogMarkOf(entry)).toBeNull();
    expect(catalogMarkOf({ icon: `M${'0'.repeat(8192)}` })).toBeNull();
  });

  it('drops a colour that is not #RRGGBB, keeping the icon in the ink', () => {
    expect(catalogMarkOf({ icon: ICON, iconColor: 'red;}' })).toEqual({ path: ICON, color: null });
  });
});
