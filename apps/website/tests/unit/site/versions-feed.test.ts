/**
 * `/versions.json`: the feed built from the committed data files is one the gateway
 * reads, and a malformed file fails the build instead of publishing a feed every
 * instance would ignore.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isVersionsFeed } from '@vaubaan/shared/versions-feed';
import { describe, expect, it } from 'vitest';

import { WEBSITE_ROOT } from '../../../src/content/repo';
import { buildVersionsFeed } from '../../../src/content/versions-feed';

const AT = new Date('2026-11-05T12:00:00.000Z');
const RELEASES = {
  gateway: '2.0.0-alpha.16',
  prerelease: true,
  date: '2026-11-04',
  plugins: { github: '5.0.0', vercel: '4.1.0' },
};
const ADVISORY = {
  id: 'VBN-2026-001',
  subject: 'plugin:github',
  affected: '<5.0.1',
  fixed: '5.0.1',
  summary: 'A push to a protected branch was classified as an ordinary push.',
  url: 'https://github.com/vaubaan/gateway/security/advisories/GHSA-0000-0000-0000',
  date: '2026-11-04',
};

const readContent = (name: string): unknown =>
  JSON.parse(readFileSync(join(WEBSITE_ROOT, 'src/content', name), 'utf8'));

describe('the versions feed', () => {
  it('says the released gateway, each plugin, the advisories, and when it was built', () => {
    const feed = buildVersionsFeed(RELEASES, [ADVISORY], AT);
    expect(feed).toEqual({
      schema: 1,
      generated_at: '2026-11-05T12:00:00.000Z',
      gateway: { latest: '2.0.0-alpha.16', prerelease: true },
      plugins: { github: { latest: '5.0.0' }, vercel: { latest: '4.1.0' } },
      advisories: [ADVISORY],
    });
    expect(isVersionsFeed(feed)).toBe(true);
  });

  it('is built from the committed data files', () => {
    const feed = buildVersionsFeed(
      readContent('releases.json'),
      readContent('advisories.json'),
      AT,
    );
    expect(isVersionsFeed(feed)).toBe(true);
  });

  it('refuses a malformed file rather than publish a feed no instance reads', () => {
    expect(() => buildVersionsFeed({ gateway: '2.0.0' }, [], AT)).toThrow(/releases\.json/);
    expect(() => buildVersionsFeed({ ...RELEASES, gateway: 'latest' }, [], AT)).toThrow(
      /isVersionsFeed/,
    );
    expect(() =>
      buildVersionsFeed(RELEASES, [{ ...ADVISORY, url: 'http://example.com' }], AT),
    ).toThrow(/isVersionsFeed/);
  });
});
