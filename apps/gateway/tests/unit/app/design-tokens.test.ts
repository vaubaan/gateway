/**
 * The interface reads its colours, sizes and radii from the shared sheet
 * (`@vaubaan/design-tokens`; style guide §3, §7; ADR
 * design-system-on-shadcn-shared-by-the-app-and-the-site). The contrast of
 * every documented pair, in both themes, is the package's own test
 * (`packages/design-tokens/tests/unit/contrast.test.ts`); these check what
 * the interface does with it:
 *
 * - the global sheet imports Tailwind and the shared sheets, the theme one
 *   `theme(static)` so a CSS module can read a shared size;
 * - `styles/tokens.css` holds aliases of former names only: each value reads
 *   a shared name, none is written there;
 * - every alias is read somewhere (the sheet shrinks as components move), and
 *   no style refers to a variable that does not exist;
 * - a style sheet holds no raw colour, and sets a font size with a token.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOKENS } from '@vaubaan/design-tokens';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../../../src');
const PACKAGE = resolve(HERE, '../../../../../packages/design-tokens');
const ALIASES_FILE = resolve(SRC, 'styles/tokens.css');
const GLOBALS_FILE = resolve(SRC, 'app/globals.css');
const ALIASES = readFileSync(ALIASES_FILE, 'utf8');
const GLOBALS = readFileSync(GLOBALS_FILE, 'utf8');
const SHARED = readFileSync(resolve(PACKAGE, 'tokens.css'), 'utf8');
const THEME = readFileSync(resolve(PACKAGE, 'theme.css'), 'utf8');

/** Tailwind's own variables the interface reads (its spacing step, weights, leading, motion). */
const TAILWIND = new Set([
  '--spacing',
  '--font-weight-normal',
  '--font-weight-semibold',
  '--leading-normal',
  '--leading-snug',
  '--default-transition-duration',
]);

function declared(css: string): Map<string, string> {
  const names = new Map<string, string>();
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    names.set(match[1] ?? '', (match[2] ?? '').replace(/\s+/g, ' ').trim());
  }
  return names;
}

const ALIAS = declared(ALIASES);
const SHARED_NAMES = new Set([...declared(SHARED).keys(), ...declared(THEME).keys()]);
const MEASURES = declared(GLOBALS);

function files(dir: string, test: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, test, out);
    else if (test.test(name)) out.push(path);
  }
  return out;
}

describe('the tokens of the interface', () => {
  it('come from the shared sheet, through Tailwind', () => {
    expect(GLOBALS).toContain("@import 'tailwindcss';");
    expect(GLOBALS).toContain("@import '@vaubaan/design-tokens/tokens.css';");
    expect(GLOBALS).toContain("@import '@vaubaan/design-tokens/theme.css' theme(static);");
    expect(GLOBALS).toContain("@import '../styles/tokens.css';");
  });

  it('keep former names as aliases of shared names, and write no value of their own', () => {
    expect(ALIAS.size).toBeGreaterThan(0);
    const own: string[] = [];
    for (const [name, value] of ALIAS) {
      const read = [...value.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((match) => match[1] ?? '');
      if (read.length === 0) own.push(`${name}: ${value}`);
      for (const target of read) {
        if (!SHARED_NAMES.has(target) && !TAILWIND.has(target)) own.push(`${name} → ${target}`);
      }
    }
    expect(own).toEqual([]);
  });

  it('never redefine a shared name', () => {
    const clash = [...ALIAS.keys(), ...MEASURES.keys()].filter((name) => SHARED_NAMES.has(name));
    expect(clash).toEqual([]);
  });

  it('resolve on every themed element, so a dark island reads its own values', () => {
    expect(ALIASES).toMatch(/:root,\s*\.light,\s*\.dark,\s*\[data-theme\] \{/);
  });

  it('have one accent, and no orange or yellow in either theme', () => {
    expect(TOKENS.find((token) => token.name === 'primary')?.light).toBe('#2f55c7');
    for (const css of [ALIASES, GLOBALS]) {
      expect(css.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/amber|orange|yellow|sky/i);
    }
  });
});

describe('the styles of the interface', () => {
  const sheets = files(SRC, /\.css$/).filter((path) => path !== ALIASES_FILE);
  const sources = [
    ...sheets,
    ...files(SRC, /\.tsx?$/).filter((path) => !/\.test\.tsx?$/.test(path)),
  ];
  const text = new Map(sources.map((path) => [path, readFileSync(path, 'utf8')]));
  const defined = new Set([...SHARED_NAMES, ...ALIAS.keys(), ...MEASURES.keys(), ...TAILWIND]);
  /** Variables a component sets for itself, or that come from outside the token sheets. */
  const LOCAL = new Set([
    '--font-geist-sans',
    '--font-geist-mono',
    '--tone',
    '--tone-bg',
    '--tone-fg',
    '--phone-bar',
    '--dialog-top',
    '--dialog-bottom',
    '--stack-label',
    // ServiceMark sets the brand colour of one mark, and its dark-theme counterpart.
    '--mark-color',
    '--mark-color-dark',
    // The Reference maps the plugin page's sheet onto the tokens.
    '--pp-',
  ]);

  it('refers only to variables that exist', () => {
    const unknown: string[] = [];
    for (const [path, body] of text) {
      for (const match of body.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
        const name = match[1] ?? '';
        if (!defined.has(name) && !LOCAL.has(name) && !name.startsWith('--pp-')) {
          unknown.push(`${relative(SRC, path)}: ${name}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it('reads every alias: an alias nothing reads is removed', () => {
    const used = new Set<string>();
    for (const body of [...text.values(), ALIASES]) {
      for (const match of body.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) used.add(match[1] ?? '');
    }
    expect([...ALIAS.keys()].filter((name) => !used.has(name))).toEqual([]);
  });

  it('says the secondary size with `text-small`: `text-secondary` is a near-white colour', () => {
    const misread: string[] = [];
    for (const [path, body] of text) {
      if (!/\.tsx?$/.test(path) || path.endsWith('lib/utils.ts')) continue;
      if (/(?<![-\w])text-secondary\b(?!-)/.test(body)) misread.push(relative(SRC, path));
    }
    expect(misread).toEqual([]);
  });

  it('holds no raw colour outside the shared sheet', () => {
    const raw: string[] = [];
    for (const path of [...sheets, ALIASES_FILE]) {
      const body = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const match of body.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/g)) {
        raw.push(`${relative(SRC, path)}: ${match[0]}`);
      }
    }
    expect(raw).toEqual([]);
  });

  it('sets a font size with a token, or relative to its parent', () => {
    const raw: string[] = [];
    for (const path of sheets) {
      const body = (text.get(path) ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const match of body.matchAll(/font-size:\s*([^;]+);/g)) {
        const value = (match[1] ?? '').trim();
        // Marks (an avatar, a service mark, a check) size their letters with themselves.
        const mark = /Avatar\.module\.css$|States\.module\.css$/.test(path) && /px$/.test(value);
        if (!/^var\(--text-/.test(value) && !/^(inherit|[\d.]+em)$/.test(value) && !mark) {
          raw.push(`${relative(SRC, path)}: ${value}`);
        }
      }
    }
    expect(raw).toEqual([]);
  });
});
