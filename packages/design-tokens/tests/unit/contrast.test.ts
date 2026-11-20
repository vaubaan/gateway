/**
 * The contrast probe (style guide §6, §7): every documented pair, in both
 * themes, read from the shipped `tokens.css` — the OKLCH value as written,
 * converted back to sRGB here — never from the hex it was chosen as.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  contrastRatio,
  hexToRgb,
  oklchToRgb,
  parseOklch,
  rgbToHex,
  type Rgb,
} from '../../src/color.ts';
import { CONTRAST_PAIRS, TOKENS } from '../../src/palette.ts';

const SHEET = readFileSync(resolve(import.meta.dirname, '../../tokens.css'), 'utf8');

/** The declarations of the block opened by `selector`, as name → value. */
function block(selector: string): Map<string, string> {
  const start = SHEET.indexOf(`${selector} {`);
  expect(start, `block ${selector}`).toBeGreaterThanOrEqual(0);
  const body = SHEET.slice(start, SHEET.indexOf('}', start));
  const values = new Map<string, string>();
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) values.set(m[1]!, m[2]!.trim());
  return values;
}

const THEMES = {
  light: block(":root,\n.light,\n[data-theme='light']"),
  dark: block(".dark,\n[data-theme='dark']"),
} as const;
const SYSTEM_DARK = block(':root:not([data-theme]):not(.light)');

function colour(theme: keyof typeof THEMES, name: string): Rgb {
  const css = THEMES[theme].get(name);
  expect(css, `--${name} in the ${theme} theme`).toBeDefined();
  const oklch = parseOklch(css!);
  expect(oklch, `--${name}: ${css}`).not.toBeNull();
  return oklchToRgb(oklch!);
}

describe('the colour maths', () => {
  it('converts the ends of the scale exactly', () => {
    expect(rgbToHex(oklchToRgb({ l: 1, c: 0, h: 0 }))).toBe('#ffffff');
    expect(rgbToHex(oklchToRgb({ l: 0, c: 0, h: 0 }))).toBe('#000000');
    expect(contrastRatio([1, 1, 1], [0, 0, 0])).toBeCloseTo(21, 5);
  });

  it('gives back, within one step of 255, the hex each token was chosen as', () => {
    for (const theme of ['light', 'dark'] as const) {
      for (const token of TOKENS) {
        const shipped = hexToRgb(rgbToHex(colour(theme, token.name)));
        const chosen = hexToRgb(token[theme]);
        for (let i = 0; i < 3; i += 1) {
          const steps = Math.round(Math.abs(shipped[i]! - chosen[i]!) * 255);
          expect(steps, `${theme} --${token.name}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('the documented contrast pairs', () => {
  it('name tokens of the sheet', () => {
    const names = new Set(TOKENS.map((t) => t.name));
    for (const pair of CONTRAST_PAIRS) {
      expect(names.has(pair.fg), pair.fg).toBe(true);
      expect(names.has(pair.bg), pair.bg).toBe(true);
    }
  });

  for (const theme of ['light', 'dark'] as const) {
    it(`reach 4.5:1 for text and 3:1 for marks and boundaries, in the ${theme} theme`, () => {
      for (const { fg, bg, target, use } of CONTRAST_PAIRS) {
        const ratio = contrastRatio(colour(theme, fg), colour(theme, bg));
        expect(ratio, `${theme}: ${fg} on ${bg} (${use})`).toBeGreaterThanOrEqual(target);
      }
    });
  }

  it('keep the row words, the gates and the refusal at AA on the paper and the card', () => {
    const needed = [
      ['row-1-fg', 'row-1-bg'],
      ['row-2-fg', 'row-2-bg'],
      ['row-3-fg', 'row-3-bg'],
      ['row-4-fg', 'row-4-bg'],
      ['approval-fg', 'approval-bg'],
      ['allowed-fg', 'allowed-bg'],
      ['refused-fg', 'card'],
      ['primary', 'background'],
      ['primary-ink', 'primary-soft'],
      ['muted-foreground', 'background'],
    ];
    for (const [fg, bg] of needed) {
      const pair = CONTRAST_PAIRS.find((p) => p.fg === fg && p.bg === bg);
      expect(pair?.target, `${fg} on ${bg}`).toBe(4.5);
    }
  });
});

describe('the themes', () => {
  it('give the system preference the very values of the chosen dark theme', () => {
    expect([...SYSTEM_DARK]).toEqual([...THEMES.dark]);
  });

  it('define every token in both themes', () => {
    for (const theme of ['light', 'dark'] as const) {
      expect(
        [...THEMES[theme].keys()].filter((n) => n !== 'radius' && n !== 'shadow-overlay'),
      ).toEqual(TOKENS.map((t) => t.name));
    }
  });
});

describe('the accent', () => {
  it('is #2F55C7, and no orange or yellow is left in the palette', () => {
    const primary = TOKENS.find((t) => t.name === 'primary');
    expect(primary?.light).toBe('#2f55c7');
    for (const token of TOKENS) {
      for (const theme of ['light', 'dark'] as const) {
        const [r, g, b] = hexToRgb(token[theme]);
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        if (max - min < 0.15) continue; // a grey
        const hue =
          r === max
            ? (60 * ((g - b) / (max - min)) + 360) % 360
            : g === max
              ? 60 * ((b - r) / (max - min)) + 120
              : 60 * ((r - g) / (max - min)) + 240;
        expect(
          hue >= 20 && hue <= 70,
          `${theme} --${token.name} ${token[theme]} hue ${hue.toFixed(0)}`,
        ).toBe(false);
      }
    }
  });
});
