/**
 * The interface reads its colours, sizes and radii from the shared sheet
 * (`@vaubaan/design-tokens`; style guide §3, §7; ADR
 * design-system-on-shadcn-shared-by-the-app-and-the-site). The contrast of
 * every documented pair, in both themes, is the package's own test
 * (`packages/design-tokens/tests/unit/contrast.test.ts`); these check what
 * the interface does with it:
 *
 * - the one global sheet imports Tailwind and the shared sheets, the theme one
 *   `theme(static)` so an arbitrary value can read a shared size;
 * - no other style sheet exists: components style themselves with utilities;
 * - no style refers to a variable that does not exist (the former names are gone);
 * - no raw colour is written in a class or a sheet, and `text-secondary` (a
 *   colour) is never used for the secondary size, `text-small`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOKENS } from '@vaubaan/design-tokens';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../../../src');
const PACKAGE = resolve(HERE, '../../../../../packages/design-tokens');
const GLOBALS_FILE = resolve(SRC, 'app/globals.css');
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
  });

  it('never redefine a shared name', () => {
    expect([...MEASURES.keys()].filter((name) => SHARED_NAMES.has(name))).toEqual([]);
  });

  it('have one accent, and no orange or yellow in either theme', () => {
    expect(TOKENS.find((token) => token.name === 'primary')?.light).toBe('#2f55c7');
    expect(GLOBALS.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/amber|orange|yellow|sky/i);
  });
});

describe('the styles of the interface', () => {
  const sources = files(SRC, /\.tsx?$/).filter((path) => !/\.test\.tsx?$/.test(path));
  const text = new Map(sources.map((path) => [path, readFileSync(path, 'utf8')]));
  const defined = new Set([...SHARED_NAMES, ...MEASURES.keys(), ...TAILWIND]);
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
  ]);

  it('has one style sheet, the global one', () => {
    expect(files(SRC, /\.css$/).map((path) => relative(SRC, path))).toEqual(['app/globals.css']);
  });

  it('refers only to variables that exist', () => {
    const unknown: string[] = [];
    for (const [path, body] of [...text, [GLOBALS_FILE, GLOBALS] as const]) {
      for (const match of body.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
        const name = match[1] ?? '';
        // The Reference maps the plugin page's sheet (`--pp-*`) onto the tokens.
        if (!defined.has(name) && !LOCAL.has(name) && !name.startsWith('--pp-')) {
          unknown.push(`${relative(SRC, path)}: ${name}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it('says the secondary size with `text-small`: `text-secondary` is a near-white colour', () => {
    const misread: string[] = [];
    for (const [path, body] of text) {
      if (/(?<![-\w])text-secondary\b(?!-)/.test(body)) misread.push(relative(SRC, path));
    }
    expect(misread).toEqual([]);
  });

  it('writes no raw colour in a class or in the global sheet', () => {
    const raw: string[] = [];
    const body = GLOBALS.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of body.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/g)) {
      raw.push(`app/globals.css: ${match[0]}`);
    }
    for (const [path, source] of text) {
      // An arbitrary value in a class: `[color:#fff]`, `bg-[#fff]`, `[box-shadow:0_0_rgba(…)]`.
      for (const match of source.matchAll(/\[[^\]\s'"]*(?:#[0-9a-fA-F]{3,8}|rgba?\(|oklch\()/g)) {
        raw.push(`${relative(SRC, path)}: ${match[0]}`);
      }
    }
    expect(raw).toEqual([]);
  });
});
