/**
 * The small pieces: Markdown helpers, plugin health, host and Accept routing,
 * the hand-written docs rule, the trust center's reading of the threat model.
 */
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadHandwrittenDocs, proseLines } from '../../../src/content/docs';
import {
  allVersionsWords,
  fetchHealth,
  healthOf,
  healthWords,
  type HealthSnapshot,
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

const THRESHOLDS = { minReports: 200, minSuccessRate: 0.9, windowDays: 90 };

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
  const measured: HealthSnapshot = {
    fetchedAt: '2026-10-16T00:00:00.000Z',
    rows: [
      {
        plugin: 'github',
        plugin_version: '3.1.0',
        reports: 1200,
        success_rate: 0.95,
        validated: true,
      },
      { plugin: 'fly', plugin_version: '0.1.0', reports: 12, success_rate: 1, validated: false },
    ],
    problem: null,
  };

  it('shows the count and the minimum below the minimum of reports, never a rate', () => {
    const fly = healthOf(measured, 'fly', '0.1.0', THRESHOLDS);
    expect(fly.version).toEqual({ state: 'below-threshold', reports: 12 });
    expect(healthWords(fly, THRESHOLDS)).toBe('12 reports of the 200 needed, no rate yet');
    const unknownVersion = healthOf(measured, 'github', '3.0.0', THRESHOLDS);
    expect(unknownVersion.version).toEqual({ state: 'below-threshold', reports: 0 });
    expect(healthWords(unknownVersion, THRESHOLDS)).toBe('no report yet (200 needed)');
  });

  it('says so when the collector could not be read, and knows no history then', () => {
    const offline = { fetchedAt: null, rows: [], problem: 'x' };
    const health = healthOf(offline, 'github', '3.1.0', THRESHOLDS);
    expect(health).toEqual({ version: { state: 'not-read' }, allVersions: null });
    expect(healthWords(health, THRESHOLDS)).toBe('not read (the collector did not answer)');
    expect(allVersionsWords(health)).toBe('');
  });

  it('adds every version of the plugin up as its history, a count without a verdict', () => {
    const twoVersions: HealthSnapshot = {
      ...measured,
      rows: [
        ...measured.rows,
        {
          plugin: 'github',
          plugin_version: '3.0.0',
          reports: 73,
          success_rate: 1,
          validated: false,
        },
      ],
    };
    const current = healthOf(twoVersions, 'github', '3.1.0', THRESHOLDS);
    expect(current.allVersions).toEqual({ reports: 1273, versions: 2 });
    expect(allVersionsWords(current)).toBe('1273 reports over 2 versions');
    expect(allVersionsWords(healthOf(measured, 'fly', '0.1.0', THRESHOLDS))).toBe(
      '12 reports over 1 version',
    );
    expect(allVersionsWords(healthOf(measured, 'never-seen', '1.0.0', THRESHOLDS))).toBe(
      'no report for any version',
    );
  });

  it('shows the rate and the status from the minimum on', () => {
    const health = healthOf(measured, 'github', '3.1.0', THRESHOLDS);
    expect(health.version).toEqual({
      state: 'measured',
      reports: 1200,
      successRate: 0.95,
      validated: true,
    });
    expect(healthWords(health, THRESHOLDS)).toBe(
      'validated by the community (95.0 % of 1200 calls worked)',
    );
  });

  it('never throws on a failing or odd collector', async () => {
    const failing = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    expect((await fetchHealth('https://c.example', failing)).rows).toEqual([]);
    const odd = (() => Promise.resolve(new Response('{"no":"list"}'))) as typeof fetch;
    expect((await fetchHealth('https://c.example', odd)).problem).toBe('not a list');
    const status = (() => Promise.resolve(new Response('', { status: 503 }))) as typeof fetch;
    expect((await fetchHealth('https://c.example', status)).problem).toBe('HTTP 503');
    const rows = (() =>
      Promise.resolve(
        Response.json([
          {
            plugin: 'a',
            plugin_version: '1.0.0',
            tool: null,
            reports: 3,
            success_rate: 1,
            validated: false,
          },
          { plugin: 'b', plugin_version: '1.0.0', reports: 'x' },
        ]),
      )) as typeof fetch;
    expect((await fetchHealth('https://c.example', rows)).rows.map((r) => r.plugin)).toEqual(['a']);
  });
});

describe('routing on the collector host and by Accept', () => {
  const HOST = 'telemetry.vaubaan.com';

  it('serves only the collector on its host, and the site everywhere else', () => {
    expect(hostDecision(HOST, '/v1/reports', HOST)).toBe('collector-route');
    expect(hostDecision(HOST, '/v1/plugin_stats', HOST)).toBe('collector-route');
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
