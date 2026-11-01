/**
 * What the site renders at request time (`src/site/live.ts`): the plugin
 * pages, their twins, plugins.json and llms-full.txt carry the collector's
 * figures — the count and the minimum below the threshold, the history over
 * every version, the rate from the threshold on — and every route that
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

/** The collector as it stood on 2026-11-01: every report on versions older than the shipped ones. */
function snapshotOf(githubVersion: string, githubReports: number): HealthSnapshot {
  return {
    fetchedAt: '2026-11-01T15:00:00.000Z',
    rows: [
      {
        plugin: 'github',
        plugin_version: githubVersion,
        reports: githubReports,
        success_rate: 0.9846,
        validated: githubReports >= 200,
      },
      { plugin: 'github', plugin_version: '4.0.1', reports: 73, success_rate: 1, validated: false },
      { plugin: 'vercel', plugin_version: '3.0.2', reports: 15, success_rate: 1, validated: false },
    ],
    problem: null,
  };
}

describe('the plugin pages rendered with the collector read', () => {
  it('show the count and the minimum for a version below the threshold, and the history beside', () => {
    const github = site.data.plugins.find((p) => p.id === 'github');
    expect(github).toBeDefined();
    const live = liveSiteFrom(site.data, snapshotOf(github?.version ?? '', 130));
    const page = pageMarkdown('/plugins/github', live, site.data) ?? '';
    expect(page).toContain('Health of this version: 130 reports of the 200 needed, no rate yet');
    expect(page).toContain('All versions: 203 reports over 2 versions');
    expect(page).not.toMatch(/% of 130 calls/);

    const list = pageMarkdown('/plugins', live, site.data) ?? '';
    expect(list).toContain(
      '| 130 reports of the 200 needed, no rate yet | 203 reports over 2 versions |',
    );
    const fly = site.data.plugins.find((p) => p.id === 'fly');
    expect(list).toContain(
      `| [${fly?.name}](/plugins/fly) | \`${fly?.version}\` | ${fly?.risks.length} | no report yet (200 needed) | no report for any version |`,
    );
  });

  it('show the rate and the verdict from the threshold on, for the exact version only', () => {
    const github = site.data.plugins.find((p) => p.id === 'github');
    const live = liveSiteFrom(site.data, snapshotOf(github?.version ?? '', 250));
    const page = pageMarkdown('/plugins/github', live, site.data) ?? '';
    expect(page).toContain('validated by the community (98.5 % of 250 calls worked)');
    expect(page).toContain('All versions: 323 reports over 2 versions');
  });

  it('name the time the collector was read on the health page', () => {
    const live = liveSiteFrom(site.data, snapshotOf('0.0.1', 1));
    expect(pageMarkdown('/plugins/health', live, site.data)).toContain(
      'read from the collector at 2026-11-01 15:00 UTC',
    );
  });

  it('carry the same figures in plugins.json and llms-full.txt', () => {
    const github = site.data.plugins.find((p) => p.id === 'github');
    const live = liveSiteFrom(site.data, snapshotOf(github?.version ?? '', 130));
    const json = JSON.parse(livePluginsJson(live)) as {
      health_read_at: string;
      plugins: { id: string; health: Record<string, unknown> }[];
    };
    expect(json.health_read_at).toBe('2026-11-01T15:00:00.000Z');
    expect(json.plugins.find((p) => p.id === 'github')?.health).toEqual({
      state: 'below-threshold',
      reports: 130,
      all_versions: { reports: 203, versions: 2 },
    });
    expect(json.plugins.find((p) => p.id === 'fly')?.health).toEqual({
      state: 'below-threshold',
      reports: 0,
      all_versions: { reports: 0, versions: 0 },
    });
    expect(liveLlmsFull(live, site.data)).toContain(
      pageMarkdown('/plugins/github', live, site.data),
    );
  });

  it('render a docs page from the generated Markdown and nothing for an unknown path', () => {
    const live = liveSiteFrom(site.data, snapshotOf('0.0.1', 1));
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
