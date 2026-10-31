/**
 * Structural test (`plugins/README.md`, step 11): a plugin's version is
 * written in two places, `definePlugin`'s `version` and its `package.json`,
 * always equal. Telemetry reports the first, the lockfile and a release read
 * the second; one version never designates two classifiers.
 *
 * A plugin's README states no version, neither the plugin's nor its
 * catalog's: a third copy is the one that drifts (eight of sixteen READMEs
 * did), and the versions are in `package.json` and `catalog_version` for
 * whoever needs them.
 *
 * Read from the plugins the image ships (`compose/shipped-plugins.ts`): each
 * shipped plugin's folder is its id.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SHIPPED_PLUGINS } from '../../../src/server/compose/shipped-plugins';
import { packageJsonOf, PLUGINS } from './plugin-sources';

/**
 * A sentence that gives a version: `Plugin version 3.0.0`, `version 0.4.0.`,
 * `catalog version 9`, `` `catalog_version: 8` ``, `` `src/risk-catalog.yaml`, version 2 ``.
 */
const VERSION_SENTENCE =
  /\bversion \d+\.\d+\.\d+|\bcatalog[ _]version:? \d|risk-catalog\.yaml`, version \d/i;

describe('a plugin states its version in definePlugin and package.json, equal, and nowhere else', () => {
  it('the image ships plugins at all', () => {
    expect(SHIPPED_PLUGINS.length).toBeGreaterThan(0);
  });

  describe.each(SHIPPED_PLUGINS.map((plugin) => [plugin.id, plugin] as const))(
    '%s',
    (id, plugin) => {
      it('has the version of its package.json', () => {
        expect(packageJsonOf(id)).toMatchObject({
          name: `@vaubaan/plugin-${id}`,
          version: plugin.version,
        });
      });

      it('states no version in its README, of the plugin or of its catalog', () => {
        const readme = join(PLUGINS, id, 'README.md');
        expect(existsSync(readme)).toBe(true);
        const stated = readFileSync(readme, 'utf8')
          .split('\n')
          .filter((line) => VERSION_SENTENCE.test(line));
        expect(stated).toEqual([]);
      });
    },
  );
});
