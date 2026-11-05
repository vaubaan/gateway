/**
 * Structural test: the data of the published versions feed (ADR
 * plugins-bundled-or-pinned-by-the-operator) — `releases.json`, written by
 * `release:prepare`, and `advisories.json`, written by hand in a fix's pull request
 * (docs/handbook/website.md) — make a feed the gateway reads (`isVersionsFeed`).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isVersionsFeed, isVersionsFeedAdvisory } from '@vaubaan/shared';
import { describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const CONTENT = resolve(REPO, 'apps/website/src/content');

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(resolve(CONTENT, name), 'utf8'));
}

interface Releases {
  readonly gateway: string;
  readonly prerelease: boolean;
  readonly date: string;
  readonly plugins: Record<string, string>;
}

describe('the data of the versions feed', () => {
  const releases = readJson('releases.json') as Releases;
  const advisories = readJson('advisories.json');

  it('lists advisories of the feed shape, each id once', () => {
    expect(Array.isArray(advisories)).toBe(true);
    const list = advisories as unknown[];
    for (const advisory of list)
      expect(isVersionsFeedAdvisory(advisory), JSON.stringify(advisory)).toBe(true);
    const ids = list.map((a) => (a as { id: string }).id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('makes, with the released versions, a feed the gateway reads', () => {
    const feed = {
      schema: 1,
      generated_at: `${releases.date}T00:00:00Z`,
      gateway: { latest: releases.gateway, prerelease: releases.prerelease },
      plugins: Object.fromEntries(
        Object.entries(releases.plugins).map(([id, latest]) => [id, { latest }]),
      ),
      advisories,
    };
    expect(isVersionsFeed(feed)).toBe(true);
    expect(releases.plugins).not.toHaveProperty('_template');
  });
});
