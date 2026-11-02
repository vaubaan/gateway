/**
 * The small pieces: Markdown helpers, plugin health, host and Accept routing,
 * the hand-written docs rule, the trust center's reading of the threat model.
 */
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadHandwrittenDocs, proseLines } from '../../../src/content/docs';
import {
  callsWords,
  fetchHealth,
  gatewaysSentence,
  healthOf,
  type HealthSnapshot,
  NOT_READ,
  newestFirst,
  rateWords,
  type StatsRow,
  unreadSnapshot,
} from '../../../src/content/health';
import {
  escapeMdx,
  rewriteRelativeLinks,
  sectionsOf,
  splitFrontmatter,
  text,
} from '../../../src/content/markdown';
import { readRepoFile, REPO_ROOT } from '../../../src/content/repo';
import { parseAcceptedRisks, parseOutOfScope, THREAT_MODEL } from '../../../src/content/trust';
import {
  hostDecision,
  hostOf,
  markdownTwinOf,
  twinRouteOf,
  wantsMarkdown,
} from '../../../src/site/routing';

describe('Markdown helpers', () => {
  it('escape MDX outside code only', () => {
    const md = 'a <b> {c}\n\n`<x> {y}`\n\n```\n<z> {w}\n```\n<https://e.example/p>';
    expect(escapeMdx(md)).toBe(
      'a &lt;b> \\{c\\}\n\n`<x> {y}`\n\n```\n<z> {w}\n```\n[https://e.example/p](https://e.example/p)',
    );
  });

  it('point relative links and anchors at the file on GitHub, external links untouched', () => {
    const md = '[a](../decisions/x.md#d) [b](#tests) [c](https://x.example) `[d](e.md)`';
    expect(rewriteRelativeLinks(md, 'docs/handbook/known-limitations.md')).toBe(
      '[a](https://github.com/vaubaan/gateway/blob/main/docs/decisions/x.md#d) ' +
        '[b](https://github.com/vaubaan/gateway/blob/main/docs/handbook/known-limitations.md#tests) ' +
        '[c](https://x.example) `[d](e.md)`',
    );
  });

  it('cut sections at headings outside fenced code', () => {
    const md = '## A\none\n```\n## not a heading\n```\n## B\ntwo';
    expect(sectionsOf(md).map((s) => s.heading)).toEqual(['A', 'B']);
  });

  it('escape markup in plain text', () => {
    expect(text('release-* and feature/* [x] <y>')).toBe(
      'release-\\* and feature/\\* \\[x\\] \\<y\\>',
    );
  });

  it('read a frontmatter block', () => {
    expect(splitFrontmatter('---\ntitle: "A"\ntracks:\n  - x\n---\nbody\n')).toEqual({
      data: { title: 'A' },
      body: 'body\n',
    });
  });
});

describe('plugin health', () => {
  function stats(version: string, reports: number, successes: number, rejected = 0): StatsRow {
    const counted = reports - rejected;
    return {
      plugin: 'github',
      plugin_version: version,
      reports,
      successes,
      credential_rejections: rejected,
      success_rate: counted > 0 ? successes / counted : null,
      validated: reports >= 200 && counted > 0 && successes / counted >= 0.9,
    };
  }

  const snapshot: HealthSnapshot = {
    fetchedAt: '2026-11-02T10:00:00.000Z',
    stats: {
      rows: [
        stats('4.0.2', 120, 110, 10),
        stats('4.0.1', 300, 290),
        stats('3.2.0', 50, 40),
        stats('3.1.0', 10, 10),
        { ...stats('0.1.0', 5, 5), plugin: 'fly' },
      ],
      problem: null,
    },
    instances: {
      rows: [
        { plugin: 'github', plugin_version: '4.0.2', plugin_minor: null, instances: 3 },
        { plugin: 'github', plugin_version: '4.0.1', plugin_minor: null, instances: 4 },
        { plugin: 'github', plugin_version: '4.1.0', plugin_minor: null, instances: 1 },
        { plugin: 'github', plugin_version: null, plugin_minor: '4.0', instances: 5 },
        { plugin: 'github', plugin_version: null, plugin_minor: '4.1', instances: 1 },
        { plugin: 'github', plugin_version: null, plugin_minor: '3.2', instances: 2 },
        { plugin: 'github', plugin_version: null, plugin_minor: null, instances: 7 },
      ],
      problem: null,
    },
  };

  it('shows every version the collector knows, newest first, whatever its number of calls', () => {
    const health = healthOf(snapshot, 'github', '4.0.2');
    expect(health.versions.map((v) => v.label)).toEqual([
      '4.1.0',
      '4.0.2',
      '4.0.1',
      '3.2.0',
      '3.1.0',
    ]);
    expect(health.versions[1]).toEqual({
      label: '4.0.2',
      gateways: 3,
      calls: 120,
      successRate: 1,
      validated: false,
    });
    // Known by a profile only: gateways, no call yet.
    expect(health.versions[0]).toMatchObject({ gateways: 1, calls: 0, successRate: null });
    expect(health.versions[2]?.validated).toBe(true);
    expect(health.gateways).toBe(7);
  });

  it('adds the patch versions of a minor up, with its gateways counted once by the collector', () => {
    const health = healthOf(snapshot, 'github', '4.0.2');
    expect(health.minors).toEqual([
      // 400 successes of 420 calls, 10 rejected credentials left out.
      { label: '4.0', gateways: 5, calls: 420, successRate: 0.9756, validated: false },
      { label: '4.1', gateways: 1, calls: 0, successRate: null, validated: false },
    ]);
    expect(callsWords(health.minors[1]?.calls ?? 0)).toBe('no call yet');
    expect(rateWords(health.minors[0]?.successRate ?? null)).toBe('97.6 %');
    expect(rateWords(null)).toBe('—');
  });

  it('shows one row for a plugin with no other minor, and "no call yet" for one never reported', () => {
    const fly = healthOf(snapshot, 'fly', '0.1.0');
    expect(fly.minors.map((m) => m.label)).toEqual(['0.1']);
    const never = healthOf(snapshot, 'never-seen', '1.0.0');
    expect(never.minors).toEqual([
      { label: '1.0', gateways: 0, calls: 0, successRate: null, validated: false },
    ]);
    expect(never.versions).toEqual([]);
    expect(gatewaysSentence(never, 90)).toBe('0 gateways run this plugin (over the last 90 days).');
    expect(gatewaysSentence(healthOf(snapshot, 'github', '4.0.2'), 90)).toBe(
      '7 gateways run this plugin (over the last 90 days).',
    );
  });

  it('says "not read" for the figures of an aggregate that was not read, and only those', () => {
    const noInstances: HealthSnapshot = {
      ...snapshot,
      instances: { rows: null, problem: 'HTTP 503' },
    };
    const health = healthOf(noInstances, 'github', '4.0.2');
    expect(health.gateways).toBe(NOT_READ);
    expect(health.minors[0]).toMatchObject({ gateways: NOT_READ, calls: 420 });
    expect(gatewaysSentence(health, 90)).toContain('not read');

    const nothing = healthOf(unreadSnapshot('x'), 'github', '4.0.2');
    expect(nothing).toEqual({
      gateways: NOT_READ,
      minors: [
        {
          label: '4.0',
          gateways: NOT_READ,
          calls: NOT_READ,
          successRate: NOT_READ,
          validated: false,
        },
      ],
      versions: [],
    });
    expect(callsWords(NOT_READ)).toBe('not read');
  });

  it('orders versions and minors by semver, a pre-release below its release', () => {
    expect(['1.10.0', '1.2.0', '2.0.0-rc.1', '2.0.0', '1.2.0-beta'].sort(newestFirst)).toEqual([
      '2.0.0',
      '2.0.0-rc.1',
      '1.10.0',
      '1.2.0',
      '1.2.0-beta',
    ]);
    expect(['3.9', '3.10', '4.0'].sort(newestFirst)).toEqual(['4.0', '3.10', '3.9']);
  });

  it('reads both aggregates, each on its own, and never throws', async () => {
    const urls = { stats: 'https://c.example/stats', instances: 'https://c.example/instances' };
    const failing = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    const down = await fetchHealth(urls, failing);
    expect(down.fetchedAt).toBeNull();
    expect(down.stats.rows).toBeNull();
    expect(down.instances.problem).toBe('unreachable (TypeError)');

    const half = ((url: string) =>
      Promise.resolve(
        url.endsWith('stats')
          ? Response.json([
              { ...stats('1.0.0', 3, 3), plugin: 'a', tool: null },
              { plugin: 'b', plugin_version: '1.0.0', reports: 'x' },
              { ...stats('1.0.0', 3, 3), plugin: 'c', credential_rejections: undefined },
            ])
          : new Response('', { status: 503 }),
      )) as unknown as typeof fetch;
    const read = await fetchHealth(urls, half, () => new Date('2026-11-02T10:00:00Z'));
    expect(read.fetchedAt).toBe('2026-11-02T10:00:00.000Z');
    expect(read.stats.rows?.map((r) => r.plugin)).toEqual(['a']);
    expect(read.instances).toEqual({ rows: null, problem: 'HTTP 503' });

    const odd = (() => Promise.resolve(new Response('{"no":"list"}'))) as typeof fetch;
    expect((await fetchHealth(urls, odd)).stats.problem).toBe('not a list');
  });
});

describe('routing on the collector host and by Accept', () => {
  const HOST = 'telemetry.vaubaan.com';

  it('serves only the collector on its host, and the site everywhere else', () => {
    expect(hostDecision(HOST, '/v1/reports', HOST)).toBe('collector-route');
    expect(hostDecision(HOST, '/v1/plugin_stats', HOST)).toBe('collector-route');
    expect(hostDecision(HOST, '/v1/plugin_instances', HOST)).toBe('collector-route');
    expect(hostDecision(HOST, '/robots.txt', HOST)).toBe('collector-robots');
    expect(hostDecision(HOST, '/', HOST)).toBe('not-found');
    expect(hostDecision(HOST, '/docs', HOST)).toBe('not-found');
    expect(hostDecision('vaubaan.com', '/docs', HOST)).toBe('site');
    expect(hostDecision(HOST, '/docs', undefined)).toBe('site');
    expect(hostOf('Telemetry.Vaubaan.com:443')).toBe(HOST);
  });

  it('answers Markdown when it is asked for and not ranked below HTML', () => {
    expect(wantsMarkdown('text/markdown')).toBe(true);
    expect(wantsMarkdown('text/markdown, text/html;q=0.5')).toBe(true);
    expect(wantsMarkdown('text/html,application/xhtml+xml,*/*;q=0.8')).toBe(false);
    expect(wantsMarkdown('text/html, text/markdown')).toBe(false);
    expect(wantsMarkdown('text/markdown;q=0')).toBe(false);
    expect(wantsMarkdown(null)).toBe(false);
  });

  it('knows which pages have a twin', () => {
    expect(markdownTwinOf('/docs')).toBe('/docs.md');
    expect(markdownTwinOf('/docs/install/railway/')).toBe('/docs/install/railway.md');
    expect(markdownTwinOf('/plugins/github')).toBe('/plugins/github.md');
    expect(markdownTwinOf('/trust')).toBe('/trust.md');
    expect(markdownTwinOf('/')).toBeNull();
    expect(markdownTwinOf('/v1/reports')).toBeNull();
    expect(markdownTwinOf('/docs.md')).toBeNull();
  });

  it('renders every twin through one route, from the .md address or the page itself', () => {
    expect(twinRouteOf('/docs/install.md')).toBe('/twins/docs/install');
    expect(twinRouteOf('/docs/install')).toBe('/twins/docs/install');
    expect(twinRouteOf('/plugins/github.md')).toBe('/twins/plugins/github');
    expect(twinRouteOf('/plugins.md')).toBe('/twins/plugins');
    expect(twinRouteOf('/trust/')).toBe('/twins/trust');
    expect(twinRouteOf('/index.md')).toBe('/twins');
    expect(twinRouteOf('/')).toBe('/twins');
    expect(twinRouteOf('/v1/reports')).toBeNull();
    expect(twinRouteOf('/plugins.json')).toBeNull();
    expect(twinRouteOf('/twins/docs')).toBeNull();
  });
});

describe('the hand-written docs', () => {
  it('are plain Markdown with a title and a description, so the twin is the page', () => {
    const docs = loadHandwrittenDocs(
      join(REPO_ROOT, 'apps/website/content/docs'),
      'apps/website/content/docs',
    );
    expect(docs.length).toBeGreaterThan(10);
  });

  it('ignore what fenced and inline code hold', () => {
    expect(proseLines('a `<b>`\n```\n{c}\n```\nd')).toEqual(['a ', 'd']);
  });
});

describe('the trust center reads the threat model', () => {
  const threatModel = readRepoFile(THREAT_MODEL);

  it('lists every accepted risk', () => {
    const rows = threatModel.split('\n').filter((line) => /^\| A\d+\s/.test(line)).length;
    const risks = parseAcceptedRisks(threatModel);
    expect(risks.length).toBe(rows);
    expect(risks[0]?.id).toBe('A1');
    for (const risk of risks) expect(risk.statement).not.toMatch(/\*\*/);
  });

  it('lists the out-of-scope items for an instance', () => {
    expect(parseOutOfScope(threatModel).length).toBeGreaterThan(0);
  });
});
