/**
 * The site as data (`buildSite`): every page has its Markdown twin, llms.txt
 * and llms-full.txt carry every docs page, the sitemap every page, robots.txt
 * welcomes every crawler, and every link into the repository names a file
 * that exists. Built without the collector, without writing anything; the
 * plugin pages then read "not read", the way a page renders when the
 * collector does not answer.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  buildSite,
  DOCS_DIR_FROM_REPO,
  UNREAD,
  type BuiltSite,
} from '../../../src/content/build-site';
import { docPathOf } from '../../../src/content/docs';
import {
  absolute,
  BUILT_ROUTE_FILES,
  LIVE_FILES,
  NAMED_CRAWLERS,
  robotsTxt,
  twinPathOf,
} from '../../../src/content/outputs';
import { loadPlugins } from '../../../src/content/plugins';
import { readRepoFile, REPO_ROOT } from '../../../src/content/repo';
import { parseThresholds, THRESHOLDS_SOURCE } from '../../../src/content/thresholds';
import { liveLlmsFull, livePluginsJson, liveSiteFrom, pageMarkdown } from '../../../src/site/live';
import { markdownTwinOf, twinRouteOf } from '../../../src/site/routing';

let site: BuiltSite;

beforeAll(async () => {
  site = buildSite({
    repoRoot: REPO_ROOT,
    plugins: await loadPlugins(REPO_ROOT),
    thresholds: parseThresholds(readRepoFile(THRESHOLDS_SOURCE)),
    lastModified: () => null,
  });
}, 60_000);

/** Every path the site answers besides its pages: the public files and the live ones. */
function servedFiles(): Set<string> {
  return new Set([
    ...site.files.keys(),
    ...site.assets.keys(),
    ...LIVE_FILES,
    ...BUILT_ROUTE_FILES,
  ]);
}

function handwrittenDocPaths(): string[] {
  const dir = join(REPO_ROOT, DOCS_DIR_FROM_REPO);
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((name) => {
      const path = join(d, name);
      if (statSync(path).isDirectory()) return walk(path);
      return name.endsWith('.mdx') ? [path] : [];
    });
  return walk(dir)
    .filter((file) => !readRepoFile(relative(REPO_ROOT, file)).includes('\ngenerated: true\n'))
    .map((file) => docPathOf(relative(dir, file).split('/').join(sep)));
}

describe('the pages of the site', () => {
  it('include every hand-written docs page, every generated one and every plugin', () => {
    const paths = site.pages.map((p) => p.path);
    for (const path of handwrittenDocPaths()) expect(paths).toContain(path);
    for (const doc of site.generatedDocs) expect(paths).toContain(doc.page.path);
    for (const plugin of site.plugins) {
      expect(paths).toContain(`/plugins/${plugin.id}`);
      // The connect guide is section 9 of the plugin page: no page of its own.
      expect(paths).not.toContain(`/docs/providers/${plugin.id}`);
    }
    for (const path of ['/', '/docs', '/plugins', '/plugins/health', '/trust']) {
      expect(paths).toContain(path);
    }
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('each have a Markdown twin, rendered by one route from the .md address and from Accept', () => {
    const live = liveSiteFrom(site.data, UNREAD);
    for (const page of site.pages) {
      const twin = twinPathOf(page.path);
      expect(twinRouteOf(twin), twin).toBe(twinRouteOf(page.path));
      expect(twinRouteOf(twin), twin).not.toBeNull();
      expect(pageMarkdown(page.path, live, site.data), page.path).toBe(page.markdown);
      expect(page.markdown.startsWith(`# ${page.title}\n`), page.path).toBe(true);
      if (page.group !== 'home') expect(markdownTwinOf(page.path), page.path).toBe(twin);
    }
  });

  it('open with a sentence that defines their subject, after the title', () => {
    for (const page of site.pages) {
      const first = page.markdown.split('\n\n')[1] ?? '';
      expect(first.length, page.path).toBeGreaterThan(40);
      expect(first.startsWith('#'), page.path).toBe(false);
    }
  });
});

describe('llms.txt and llms-full.txt', () => {
  it('llms.txt lists every page but the home page, with its .md address', () => {
    const llms = site.files.get('llms.txt') ?? '';
    expect(llms.startsWith('# Vaubaan Gateway\n\n> ')).toBe(true);
    for (const page of site.pages.filter((p) => p.group !== 'home')) {
      expect(llms, page.path).toContain(
        `(${absolute(twinPathOf(page.path))}): ${page.description}`,
      );
    }
  });

  it('llms-full.txt carries the whole of every docs, plugin and trust page', () => {
    const full = liveLlmsFull(liveSiteFrom(site.data, UNREAD), site.data);
    for (const page of site.pages.filter((p) => p.group !== 'home')) {
      expect(full, page.path).toContain(
        `Source: ${absolute(page.path)}\n\n${page.markdown.trim()}`,
      );
    }
    expect(full).not.toContain(`Source: ${absolute('/')}\n`);
  });
});

describe('robots.txt and sitemap.xml', () => {
  it('robots.txt allows every crawler, the AI ones by name, and disallows nothing', () => {
    const robots = robotsTxt();
    expect(site.files.get('robots.txt')).toBe(robots);
    for (const agent of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'CCBot']) {
      expect(NAMED_CRAWLERS).toContain(agent);
      expect(robots).toContain(`User-agent: ${agent}\nAllow: /\n`);
    }
    expect(robots).toContain('User-agent: *\nAllow: /\n');
    expect(robots).not.toMatch(/Disallow/);
    expect(robots).toContain('Sitemap: https://vaubaan.com/sitemap.xml');
  });

  it('sitemap.xml lists every page by its canonical address', () => {
    const sitemap = site.files.get('sitemap.xml') ?? '';
    for (const page of site.pages) expect(sitemap).toContain(`<loc>${absolute(page.path)}</loc>`);
    expect(sitemap.match(/<url>/g)?.length).toBe(site.pages.length);
  });
});

describe('plugins.json', () => {
  it('carries every plugin with its version, risks, macro-actions and, unread, figures that say so', () => {
    const json = JSON.parse(livePluginsJson(liveSiteFrom(site.data, UNREAD))) as {
      health_read_at: string | null;
      health_refreshed_every_seconds: number;
      health_read: Record<string, boolean>;
      plugins: (Record<string, unknown> & { version: string })[];
    };
    expect(json.health_read_at).toBeNull();
    expect(json.health_refreshed_every_seconds).toBe(3600);
    expect(json.health_read).toEqual({ calls: false, gateways: false });
    expect(json.plugins.map((p) => p.id)).toEqual(site.plugins.map((p) => p.id));
    for (const plugin of json.plugins) {
      expect(plugin).not.toHaveProperty('status');
      const minor = plugin.version.split('.').slice(0, 2).join('.');
      expect(plugin.health).toEqual({
        gateways: null,
        minors: [{ minor, gateways: null, calls: null, success_rate: null }],
        versions: [],
      });
    }
  });

  it('carries what the plugin page shows: facts, trust levels, examples, the worked mission, the client source', () => {
    const json = JSON.parse(livePluginsJson(liveSiteFrom(site.data, UNREAD))) as {
      plugins: Record<string, unknown>[];
    };
    for (const plugin of json.plugins) {
      expect(Object.keys(plugin), String(plugin.id)).toEqual(
        expect.arrayContaining([
          'icon',
          'icon_color',
          'resource_noun',
          'summary',
          'excluded_tools',
          'examples',
          'worked_mission',
          'credentials',
        ]),
      );
    }
    const github = json.plugins.find((p) => p.id === 'github') as {
      risks: Record<string, unknown>[];
      macro_actions: { narrative: string | null; entries: Record<string, unknown>[] }[];
      examples: { tool: string; slices: string[]; permissions: string[]; careful: unknown }[];
      credentials: { client_source: string }[];
    };
    expect(Object.keys(github.risks[0] ?? {})).toEqual(
      expect.arrayContaining([
        'vector',
        'undo',
        'row',
        'row_reason',
        'rate_ceiling_per_minute',
        'patterns',
        'env_variants',
        'replaced_by',
      ]),
    );
    expect(github.macro_actions[0]?.narrative).toEqual(expect.any(String));
    expect(Object.keys(github.macro_actions[0]?.entries[0]?.trust_levels ?? {})).toEqual([
      'careful',
      'trusting',
      'autonomous',
    ]);
    expect(github.examples.find((e) => e.tool === 'github__git_push')?.permissions).toContain(
      'github.git-push',
    );
    expect(github.credentials[0]?.client_source).toBe('pasted-key');
    const calendar = json.plugins.find((p) => p.id === 'google-calendar') as {
      credentials: { client_source: string; broker_provider: string; scopes: string[] }[];
    };
    expect(calendar.credentials[0]).toMatchObject({
      client_source: 'broker',
      broker_provider: 'google',
    });
  });
});

describe('links into the repository', () => {
  it('name files and folders that exist', () => {
    const missing = new Set<string>();
    for (const page of site.pages) {
      for (const match of page.markdown.matchAll(
        /https:\/\/github\.com\/vaubaan\/gateway\/(?:blob|tree)\/main\/([^)#\s]+)/g,
      )) {
        const path = decodeURI(match[1] ?? '').replace(/\/$/, '');
        if (!existsSync(join(REPO_ROOT, path))) missing.add(`${page.path} → ${path}`);
      }
    }
    expect([...missing]).toEqual([]);
  });

  it('inside the site name pages that exist', () => {
    const paths = new Set(site.pages.map((p) => p.path));
    const files = servedFiles();
    const missing = new Set<string>();
    for (const page of site.pages) {
      for (const match of page.markdown.matchAll(/\]\((\/[^)#\s]*)(#[^)\s]*)?\)/g)) {
        const target = match[1] ?? '';
        if (!paths.has(target) && !files.has(target.slice(1)))
          missing.add(`${page.path} → ${target}`);
      }
    }
    expect([...missing]).toEqual([]);
  });
});
