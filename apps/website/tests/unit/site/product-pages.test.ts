/**
 * The landing and the product pages (website spec §2.1, §2.1 bis; intent
 * "Read the site as a developer or as a consultant"): the navigation and its
 * one button, the project switch without script and remembered on this
 * browser only, the consultants' page, the honesty rule on what is planned,
 * and the README's first lines in step with the landing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../../../src/content/repo';
import { landingMarkdown, LANDING_LEDE, PROMISE, TODAY_STEPS } from '../../../src/site/landing';
import { PRODUCT_PAGES, productPageMarkdown, TRY_PAGE } from '../../../src/site/product-pages';
import { twinRouteOf } from '../../../src/site/routing';

const SITE = join(REPO_ROOT, 'apps/website');
const read = (path: string) => readFileSync(join(SITE, path), 'utf8');

describe('the navigation', () => {
  it('names five destinations and one button, Try it', () => {
    const shell = read('src/components/Shell.tsx');
    const nav = shell.slice(
      shell.indexOf('export const NAV'),
      shell.indexOf('function GitHubMark'),
    );
    const labels = [...nav.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
    expect(labels).toEqual(['How it works', 'Services', 'Teams', 'Security', 'Docs']);
    expect(shell).toMatch(/href="\/try"[^>]*>\s*Try it/);
  });
});

describe('the project switch', () => {
  const project = read('src/components/site/Project.tsx');
  const css = read('src/app/globals.css');

  it('shows the examples and drawings of a developer on GitHub and Supabase, or of a consultant on Gmail, Notion and Google Calendar, without JavaScript', () => {
    expect(project).toContain('type="radio"');
    expect(project).toMatch(/id=\{PROJECT_RADIO_ID\.consultant\}/);
    expect(css).toContain(":root:has(#project-consultant:checked) [data-project='consultant']");
    expect(css).toContain(":root:has(#project-consultant:checked) [data-project='dev']");
    expect(css).toMatch(/\[data-project='consultant'\] \{\s*display: none;/);
    // Every drawing in both projects, the landing's call log too.
    expect(project).toMatch(/PROJECTS\.map\(\(p\) => \{\s*const info = drawingInfo\(name, p\)/);
    expect(read('src/components/site/Landing.tsx')).toMatch(/<CallLog project=\{p\} \/>/);
  });

  it('is remembered on this browser only, and a refused storage changes nothing', async () => {
    const { REMEMBER_SCRIPT, PROJECT_STORAGE_KEY } =
      await import('../../../src/components/site/Project');
    expect(REMEMBER_SCRIPT).not.toMatch(/fetch|XMLHttpRequest|cookie|sendBeacon/);
    const run = (storage: unknown, forced: boolean) => {
      const radio = { checked: false };
      let listener: ((e: { target: { value: string } }) => void) | null = null;
      const fieldset = {
        hasAttribute: () => forced,
        addEventListener: (_: string, f: typeof listener) => (listener = f),
      };
      const document = {
        currentScript: { previousElementSibling: fieldset },
        getElementById: (id: string) => (id === 'project-consultant' ? radio : null),
      };
      runInNewContext(REMEMBER_SCRIPT, { document, localStorage: storage });
      return { radio, change: (value: string) => listener?.({ target: { value } }) };
    };
    const kept = new Map<string, string>([[PROJECT_STORAGE_KEY, 'consultant']]);
    const storage = {
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => kept.set(k, v),
    };
    expect(run(storage, false).radio.checked).toBe(true);
    // /consultants opens on the consultant whatever is kept; a change is still kept.
    const forced = run(storage, true);
    expect(forced.radio.checked).toBe(false);
    forced.change('dev');
    expect(kept.get(PROJECT_STORAGE_KEY)).toBe('dev');
    const refusing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const blocked = run(refusing, false);
    expect(blocked.radio.checked).toBe(false);
    expect(() => blocked.change('consultant')).not.toThrow();
  });

  it('opens the consultants’ page on the consultant’s examples', () => {
    expect(read('src/app/consultants/page.tsx')).toContain('initial="consultant"');
    expect(read('src/app/page.tsx')).toContain('initial="dev"');
  });
});

describe('the product pages', () => {
  it('each have a Markdown twin that carries both projects', () => {
    for (const page of PRODUCT_PAGES) {
      expect(twinRouteOf(`${page.path}.md`), page.path).toBe(`/twins${page.path}`);
      const md = productPageMarkdown(page);
      expect(md.startsWith(`# ${page.title}\n\n${page.lede}\n`), page.path).toBe(true);
    }
    expect(twinRouteOf('/consultants.md')).toBe('/twins/consultants');
    const how = productPageMarkdown(PRODUCT_PAGES[0]!);
    expect(how).toContain('For a developer');
    expect(how).toContain('For a consultant');
  });

  it('offer nothing planned as a button: the desktop app is named planned, without a download', () => {
    const planned = TRY_PAGE.sections.filter((s) => s.status === 'planned');
    expect(planned.map((s) => s.heading)).toEqual(['On your computer, without a server']);
    const all = [
      ...PRODUCT_PAGES.map(productPageMarkdown),
      landingMarkdown([{ id: 'github', name: 'GitHub' }]),
    ].join('\n');
    expect(all).not.toMatch(/\bdownload (for|vaubaan)|\.dmg|\.exe\b/i);
    expect(TODAY_STEPS.filter((s) => s.status === 'planned').length).toBeGreaterThan(0);
    expect(TRY_PAGE.primary.href).toBe('/docs/quick-look');
  });
});

describe('the README', () => {
  it('fails when its first lines differ from the landing’s defining sentence and promise', () => {
    const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
    const head = readme.slice(0, readme.indexOf('\n## '));
    expect(head).toContain(PROMISE);
    expect(head).toContain(LANDING_LEDE);
  });
});
