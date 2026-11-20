/**
 * The site's drawings (website spec §2.1; `drawings/gen.py`): drawn from the
 * catalogs as they are today, in the shared palette, light and dark, for both
 * projects, each with its text alternative, and served by the site.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TOKENS } from '@vaubaan/design-tokens';

import { DRAWING_FACTS_FILE, drawingFacts } from '../../../src/content/drawing-facts';
import { loadPlugins } from '../../../src/content/plugins';
import { REPO_ROOT } from '../../../src/content/repo';
import { DRAWING_NAMES, drawingAssets, drawingInfo, PROJECTS } from '../../../src/site/drawings';

const REGENERATE =
  'npx tsx apps/website/scripts/drawing-facts.ts && python3 apps/website/drawings/gen.py';

describe('the drawings', () => {
  it(`are drawn from the catalogs as they are today (else: ${REGENERATE})`, async () => {
    const committed: unknown = JSON.parse(
      readFileSync(join(REPO_ROOT, DRAWING_FACTS_FILE), 'utf8'),
    );
    expect(committed).toEqual(
      JSON.parse(JSON.stringify(drawingFacts(await loadPlugins(REPO_ROOT)))),
    );
  }, 60_000);

  it('use the shared tokens only: one accent, red for refused, no orange or yellow', () => {
    const prims = readFileSync(join(REPO_ROOT, 'apps/website/drawings/prims.py'), 'utf8');
    const palette = prims.slice(prims.indexOf('THEMES = {'), prims.indexOf('CLASSES = {'));
    const colours = [...palette.matchAll(/'(#[0-9A-Fa-f]{6})'/g)].map((m) => m[1]!.toLowerCase());
    expect(colours.length).toBeGreaterThan(60);
    const tokens = new Set(TOKENS.flatMap((t) => [t.light.toLowerCase(), t.dark.toLowerCase()]));
    expect(colours.filter((c) => !tokens.has(c))).toEqual([]);
  });

  it('exist in both projects and both themes, each with its text alternative, and are served', () => {
    for (const name of DRAWING_NAMES) {
      for (const project of PROJECTS) {
        const info = drawingInfo(name, project);
        expect(info.desc.length, `${name} ${project}`).toBeGreaterThan(60);
        expect(info.w).toBe(1200);
      }
    }
    const assets = drawingAssets();
    expect(assets).toHaveLength(DRAWING_NAMES.length * PROJECTS.length * 2);
    for (const [path, source] of assets) {
      expect(path).toMatch(/^drawings\/[a-z-]+-(light|dark)\.svg$/);
      expect(existsSync(join(REPO_ROOT, source)), source).toBe(true);
    }
  });

  it('promise nothing that is not built', () => {
    for (const [, source] of drawingAssets()) {
      const svg = readFileSync(join(REPO_ROOT, source), 'utf8');
      // The desktop app and a one-command local install are planned (website spec §2.2).
      expect(svg, source).not.toMatch(/macOS · Windows|localhost|Download/);
      expect(svg, source).not.toContain('Repairable, worth a look');
    }
  });
});
