/**
 * The (i) of every page explains where one is and leads to a page that exists
 * (docs/handbook/web-app.md, "doc hints"): each target of `DOC_PAGES` carries a
 * title and a hint within `DOC_HINT_MAX`, and its path, like `serviceDoc`'s for
 * every plugin the repository ships, is read against the website's sources on
 * disk.
 *
 * - `docs/<path>` is a hand-written page of `apps/website/content/docs`
 *   (`<path>.mdx` or `<path>/index.mdx`), listed in its folder's `meta.json`,
 *   and not a generated one: its Markdown twin is its own source (spec website
 *   §2.6), so a page written for a link keeps the twin rule.
 * - `#<anchor>` is the slug of one of its headings, as the site's heading
 *   plugin writes it (GitHub's slugger: lower case, punctuation dropped,
 *   spaces to hyphens).
 * - `plugins` and `plugins/<id>` are the site's plugin list and plugin pages:
 *   one per `plugins/<id>` folder, `#connect` the anchor of its connect guide.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { docHref } from '@/lib/docs-links';
import {
  articleFor,
  clampHint,
  connectHint,
  DOC_HINT_MAX,
  DOC_PAGES,
  docHintLabel,
  docLinkLabel,
  serviceDoc,
  type ConnectWay,
  type DocTarget,
} from '@/lib/vocabulary';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const DOCS = join(REPO, 'apps/website/content/docs');
const SITE_APP = join(REPO, 'apps/website/src/app');
const ROOT = 'https://docs.test/docs';

/** The plugin folders the site makes a page of: a `package.json`, a name not starting with `_`. */
function pluginIds(): string[] {
  return readdirSync(join(REPO, 'plugins'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
    .filter((e) => existsSync(join(REPO, 'plugins', e.name, 'package.json')))
    .map((e) => e.name);
}

/** GitHub's slugger, as `remarkHeading` applies it to a heading's text. */
export function slugOf(heading: string): string {
  const text = heading
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1');
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/** The slugs of a page's headings, outside fenced code. */
function anchorsOf(markdown: string): string[] {
  const anchors: string[] = [];
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^(```|~~~)/.test(line.trim())) fenced = !fenced;
    if (fenced) continue;
    const heading = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
    if (heading) anchors.push(slugOf(heading[1]!));
  }
  return anchors;
}

function frontmatterOf(text: string): string {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  return match ? match[1]! : '';
}

/** The hand-written page at `slug` under `/docs`, or why it does not count. */
function docPage(slug: string): { file: string; text: string } | string {
  const candidates = slug === '' ? ['index.mdx'] : [`${slug}.mdx`, `${slug}/index.mdx`];
  const file = candidates.map((c) => join(DOCS, c)).find((c) => existsSync(c));
  if (!file) return `no page content/docs/${candidates.join(' or ')}`;
  const text = readFileSync(file, 'utf8');
  const front = frontmatterOf(text);
  if (/^generated:\s*true/m.test(front)) return `${file} is generated, not a hand-written page`;
  if (!/^title:/m.test(front) || !/^description:/m.test(front)) {
    return `${file} lacks its title or description`;
  }
  return { file, text };
}

/** Whether the page is listed by its folder's `meta.json` (the root lists a folder by its name). */
function listedInMeta(slug: string): boolean {
  if (slug === '') return true;
  const parts = slug.split('/');
  const name = parts.pop()!;
  const meta = join(DOCS, ...parts, 'meta.json');
  if (!existsSync(meta)) return false;
  const pages = (JSON.parse(readFileSync(meta, 'utf8')) as { pages: string[] }).pages;
  return pages.includes(name) || pages.includes('...');
}

/** What is wrong with a target, or `null`. */
function problemOf(target: DocTarget): string | null {
  const url = new URL(docHref(ROOT, target));
  if (url.origin !== 'https://docs.test') return `${target.path} leaves the docs site`;
  const anchor = url.hash.slice(1);
  if (url.pathname === '/plugins') {
    return existsSync(join(SITE_APP, 'plugins/page.tsx')) ? null : 'the site has no /plugins';
  }
  const plugin = /^\/plugins\/([^/]+)$/.exec(url.pathname);
  if (plugin) {
    const id = decodeURIComponent(plugin[1]!);
    if (!pluginIds().includes(id)) return `no plugin folder plugins/${id}`;
    if (!existsSync(join(SITE_APP, 'plugins/[id]/page.tsx'))) return 'the site has no plugin page';
    if (anchor && anchor !== connectAnchor()) return `plugin pages have no #${anchor}`;
    return null;
  }
  const docs = /^\/docs(?:\/(.*))?$/.exec(url.pathname);
  if (!docs) return `${url.pathname} is neither under /docs nor a plugin page`;
  const slug = docs[1] ?? '';
  const page = docPage(slug);
  if (typeof page === 'string') return page;
  if (!listedInMeta(slug)) return `${slug} is in no meta.json`;
  if (anchor && !anchorsOf(page.text).includes(anchor)) {
    return `${slug} has no heading #${anchor} (has: ${anchorsOf(page.text).join(', ')})`;
  }
  return null;
}

/** The anchor of a plugin page's connect guide, read from the site (`CONNECT_ANCHOR`). */
function connectAnchor(): string {
  const source = readFileSync(join(REPO, 'apps/website/src/content/plugin-page.ts'), 'utf8');
  const match = /export const CONNECT_ANCHOR = '([^']+)'/.exec(source);
  if (!match) throw new Error('CONNECT_ANCHOR not found in plugin-page.ts');
  return match[1]!;
}

describe('doc links: every target of the table has its page on the site', () => {
  for (const [id, target] of Object.entries(DOC_PAGES)) {
    it(`${id} → ${target.path}`, () => {
      expect(problemOf(target)).toBeNull();
    });
  }

  it('every shipped plugin has its page and its connect guide', () => {
    const ids = pluginIds();
    expect(ids.length).toBeGreaterThan(5);
    const problems = ids.flatMap((id) =>
      [serviceDoc(id, id), serviceDoc(id, id, 'connect')].flatMap((t) => {
        const problem = problemOf(t);
        return problem ? [problem] : [];
      }),
    );
    expect(problems).toEqual([]);
  });

  it('a missing page or heading is caught', () => {
    const at = (path: string): DocTarget => ({ label: 'x', hint: 'x', path });
    expect(problemOf(at('no-such-page'))).toMatch(/no page/);
    expect(problemOf(at('missions#no-such-heading'))).toMatch(/no heading/);
    expect(problemOf(at('../plugins/no-such-plugin'))).toMatch(/no plugin/);
  });
});

describe('doc links: addresses and names', () => {
  it('resolves under the configured root, with or without a trailing slash', () => {
    expect(docHref('https://vaubaan.test/docs', DOC_PAGES.newMission)).toBe(
      'https://vaubaan.test/docs/missions#create-a-mission',
    );
    expect(docHref('https://vaubaan.test/docs/', DOC_PAGES.missions)).toBe(
      'https://vaubaan.test/docs/missions',
    );
    expect(
      docHref('https://mirror.test/vaubaan/docs', serviceDoc('github', 'GitHub', 'connect')),
    ).toBe('https://mirror.test/vaubaan/plugins/github#connect');
  });

  it('names the (i) and its Documentation line after the page', () => {
    expect(docHintLabel(DOC_PAGES.missions)).toBe('About Missions');
    expect(docLinkLabel(DOC_PAGES.missions)).toBe('Documentation: Missions (opens in a new tab)');
    expect(docLinkLabel(serviceDoc('github', 'GitHub'))).toBe(
      'Documentation: GitHub (opens in a new tab)',
    );
  });

  it('slugs headings as the site does', () => {
    expect(slugOf('The activity of a mission')).toBe('the-activity-of-a-mission');
    expect(slugOf('Sign-in')).toBe('sign-in');
    expect(slugOf('When a call is refused')).toBe('when-a-call-is-refused');
    expect(slugOf("What's `new`, (really)?")).toBe('whats-new-really');
  });
});

describe('doc hints: every target says where one is, in a few words', () => {
  /** What is wrong with a hint, or `null`: a title, a text within the limit, one to three sentences. */
  function hintProblem(target: DocTarget): string | null {
    if (target.label.trim() === '') return 'no title';
    const text = target.hint.trim();
    if (text === '') return 'no text';
    if (text.length > DOC_HINT_MAX) return `${text.length} characters, more than ${DOC_HINT_MAX}`;
    const sentences = text.split(/[.!?…](?:\s|$)/).filter((s) => s.trim() !== '').length;
    if (sentences > 3) return `${sentences} sentences, more than 3`;
    return null;
  }

  for (const [id, target] of Object.entries(DOC_PAGES)) {
    it(`${id}: “${target.label}”`, () => {
      expect(hintProblem(target)).toBeNull();
    });
  }

  it('says account and service, never the retired words', () => {
    const texts = [
      ...Object.values(DOC_PAGES).map((t) => t.hint),
      ...(['api-key', 'oauth2', 'ssh-key', 'host'] as const).map((way) => connectHint('X', way)),
    ];
    for (const text of texts) expect(text).not.toMatch(/\b(connections?|providers?)\b/i);
  });

  it('a service hint is its plugin’s description, or what connecting involves', () => {
    const page = serviceDoc(
      'github',
      'GitHub',
      'page',
      'Repositories, branches and pull requests.',
    );
    expect(page.hint).toBe('Repositories, branches and pull requests.');
    expect(serviceDoc('github', 'GitHub').hint).toMatch(/GitHub/);
    const ways: ConnectWay[] = ['api-key', 'oauth2', 'ssh-key', 'host'];
    for (const way of ways) {
      const longest = connectHint(
        'A service with a very long display name',
        way,
        'fine-grained personal access token',
      );
      expect(hintProblem(serviceDoc('x', 'X', 'connect', longest))).toBeNull();
    }
    expect(connectHint('Vercel', 'api-key', 'access token')).toMatch(
      /^You create an access token at Vercel and paste it once\./,
    );
  });

  it('chooses a or an from the key’s name, never “a(n)”', () => {
    // The names the shipped plugins give their keys, and the exceptions of the first sound.
    const cases: Record<string, 'a' | 'an'> = {
      'API key': 'an',
      'API token': 'an',
      'access token': 'an',
      'app password': 'an',
      'internal account token': 'an',
      'personal access token': 'a',
      'fine-grained personal access token': 'a',
      'secret key': 'a',
      'workspace token': 'a',
      'Developer API key': 'a',
      'user token': 'a',
      'one-time key': 'a',
      'hourly key': 'an',
    };
    for (const [noun, article] of Object.entries(cases))
      expect(articleFor(noun), noun).toBe(article);
    const hints = [
      ...Object.values(DOC_PAGES).map((t) => t.hint),
      ...Object.keys(cases).map((noun) => connectHint('Vercel', 'api-key', noun)),
      ...(['api-key', 'oauth2', 'ssh-key', 'host'] as const).map((way) => connectHint('X', way)),
    ];
    for (const hint of hints) expect(hint).not.toMatch(/\ba\(n\)/i);
    expect(connectHint('Vercel', 'api-key', 'access token')).toMatch(/^You create an access token/);
    expect(connectHint('GitHub', 'api-key', 'fine-grained personal access token')).toMatch(
      /^You create a fine-grained/,
    );
  });

  it('cuts a plugin’s long description at a word, within the limit', () => {
    const long = `${'word '.repeat(80)}end.`;
    const cut = clampHint(long);
    expect(cut.length).toBeLessThanOrEqual(DOC_HINT_MAX);
    expect(cut).toMatch(/word…$/);
    expect(clampHint('  Short,\n  on two lines. ')).toBe('Short, on two lines.');
  });
});
