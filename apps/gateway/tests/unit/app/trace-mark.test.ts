/**
 * The app wears the Trace brand of the site: the same symbol, the same icons
 * (ADR design-system-on-shadcn-shared-by-the-app-and-the-site; intent
 * recognise-vaubaan-at-a-glance). The site's sources are the reference.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOKENS } from '@vaubaan/design-tokens';
import { describe, expect, it } from 'vitest';

import { TRACE } from '@/lib/brand';
import { PRODUCT } from '@/lib/vocabulary';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '../../..');
const SITE = resolve(HERE, '../../../../website');

describe('the Trace brand in the app', () => {
  it('draws the symbol of the site', () => {
    const lockup = readFileSync(resolve(SITE, 'src/components/Lockup.tsx'), 'utf8');
    expect(lockup).toContain(`'${TRACE}'`);
    expect(Object.keys(PRODUCT)).toEqual(['name']);
  });

  it('paints the demo sign-in page in the shared palette only', () => {
    const page = readFileSync(resolve(APP, 'tests/demo/demo-idp.ts'), 'utf8');
    const palette = new Set(TOKENS.flatMap((token) => [token.light, token.dark]));
    const colours = page.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
    expect(colours.length).toBeGreaterThan(5);
    expect(colours.filter((colour) => !palette.has(colour.toLowerCase()))).toEqual([]);
    expect(page).not.toMatch(/rgba?\(/);
  });

  it('serves the icons of the site', () => {
    for (const name of ['icon.svg', 'apple-icon.png']) {
      expect(readFileSync(resolve(APP, 'src/app', name))).toEqual(
        readFileSync(resolve(SITE, 'src/app', name)),
      );
    }
    expect(readFileSync(resolve(APP, 'public/logo-vaubaan.svg'))).toEqual(
      readFileSync(resolve(SITE, 'src/app/icon.svg')),
    );
  });
});
