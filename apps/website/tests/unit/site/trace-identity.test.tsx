/**
 * The site in the Trace identity (intent recognise-vaubaan-at-a-glance, "Read
 * the site in the Trace identity"; style guide §3): the mark, the favicon and
 * the social card; the shared token sheet and components; the contrast pairs
 * of the shared test.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CONTRAST_PAIRS, TOKENS } from '@vaubaan/design-tokens';

import { Lockup, TRACE } from '../../../src/components/Lockup';
import { buttonVariants } from '../../../src/components/ui/button';

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (path: string) => readFileSync(join(SITE, path));
const GLOBALS = read('src/app/globals.css').toString('utf8');
const RULES = GLOBALS.replace(/\/\*[\s\S]*?\*\//g, '');

/** Width and height of a PNG, from its IHDR chunk. */
function pngSize(path: string): [number, number] {
  const png = read(path);
  expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

/** The colours of the token sheet the site's stylesheet reads. */
const used = new Set(
  [...RULES.matchAll(/var\(--([a-z0-9-]+)/g)]
    .map((m) => m[1]!)
    .filter((name) => TOKENS.some((t) => t.name === name)),
);

describe('the site in the Trace identity', () => {
  it('shows the Trace mark, its favicon and social card, and uses the accent #2F55C7 alone', () => {
    const svg = renderToStaticMarkup(<Lockup />);
    expect(svg).toContain(`d="${TRACE}"`);
    expect(svg).toContain('fill="currentColor"');
    // The favicon is the mark, ink on light paper and light on dark.
    const icon = read('src/app/icon.svg').toString('utf8');
    expect(icon).toContain('prefers-color-scheme:dark');
    expect(icon).toMatch(/<path d="M2 17\.50 L10\.50/);
    expect(pngSize('src/app/apple-icon.png')).toEqual([180, 180]);
    expect(pngSize('src/app/opengraph-image.png')).toEqual([1200, 630]);
    expect(read('src/app/opengraph-image.alt.txt').toString('utf8')).toMatch(/Vaubaan/);
    // One accent: the tokens' primary; the site's sheet writes no colour of its own.
    expect(TOKENS.find((t) => t.name === 'primary')?.light).toBe('#2f55c7');
    expect(RULES).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(RULES).not.toMatch(/\b(rgba?|hsla?|oklch|lab)\(/);
  });

  it('builds its pages from the shared token sheet and components, in light and dark', () => {
    expect(GLOBALS).toContain("@import 'tailwindcss';");
    expect(GLOBALS).toContain("@import '@vaubaan/design-tokens/tokens.css';");
    expect(GLOBALS).toContain("@import '@vaubaan/design-tokens/theme.css';");
    // Dark follows the system through the tokens: a `dark:` utility would not.
    expect(RULES).not.toMatch(/\bdark:/);
    expect(buttonVariants()).toContain('bg-primary');
    expect(buttonVariants({ variant: 'danger' })).toContain('text-destructive');
    expect(buttonVariants({ variant: 'danger' })).not.toMatch(/\bbg-destructive\b/);
    // The plugin page's rows are the four row tokens.
    for (const row of [1, 2, 3, 4]) {
      expect(GLOBALS).toContain(`--pp-row${row}-bg: var(--row-${row}-bg);`);
      expect(GLOBALS).toContain(`--pp-row${row}-ink: var(--row-${row}-fg);`);
    }
  });

  it("checks its contrast pairs with the same test as the interface's", () => {
    expect(used.size).toBeGreaterThan(20);
    for (const name of used) {
      // A hairline carries no information on its own (style guide §0).
      if (name.includes('border')) continue;
      const paired = CONTRAST_PAIRS.some((p) => p.fg === name || p.bg === name);
      expect(paired, `--${name} is in a documented pair of @vaubaan/design-tokens`).toBe(true);
    }
  });
});
