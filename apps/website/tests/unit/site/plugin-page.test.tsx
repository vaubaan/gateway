/**
 * The plugin page of the site (website spec §2.3): the shared page of
 * `@vaubaan/plugin-page` (its sections 1–8 are tested in that package) with
 * the site's own health and links, and its Markdown twin. The HTML is
 * rendered here as the page renders it on the server, with the collector
 * unread; `npm run build` renders the same component for every plugin.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';

import { ROW_WORDS } from '@vaubaan/policy-engine';
import { BROKER_DOC, MAP_ROWS, sectionNumbers } from '@vaubaan/plugin-page/page-data';

import { PluginPageView } from '../../../src/components/plugin/PluginPage';
import { unreadSnapshot } from '../../../src/content/health';
import {
  pluginPageMarkdown,
  withHealth,
  type PluginWithHealth,
} from '../../../src/content/plugin-pages';
import { loadPlugins } from '../../../src/content/plugins';
import { readRepoFile, REPO_ROOT } from '../../../src/content/repo';
import { SITE_REDIRECTS } from '../../../src/site/redirects';
import {
  parseThresholds,
  THRESHOLDS_SOURCE,
  type ValidationThresholds,
} from '../../../src/content/thresholds';

let plugins: PluginWithHealth[] = [];
let thresholds: ValidationThresholds;

beforeAll(async () => {
  thresholds = parseThresholds(readRepoFile(THRESHOLDS_SOURCE));
  plugins = withHealth(await loadPlugins(REPO_ROOT), unreadSnapshot('offline in the tests'));
}, 60_000);

function byId(id: string): PluginWithHealth {
  const plugin = plugins.find((p) => p.id === id);
  if (!plugin) throw new Error(`no plugin '${id}'`);
  return plugin;
}

const pages = new Map<string, string>();
function html(id: string): string {
  const known = pages.get(id);
  if (known) return known;
  const page = renderToStaticMarkup(<PluginPageView plugin={byId(id)} thresholds={thresholds} />);
  pages.set(id, page);
  return page;
}

/** The HTML of one section of the page, by its id. */
function section(page: string, id: string): string {
  const start = page.indexOf(`<section id="${id}"`);
  if (start < 0) throw new Error(`no section '${id}'`);
  return page.slice(start, page.indexOf('</section>', start));
}

/** Text without tags, entities decoded: what a reader sees. */
function words(fragment: string): string {
  return fragment
    .replace(/<wbr\/?>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');
}

const ORDER = [
  'model',
  'macro-actions',
  'map',
  'examples',
  'anything-else',
  'tools',
  'retired',
  'connect',
  'health',
  'links',
];

describe('the rendered page, in ten sections', () => {
  it('/plugins/github: every section in order, numbered, retired before connecting', () => {
    const page = html('github');
    const at = ORDER.map((id) => page.indexOf(`<section id="${id}"`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const kickers = [...page.matchAll(/<p class="pp-k">(\d+) · ([^<]+)<\/p>/g)].map(
      (m) => `${m[1]} ${m[2]}`,
    );
    expect(kickers).toEqual([
      '1 The model',
      '2 Macro-actions',
      '3 The map',
      '4 A few calls',
      '5 Anything else',
      '6 Tools',
      '7 Retired permissions',
      '8 Connecting an account',
      '9 Health',
      '10 Links',
    ]);
    expect(words(page)).toContain('How GitHub is modelled');
    expect(words(page)).toContain('What an agent does at GitHub: 5 macro-actions');
  });

  it('numbers the sections without a gap when there is no retired permission', () => {
    const plain = plugins.find((p) => p.retired.length === 0)!;
    const n = sectionNumbers(plain, ['health', 'links']);
    expect([n.tools, n.connect, n.health, n.links]).toEqual([6, 7, 8, 9]);
    expect(html(plain.id)).not.toContain('<section id="retired"');
  });

  it('the header: mark, name, version, description and the counts line', () => {
    const github = byId('github');
    const hero = html('github').slice(0, html('github').indexOf('<section'));
    expect(hero).toContain('class="pp-svc"');
    expect(words(hero)).toContain(`GitHub ${github.version}`);
    expect(words(hero)).toContain(github.description);
    expect(words(hero)).toMatch(
      /18 permissions · 5 macro-actions · \d+ tools and the git remote · /,
    );
  });

  it('drops what the Atlas design retired: no worked mission, no fact chips, no spreads', () => {
    for (const id of ['github', 'supabase', 'vercel']) {
      const page = html(id);
      expect(page, id).not.toContain('<section id="mission"');
      expect(page, id).not.toContain('<section id="do-');
      expect(page, id).not.toContain('class="cell');
      expect(words(page), id).not.toContain('A mission, worked out');
    }
  });

  it('never says "tier" nor "severity", in the HTML or the twin, for any plugin', () => {
    for (const plugin of plugins) {
      const page = words(html(plugin.id));
      const md = pluginPageMarkdown(plugin, thresholds);
      for (const text of [page, md]) {
        expect(text, plugin.id).not.toMatch(/\btiers?\b/i);
        expect(text, plugin.id).not.toMatch(/\bseverity\b/i);
      }
    }
  });
});

describe('what the site hands the shared page', () => {
  it('links the examples’ source on GitHub, and keeps the site’s own paths', () => {
    expect(section(html('github'), 'examples')).toContain(
      'href="https://github.com/vaubaan/gateway/blob/main/plugins/github/src/examples.ts"',
    );
    expect(section(html('google-calendar'), 'connect')).toContain(`href="${BROKER_DOC}"`);
    expect(section(html('github'), 'tools')).toContain('href="/docs/missions/git-remote"');
    expect(html('github')).toContain('<p class="crumbs"><a href="/plugins">Plugins</a> / GitHub');
    // The page is the document: the service's name is its one h1.
    expect(html('github').match(/<h1[ >]/g)).toHaveLength(1);
  });
});

describe('8 · connecting an account, on the site', () => {
  it('has no page of its own: the old address redirects to the section', () => {
    expect(section(html('github'), 'connect')).not.toContain('/docs/providers/');
    expect(SITE_REDIRECTS).toContainEqual({
      source: '/docs/providers/:id([a-z][a-z0-9-]*)',
      destination: '/plugins/:id#connect',
      permanent: true,
    });
  });
});

describe('the Markdown twin', () => {
  it('keeps the order of the page: the model as an outline, the map as one list per row', () => {
    const md = pluginPageMarkdown(byId('github'), thresholds);
    const headings = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual([
      'How GitHub is modelled',
      'What an agent does at GitHub: 5 macro-actions',
      'The map',
      'A few calls, classified by the plugin',
      'Anything else',
      'Tools',
      'Retired permissions',
      'Connecting an account',
      'Health',
      'Links',
    ]);
    const rows = [...md.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    expect(rows).toEqual(MAP_ROWS.map((row) => ROW_WORDS[row]));
    expect(md).toMatch(/^ {4}- `repo` \(1; the resource\) — /m);
    expect(md).toMatch(
      /^- Read: Read code, branches, commits, files `github\.read-code` — .+ Careful: yes · [\d,]+ a day · Trusting: yes · [\d,]+ a day · Autonomous: yes · [\d,]+ a day\.$/m,
    );
  });

  it('gives every environment of an env-qualified permission, refused ones included', () => {
    const md = pluginPageMarkdown(byId('supabase'), thresholds);
    expect(md).toContain('  - On prod: Careful: no · never on prod');
    expect(md).toMatch(/^ {2}- On staging: Careful: ask me · 50 a day/m);
  });

  it('names the broker for Google Calendar, and the alternatives for Vercel', () => {
    const calendar = pluginPageMarkdown(byId('google-calendar'), thresholds);
    const connect = calendar.slice(
      calendar.indexOf('## Connecting an account'),
      calendar.indexOf('## Health'),
    );
    expect(connect).toContain('`google`');
    expect(connect).toContain(`](${BROKER_DOC})`);
    const vercel = pluginPageMarkdown(byId('vercel'), thresholds);
    expect(vercel).toContain('Choose one:');
    for (const alt of byId('vercel').credentials[0]!.alternatives) {
      expect(vercel).toContain(`**${alt.label}**`);
    }
  });

  it('does not link to itself, and keeps the handbook link', () => {
    const md = pluginPageMarkdown(byId('github'), thresholds);
    expect(md).toContain('- The page: [/plugins/github](/plugins/github)');
    expect(md.match(/- The page:/g)).toHaveLength(1);
  });
});
