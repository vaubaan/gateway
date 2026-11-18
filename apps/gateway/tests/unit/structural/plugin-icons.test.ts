/**
 * Structural test (ADR service-icons-declared-by-the-plugin): every plugin the image ships declares its
 * icon — the `d` of one SVG path on a 24×24 grid — and the brand colour it is
 * drawn in, so no service of this repository falls back to two letters on a
 * hue or to the plain ink, and the interface never keeps a list of service
 * icons or colours of its own.
 *
 * Read from the plugins the image ships (`compose/shipped-plugins.ts`), not
 * from a list kept here. `definePlugin` already refuses an icon that is not
 * path data; this holds the shipped plugins to *having* one, and to one that
 * fits the grid the mark is drawn on.
 */
import { HEX_COLOUR_PATTERN, SVG_PATH_DATA_PATTERN } from '@vaubaan/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { REPOSITORY_PLUGINS } from '../../support/plugins/repository';

const GRID = 24;
/** Every number of the path data, as written (`1.5`, `-.25`, `1e-3`). */
const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/gi;

describe('every shipped plugin declares the icon the interface shows it by', () => {
  it('the image ships plugins at all', () => {
    expect(REPOSITORY_PLUGINS.length).toBeGreaterThan(0);
  });

  describe.each(REPOSITORY_PLUGINS.map((plugin) => [plugin.id, plugin] as const))(
    '%s',
    (_id, plugin) => {
      it('declares an icon: the path data of one SVG path', () => {
        expect(plugin.icon).toEqual(expect.any(String));
        expect(plugin.icon).toMatch(SVG_PATH_DATA_PATTERN);
      });

      it('declares the brand colour it is drawn in: one #RRGGBB', () => {
        expect(plugin.iconColor).toEqual(expect.any(String));
        expect(plugin.iconColor).toMatch(HEX_COLOUR_PATTERN);
      });

      it('draws it on the 24-unit grid: no coordinate far outside it', () => {
        // Arc flags and relative moves are numbers too; a glyph drawn on a 24×24
        // grid has none beyond about twice the grid, a glyph drawn for another
        // grid (a 512×512 export) has many.
        const numbers = (plugin.icon ?? '').match(NUMBER) ?? [];
        expect(numbers.length).toBeGreaterThan(2);
        expect(numbers.map(Number).filter((n) => Math.abs(n) > GRID * 2)).toEqual([]);
      });
    },
  );
});
