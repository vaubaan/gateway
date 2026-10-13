/**
 * The tokens are the specification of the look (style guide §7): these tests
 * check what must hold of them, not "this button is blue".
 *
 * - the two dark blocks (chosen, and from the system) hold the same values;
 * - every documented pair of text and surface meets WCAG AA in both themes;
 * - every token is used somewhere, and no style refers to a token that does
 *   not exist (the tokens of the first interface are gone);
 * - a style sheet holds no raw colour: colours live in `tokens.css` only.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../../../src');
const TOKENS_FILE = resolve(SRC, 'styles/tokens.css');
const TOKENS = readFileSync(TOKENS_FILE, 'utf8');

/** The declarations of the block that starts at `selector {`, as name → value. */
function block(selector: string, from = 0): Map<string, string> {
  const start = TOKENS.indexOf(`${selector} {`, from);
  if (start < 0) throw new Error(`no rule for ${selector}`);
  const body = TOKENS.slice(TOKENS.indexOf('{', start) + 1, TOKENS.indexOf('}', start));
  const declarations = new Map<string, string>();
  for (const match of body.matchAll(/(--[a-z0-9-]+|color-scheme):\s*([^;]+);/g)) {
    declarations.set(match[1] ?? '', (match[2] ?? '').replace(/\s+/g, ' ').trim());
  }
  return declarations;
}

const LIGHT = block(":root,\n[data-theme='light']");
const DARK = block("\n[data-theme='dark']");
const SYSTEM_DARK = block(':root:not([data-theme])');
const BASE = block(':root');

function files(dir: string, test: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, test, out);
    else if (test.test(name)) out.push(path);
  }
  return out;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
  const [r, g, b] = channels.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** Text on surface, as the components pair them. Every pair is body-size text: AA is 4.5. */
const PAIRS: readonly (readonly [text: string, surface: string])[] = [
  ['--ink', '--paper'],
  ['--ink', '--paper-side'],
  ['--ink', '--fill'],
  ['--ink-2', '--paper'],
  ['--ink-2', '--paper-side'],
  ['--ink-2', '--fill'],
  ['--ink-2', '--warn-soft'],
  ['--ink-3', '--paper'],
  ['--ink-3', '--paper-side'],
  ['--ink-3', '--fill'],
  ['--accent', '--paper'],
  ['--accent', '--paper-side'],
  ['--accent', '--accent-soft'],
  ['--on-accent', '--accent'],
  ['--on-accent', '--accent-ink'],
  ['--warn', '--paper'],
  ['--warn', '--warn-soft'],
  ['--on-warn', '--warn'],
  ['--bad', '--paper'],
  ['--bad', '--bad-soft'],
  ['--ok', '--paper'],
  ['--ok', '--ok-soft'],
  ['--paper', '--ink'],
  ['--code-ink', '--code-bg'],
  ['--code-dim', '--code-bg'],
  ['--code-ink', '--code-btn'],
];

const AA = 4.5;

describe('the design tokens', () => {
  it('defines light as the default and dark for a chosen theme and for the system', () => {
    expect(LIGHT.get('color-scheme')).toBe('light');
    expect(DARK.get('color-scheme')).toBe('dark');
    expect(SYSTEM_DARK.get('color-scheme')).toBe('dark');
    expect(TOKENS).toContain('@media (prefers-color-scheme: dark)');
  });

  it('keeps the two dark blocks identical, and gives both themes the same tokens', () => {
    expect([...SYSTEM_DARK]).toEqual([...DARK]);
    expect([...DARK.keys()].sort()).toEqual([...LIGHT.keys()].sort());
  });

  it('has four text sizes and two weights, and no more', () => {
    const sizes = [...BASE.keys()].filter((name) => name.startsWith('--text-'));
    expect(sizes).toEqual(['--text-xs', '--text-sm', '--text-base', '--text-title']);
    expect(sizes.map((name) => BASE.get(name))).toEqual([
      '0.75rem',
      '0.8125rem',
      '0.875rem',
      '1.25rem',
    ]);
    const weights = [...BASE.keys()].filter((name) => name.startsWith('--weight-'));
    expect(weights.map((name) => BASE.get(name))).toEqual(['400', '600']);
  });

  describe.each([
    ['light', LIGHT],
    ['dark', DARK],
  ] as const)('in the %s theme', (_name, theme) => {
    it.each(PAIRS)('%s on %s meets AA', (text, surface) => {
      const fg = theme.get(text);
      const bg = theme.get(surface);
      expect(fg, text).toMatch(/^#[0-9a-f]{6}$/);
      expect(bg, surface).toMatch(/^#[0-9a-f]{6}$/);
      expect(contrast(fg ?? '', bg ?? '')).toBeGreaterThanOrEqual(AA);
    });

    it('keeps the placeholder ink below the text inks on purpose, and above the hairline', () => {
      const paper = theme.get('--paper') ?? '';
      expect(contrast(theme.get('--ink-4') ?? '', paper)).toBeLessThan(AA);
      expect(contrast(theme.get('--ink-4') ?? '', paper)).toBeGreaterThan(
        contrast(theme.get('--line-strong') ?? '', paper),
      );
    });
  });

  it('gives a white letter enough contrast on every mark hue', () => {
    const onHue = BASE.get('--on-hue') ?? '';
    for (const name of ['--hue-0', '--hue-1', '--hue-2', '--hue-3', '--hue-4', '--hue-5']) {
      expect(contrast(onHue, BASE.get(name) ?? ''), name).toBeGreaterThanOrEqual(AA);
    }
  });
});

describe('the styles of the interface', () => {
  const sheets = files(SRC, /\.css$/).filter((path) => path !== TOKENS_FILE);
  const sources = [
    ...sheets,
    ...files(SRC, /\.tsx?$/).filter((path) => !/\.test\.tsx?$/.test(path)),
  ];
  const text = new Map(sources.map((path) => [path, readFileSync(path, 'utf8')]));
  const defined = new Set(
    [...BASE.keys(), ...LIGHT.keys()].filter((name) => name.startsWith('--')),
  );
  /** Variables a component sets for itself, or that come from outside the token sheet. */
  const LOCAL = new Set([
    '--font-geist-sans',
    '--font-geist-mono',
    '--tone',
    '--tone-bg',
    '--tone-fg',
    '--bar-height',
  ]);

  it('refers only to tokens that exist', () => {
    const unknown: string[] = [];
    for (const [path, body] of text) {
      for (const match of body.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
        const name = match[1] ?? '';
        if (!defined.has(name) && !LOCAL.has(name)) unknown.push(`${relative(SRC, path)}: ${name}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it('uses every token: a token nothing reads is removed', () => {
    const used = new Set<string>();
    for (const body of [...text.values(), TOKENS]) {
      for (const match of body.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) used.add(match[1] ?? '');
    }
    expect([...defined].filter((name) => !used.has(name))).toEqual([]);
  });

  it('holds no raw colour outside the token sheet', () => {
    const raw: string[] = [];
    for (const path of sheets) {
      const body = (text.get(path) ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
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
