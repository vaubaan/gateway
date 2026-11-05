import type { VersionsFeed } from '@vaubaan/shared';
import { describe, expect, it } from 'vitest';

import type { PluginInventoryEntry } from '../plugins';
import { compare } from './compare';

function entry(
  id: string,
  version: string,
  more: Partial<PluginInventoryEntry> = {},
): PluginInventoryEntry {
  return {
    id,
    name: id,
    version,
    origin: 'bundled',
    replaces: null,
    enabled: true,
    path: null,
    ...more,
  };
}

const FEED: VersionsFeed = {
  schema: 1,
  generated_at: '2026-11-05T10:00:00Z',
  gateway: { latest: '2.0.0-alpha.17', prerelease: true },
  plugins: { github: { latest: '5.1.0' }, notion: { latest: '0.2.0' }, miro: { latest: '0.5.0' } },
  advisories: [
    {
      id: 'VBN-2026-001',
      subject: 'plugin:github',
      affected: '>=5.0.0 <5.1.0',
      fixed: '5.1.0',
      summary: 'A force push was classified as a plain push.',
      url: 'https://vaubaan.com/advisories/VBN-2026-001',
      date: '2026-11-04',
    },
    {
      id: 'VBN-2026-002',
      subject: 'gateway',
      affected: '<2.0.0-alpha.17',
      fixed: '2.0.0-alpha.17',
      summary: 'A mission edit kept a removed resource.',
      url: 'https://vaubaan.com/advisories/VBN-2026-002',
      date: '2026-11-05',
    },
    {
      id: 'VBN-2026-003',
      subject: 'plugin:notion',
      affected: 'not a range',
      fixed: '0.2.1',
      summary: 'Unreadable range: ignored.',
      url: 'https://vaubaan.com/advisories/VBN-2026-003',
      date: '2026-11-05',
    },
  ],
};

describe('compare', () => {
  const inventory = [
    entry('github', '5.0.0'),
    entry('notion', '0.1.0', { origin: 'pinned', replaces: '0.2.0', path: '/plugins/notion' }),
    entry('miro', '0.6.0', { origin: 'pinned', replaces: '0.5.0', path: '/plugins/miro' }),
    entry('acme', '1.0.0', { enabled: false }),
  ];

  it('says the gateway is behind a newer prerelease', () => {
    const result = compare(FEED, { gatewayVersion: '2.0.0-alpha.16', inventory });
    expect(result.gateway).toEqual({
      current: '2.0.0-alpha.16',
      latest: '2.0.0-alpha.17',
      latestIsPrerelease: true,
      behind: true,
    });
    expect(result.feedGeneratedAt).toBe('2026-11-05T10:00:00Z');
  });

  it('never calls a development build behind', () => {
    expect(compare(FEED, { gatewayVersion: 'dev', inventory }).gateway.behind).toBe(false);
    expect(compare(FEED, { gatewayVersion: '2.0.0', inventory }).gateway.behind).toBe(false);
  });

  it('lists the plugins older than their release, a pin ahead of it left out', () => {
    const result = compare(FEED, { gatewayVersion: '2.0.0-alpha.17', inventory });
    expect(result.pluginsBehind).toEqual([
      { id: 'github', loaded: '5.0.0', released: '5.1.0' },
      { id: 'notion', loaded: '0.1.0', released: '0.2.0' },
    ]);
  });

  it('lists the pins older than the bundled version they replace', () => {
    const result = compare(FEED, { gatewayVersion: '2.0.0-alpha.17', inventory });
    expect(result.olderPins).toEqual([
      { id: 'notion', pinned: '0.1.0', bundled: '0.2.0', path: '/plugins/notion' },
    ]);
  });

  it('names the advisories whose range holds the loaded version, with the fix', () => {
    const result = compare(FEED, { gatewayVersion: '2.0.0-alpha.16', inventory });
    expect(result.advisories.map((a) => [a.id, a.subject, a.loaded, a.fixed])).toEqual([
      ['VBN-2026-001', { plugin: 'github' }, '5.0.0', '5.1.0'],
      ['VBN-2026-002', 'gateway', '2.0.0-alpha.16', '2.0.0-alpha.17'],
    ]);
    const fixed = compare(FEED, {
      gatewayVersion: '2.0.0-alpha.17',
      inventory: [entry('github', '5.1.0')],
    });
    expect(fixed.advisories).toEqual([]);
  });
});
