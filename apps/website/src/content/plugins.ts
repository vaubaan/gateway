/**
 * The plugin catalog of the site (website spec §2.3), built from the
 * repository at build time and nowhere else: a plugin is listed because its
 * folder exists under `plugins/`. Each plugin is loaded the way the gateway
 * loads it — its package's entry module, whose `definePlugin` validates the
 * declaration and whose catalog is read from `risk-catalog.yaml` by the
 * plugin SDK's loader — and reduced to plain data by the page's own builder,
 * `pluginInfo` of `@vaubaan/plugin-page/info`, the one the gateway's Reference
 * runs too. What is the site's alone is here: the folders, the packages, the
 * examples' source file, and where a screenshot of a connect guide is served.
 *
 * Folders whose name starts with `_` are kits, not plugins (`_template`):
 * `discoverPluginDirs` of `@vaubaan/plugin-page/load`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { pluginInfo, type PluginInfo } from '@vaubaan/plugin-page/info';
import { discoverPluginDirs, importPlugin } from '@vaubaan/plugin-page/load';
import { allSteps } from '@vaubaan/plugin-page/page-data';
import { GUIDE_SCREENSHOT_DIR, type ServicePlugin } from '@vaubaan/plugin-sdk';

import { siteDir } from './outputs';

export * from '@vaubaan/plugin-page/info';
export { allSteps } from '@vaubaan/plugin-page/page-data';
export { discoverPluginDirs, importPlugin } from '@vaubaan/plugin-page/load';

/** Where the site serves a screenshot of a plugin's connect guide. */
export function connectFigureSrc(pluginId: string, file: string): string {
  return `/plugins/${pluginId}/connect/${file}`;
}

/** The figures of a plugin, as `[public path, source file]` for the build to copy. */
export function connectFigureFiles(
  plugin: Pick<PluginInfo, 'dir' | 'credentials'>,
): [string, string][] {
  return plugin.credentials.flatMap((c) =>
    allSteps(c).flatMap((step) =>
      step.figure
        ? [
            [
              step.figure.src.replace(/^\//, ''),
              `${siteDir(plugin)}/${GUIDE_SCREENSHOT_DIR}/${step.figure.file}`,
            ] as [string, string],
          ]
        : [],
    ),
  );
}

/** The plain data of one plugin of the repository, as the site shows it. */
export function sitePluginInfo(
  plugin: ServicePlugin,
  dir: string,
  packageName: string,
  examplesSource: string | null = null,
): PluginInfo {
  return pluginInfo(plugin, { figureSrc: connectFigureSrc, dir, packageName, examplesSource });
}

/** Every plugin of the repository, sorted by id. */
export async function loadPlugins(repoRoot: string): Promise<PluginInfo[]> {
  const plugins: PluginInfo[] = [];
  for (const dir of discoverPluginDirs(repoRoot)) {
    const pkg = JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8')) as {
      name?: unknown;
    };
    const plugin = await importPlugin(repoRoot, dir);
    const examples = `${dir}/src/examples.ts`;
    plugins.push(
      sitePluginInfo(
        plugin,
        dir,
        typeof pkg.name === 'string' ? pkg.name : dir,
        existsSync(join(repoRoot, examples)) ? examples : null,
      ),
    );
  }
  return plugins.sort((a, b) => a.id.localeCompare(b.id));
}
