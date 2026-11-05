import { describe, expect, it } from 'vitest';

import { isSemverVersion, isVersionsFeed, VERSIONS_FEED_LIMITS } from './versions-feed.ts';

const FEED = {
  schema: 1,
  generated_at: '2026-11-05T10:00:00Z',
  gateway: { latest: '2.0.0-alpha.16', prerelease: true },
  plugins: { github: { latest: '5.0.0' }, 'cloudflare-dns': { latest: '4.0.0' } },
  advisories: [
    {
      id: 'VBN-2026-001',
      subject: 'plugin:github',
      affected: '>=4.0.0 <5.0.0',
      fixed: '5.0.0',
      summary: 'A push to a protected branch was classified as a plain push.',
      url: 'https://vaubaan.com/advisories/VBN-2026-001',
      date: '2026-11-01',
    },
  ],
};

describe('isVersionsFeed', () => {
  it('accepts the published shape, unknown extra fields included', () => {
    expect(isVersionsFeed(FEED)).toBe(true);
    expect(isVersionsFeed({ ...FEED, extra: { later: true } })).toBe(true);
    expect(isVersionsFeed({ ...FEED, advisories: [] })).toBe(true);
  });

  it('refuses another schema or a missing part', () => {
    expect(isVersionsFeed({ ...FEED, schema: 2 })).toBe(false);
    expect(isVersionsFeed({ ...FEED, generated_at: 'yesterday' })).toBe(false);
    expect(isVersionsFeed({ ...FEED, gateway: { latest: '2.0', prerelease: false } })).toBe(false);
    expect(isVersionsFeed({ ...FEED, gateway: { latest: '2.0.0' } })).toBe(false);
    expect(isVersionsFeed({ ...FEED, plugins: [] })).toBe(false);
    expect(isVersionsFeed({ ...FEED, plugins: { GitHub: { latest: '1.0.0' } } })).toBe(false);
    expect(isVersionsFeed(null)).toBe(false);
    expect(isVersionsFeed('{}')).toBe(false);
  });

  it('refuses a feed with one malformed advisory: a link that is not https, an unknown subject', () => {
    const advisory = FEED.advisories[0]!;
    const withAdvisory = (patch: Record<string, unknown>) => ({
      ...FEED,
      advisories: [{ ...advisory, ...patch }],
    });
    expect(isVersionsFeed(withAdvisory({ url: 'javascript:alert(1)' }))).toBe(false);
    expect(isVersionsFeed(withAdvisory({ url: 'http://vaubaan.com/a' }))).toBe(false);
    expect(isVersionsFeed(withAdvisory({ subject: 'plugin:' }))).toBe(false);
    expect(isVersionsFeed(withAdvisory({ subject: 'broker' }))).toBe(false);
    expect(isVersionsFeed(withAdvisory({ fixed: 'soon' }))).toBe(false);
    expect(isVersionsFeed(withAdvisory({ date: '1 Nov 2026' }))).toBe(false);
    expect(
      isVersionsFeed(withAdvisory({ summary: 'x'.repeat(VERSIONS_FEED_LIMITS.text + 1) })),
    ).toBe(false);
  });

  it('refuses a feed past its bounds', () => {
    const plugins = Object.fromEntries(
      Array.from({ length: VERSIONS_FEED_LIMITS.plugins + 1 }, (_, i) => [
        `p${i}`,
        { latest: '1.0.0' },
      ]),
    );
    expect(isVersionsFeed({ ...FEED, plugins })).toBe(false);
  });
});

describe('isSemverVersion', () => {
  it('reads semver versions, prerelease and build included', () => {
    for (const v of ['0.0.1', '2.0.0-alpha.16', '1.2.3+build.5', '10.20.30-rc.1+x']) {
      expect(isSemverVersion(v)).toBe(true);
    }
    for (const v of ['1.2', 'v1.2.3', '01.2.3', '1.2.3-', '', 'dev']) {
      expect(isSemverVersion(v)).toBe(false);
    }
  });
});
