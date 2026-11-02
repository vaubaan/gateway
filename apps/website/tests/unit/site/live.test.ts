/**
 * What the site renders at request time (`src/site/live.ts`): the plugin
 * pages, their twins, plugins.json and llms-full.txt carry the collector's
 * figures — gateways, calls and success rate per minor on the list, per
 * version on the plugin page, whatever their number — and every route that
 * renders them is cached for the same hour.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { buildSite, type BuiltSite } from '../../../src/content/build-site';
import type { HealthSnapshot } from '../../../src/content/health';
import { loadPlugins } from '../../../src/content/plugins';
import { readRepoFile, REPO_ROOT, WEBSITE_ROOT } from '../../../src/content/repo';
import { parseThresholds, THRESHOLDS_SOURCE } from '../../../src/content/thresholds';
import {
  HEALTH_REVALIDATE_SECONDS,
  liveLlmsFull,
  livePluginsJson,
  liveSiteFrom,
  pageMarkdown,
} from '../../../src/site/live';

let site: BuiltSite;

beforeAll(async () => {
  site = buildSite({
    repoRoot: REPO_ROOT,
    plugins: await loadPlugins(REPO_ROOT),
    thresholds: parseThresholds(readRepoFile(THRESHOLDS_SOURCE)),
    lastModified: () => null,
  });
}, 60_000);

/** A collector that knows two minors of GitHub: the shipped one and an older one. */
function snapshotOf(githubVersion: string): HealthSnapshot {
  const [major, minor] = githubVersion.split('.');
  const shipped = `${major}.${minor}`;
  return {
    fetchedAt: '2026-11-01T15:00:00.000Z',
    stats: {
      rows: [
        {
          plugin: 'github',
          plugin_version: githubVersion,
          reports: 130,
          successes: 128,
          credential_rejections: 0,
          success_rate: 0.9846,
          validated: false,
        },
        {
          plugin: 'github',
          plugin_version: '0.9.1',
          reports: 73,
          successes: 60,
          credential_rejections: 13,
          success_rate: 1,
          validated: false,
        },
      ],
      problem: null,
    },
    instances: {
      rows: [
        { plugin: 'github', plugin_version: githubVersion, plugin_minor: null, instances: 4 },
        { plugin: 'github', plugin_version: '0.9.1', plugin_minor: null, instances: 2 },
        { plugin: 'github', plugin_version: null, plugin_minor: shipped, instances: 4 },
        { plugin: 'github', plugin_version: null, plugin_minor: '0.9', instances: 2 },
        { plugin: 'github', plugin_version: null, plugin_minor: null, instances: 5 },
      ],
      problem: null,
    },
  };
}

function plugin(id: string) {
  const found = site.data.plugins.find((p) => p.id === id);
  if (!found) throw new Error(`no plugin ${id}`);
  return found;
}

const minorOf = (version: string): string => version.split('.').slice(0, 2).join('.');

describe('the plugin pages rendered with the collector read', () => {
  it('list two minors per plugin with gateways, calls and success, and "no call yet" for a minor without any', () => {
    const github = plugin('github');
    const live = liveSiteFrom(site.data, snapshotOf(github.version));
    const list = pageMarkdown('/plugins', live, site.data) ?? '';
    expect(list).toContain('| Plugin | Version | Gateways | Calls | Success |');
    expect(list).not.toContain('Permissions');
    expect(list).toContain(
      `| [${github.name}](/plugins/github) | \`${minorOf(github.version)}\` (this release) | 4 | 130 | 98.5 % |`,
    );
    expect(list).toContain(`| [${github.name}](/plugins/github) | \`0.9\` | 2 | 73 | 100.0 % |`);
    const fly = plugin('fly');
    expect(list).toContain(
      `| [${fly.name}](/plugins/fly) | \`${minorOf(fly.version)}\` (this release) | 0 | no call yet | — |`,
    );
    expect(list).toContain('so they are a lower bound');
    expect(list).toContain('leaves out calls refused for a rejected credential');
    expect(list).not.toMatch(/needed|no rate yet/);
  });

  it('give each plugin its gateways and its last versions, newest first', () => {
    const github = plugin('github');
    const live = liveSiteFrom(site.data, snapshotOf(github.version));
    const page = pageMarkdown('/plugins/github', live, site.data) ?? '';
    expect(page).toContain('5 gateways run this plugin (over the last 90 days).');
    expect(page).toContain('| Version | Gateways | Calls | Success | Validated |');
    const shipped = page.indexOf(`| \`${github.version}\` | 4 | 130 | 98.5 % |  |`);
    const older = page.indexOf('| `0.9.1` | 2 | 73 | 100.0 % |  |');
    expect(shipped).toBeGreaterThan(-1);
    expect(older).toBeGreaterThan(shipped);
    expect(page).not.toMatch(/Health of this version|All versions/);
  });

  it('say "not read" for the figures of the aggregate that did not answer only', () => {
    const github = plugin('github');
    const snapshot = snapshotOf(github.version);
    const live = liveSiteFrom(site.data, {
      ...snapshot,
      instances: { rows: null, problem: 'HTTP 503' },
    });
    const list = pageMarkdown('/plugins', live, site.data) ?? '';
    expect(list).toContain(
      `| [${github.name}](/plugins/github) | \`${minorOf(github.version)}\` (this release) | not read | 130 | 98.5 % |`,
    );
  });

  it('explain the figures on the health page and name the time the collector was read', () => {
    const live = liveSiteFrom(site.data, snapshotOf('0.0.1'));
    const page = pageMarkdown('/plugins/health', live, site.data) ?? '';
    expect(page).toContain('read from the collector at 2026-11-01 15:00 UTC');
    expect(page).toContain('**Validated**');
    expect(page).toContain('"not read"');
    expect(page).toContain('so they are a lower bound');
  });

  it('carry the same figures in plugins.json and llms-full.txt', () => {
    const github = plugin('github');
    const live = liveSiteFrom(site.data, snapshotOf(github.version));
    const json = JSON.parse(livePluginsJson(live)) as {
      health_read_at: string;
      health_read: Record<string, boolean>;
      plugins: { id: string; health: Record<string, unknown> }[];
    };
    expect(json.health_read_at).toBe('2026-11-01T15:00:00.000Z');
    expect(json.health_read).toEqual({ calls: true, gateways: true });
    expect(json.plugins.find((p) => p.id === 'github')?.health).toEqual({
      gateways: 5,
      minors: [
        { minor: minorOf(github.version), gateways: 4, calls: 130, success_rate: 0.9846 },
        { minor: '0.9', gateways: 2, calls: 73, success_rate: 1 },
      ],
      versions: [
        {
          version: github.version,
          gateways: 4,
          calls: 130,
          success_rate: 0.9846,
          validated: false,
        },
        { version: '0.9.1', gateways: 2, calls: 73, success_rate: 1, validated: false },
      ],
    });
    expect(json.plugins.find((p) => p.id === 'fly')?.health).toEqual({
      gateways: 0,
      minors: [
        { minor: minorOf(plugin('fly').version), gateways: 0, calls: 0, success_rate: null },
      ],
      versions: [],
    });
    expect(liveLlmsFull(live, site.data)).toContain(
      pageMarkdown('/plugins/github', live, site.data),
    );
  });

  it('render a docs page from the generated Markdown and nothing for an unknown path', () => {
    const live = liveSiteFrom(site.data, snapshotOf('0.0.1'));
    expect(pageMarkdown('/docs', live, site.data)).toBe(site.data.markdown['/docs']);
    expect(pageMarkdown('/plugins/no-such-plugin', live, site.data)).toBeNull();
    expect(pageMarkdown('/nowhere', live, site.data)).toBeNull();
  });
});

describe('the routes that read the collector', () => {
  function routeFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return routeFiles(path);
      return /^(page|route)\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it('are all cached for HEALTH_REVALIDATE_SECONDS, written as the one literal Next.js accepts', () => {
    const reading = routeFiles(join(WEBSITE_ROOT, 'src/app')).filter((file) =>
      readFileSync(file, 'utf8').includes("from '@/site/live'"),
    );
    expect(reading.length).toBeGreaterThanOrEqual(6);
    for (const file of reading) {
      expect(readFileSync(file, 'utf8'), file).toContain(
        `export const revalidate = ${HEALTH_REVALIDATE_SECONDS};`,
      );
    }
  });
});
