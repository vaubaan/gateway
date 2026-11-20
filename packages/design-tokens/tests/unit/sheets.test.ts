/**
 * The committed sheets are their render: a change of the palette is followed
 * by `npm run generate --workspace @vaubaan/design-tokens`.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { renderedSheets } from '../../src/render.ts';
import { TOKENS } from '../../src/palette.ts';

const ROOT = resolve(import.meta.dirname, '../..');

describe('the token sheets', () => {
  for (const [file, content] of Object.entries(renderedSheets())) {
    it(`${file} is the render of the palette (npm run generate)`, () => {
      expect(readFileSync(join(ROOT, file), 'utf8')).toBe(content);
    });
  }

  it("carry shadcn's names and a Tailwind colour for every token", () => {
    const theme = renderedSheets()['theme.css'];
    for (const name of [
      'background',
      'foreground',
      'primary',
      'muted-foreground',
      'ring',
      'sidebar',
    ]) {
      expect(
        TOKENS.some((t) => t.name === name),
        name,
      ).toBe(true);
    }
    for (const token of TOKENS)
      expect(theme).toContain(`--color-${token.name}: var(--${token.name});`);
  });

  it('declare the dark variant on the class and on data-theme, as the app switches it', () => {
    expect(renderedSheets()['theme.css']).toContain(
      "@custom-variant dark (&:where(.dark, .dark *, [data-theme='dark'], [data-theme='dark'] *));",
    );
  });
});
