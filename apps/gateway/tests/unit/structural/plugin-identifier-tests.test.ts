/**
 * Structural test (ADR plugin-identifiers-one-grammar-for-classify-and-execute):
 * every plugin under `plugins/` — shipped, or the template a contributor
 * copies — has a test file that feeds hostile identifiers to **both** its
 * classifier and its executor.
 *
 * "What is executed is what was classified" is a property of each plugin and
 * is proven in each plugin's own tests. This file only holds that no plugin
 * is without that proof: a plugin added tomorrow fails here until it has one.
 * The directory is read, not listed; and every plugin the image ships must be
 * one of the directories found.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SHIPPED_PLUGINS } from '../../../src/server/compose/shipped-plugins';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const PLUGINS = join(REPO, 'plugins');

/** The dot segment, and at least one encoded or separator form: the values the defect lived on. */
const DOT_SEGMENT = /['"`]\.\.['"`]/;
const OTHER_HOSTILE = /%2e%2e|%2f|\.\.\/|\/\.\./i;

const pluginDirs = readdirSync(PLUGINS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(PLUGINS, entry.name, 'package.json')))
  .map((entry) => entry.name)
  .sort();

/** The unit test files of a plugin that exercise hostile identifiers on both sides. */
function identifierTestsOf(plugin: string): string[] {
  const dir = join(PLUGINS, plugin, 'tests/unit');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /\.test\.ts$/.test(name))
    .filter((name) => {
      const source = readFileSync(join(dir, name), 'utf8');
      return (
        DOT_SEGMENT.test(source) &&
        OTHER_HOSTILE.test(source) &&
        /classify/i.test(source) &&
        /execute/i.test(source)
      );
    });
}

describe('every plugin proves that what it executes is what it classified', () => {
  it('finds the plugins, the template among them, and every shipped one', () => {
    expect(pluginDirs).toContain('_template');
    expect(pluginDirs.length).toBeGreaterThanOrEqual(SHIPPED_PLUGINS.length + 1);
    const manifests = new Set(
      pluginDirs.map(
        (dir) =>
          (
            JSON.parse(readFileSync(join(PLUGINS, dir, 'package.json'), 'utf8')) as {
              name?: string;
            }
          ).name,
      ),
    );
    // Each shipped plugin is one of these directories: none is tested by omission.
    for (const plugin of SHIPPED_PLUGINS) {
      expect(
        manifests.has(`@vaubaan/plugin-${plugin.id}`),
        `no directory under plugins/ is the package of '${plugin.id}'`,
      ).toBe(true);
    }
  });

  it.each(pluginDirs)(
    '%s has a test feeding hostile identifiers to classify and to execute',
    (plugin) => {
      expect(identifierTestsOf(plugin)).not.toEqual([]);
    },
  );
});
