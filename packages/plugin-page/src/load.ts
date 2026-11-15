/**
 * The plugins of a repository checkout, loaded as the gateway loads them:
 * each `plugins/<name>` folder holding a `package.json` (a name starting with
 * `_` is a kit, `_template`), imported through its package's entry module,
 * whose `definePlugin` validates the declaration and whose catalog the plugin
 * SDK's loader reads. The public site's generator and this package's tests
 * use it; a running gateway has its registry instead. Node only.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ServicePlugin } from '@vaubaan/plugin-sdk';

/** `plugins/<name>` folders that hold a plugin: a `package.json`, a name not starting with `_`. */
export function discoverPluginDirs(repoRoot: string): string[] {
  const base = join(repoRoot, 'plugins');
  return readdirSync(base)
    .filter((name) => !name.startsWith('_') && !name.startsWith('.'))
    .filter((name) => statSync(join(base, name)).isDirectory())
    .filter((name) => existsSync(join(base, name, 'package.json')))
    .sort()
    .map((name) => `plugins/${name}`);
}

interface PackageJson {
  readonly name?: unknown;
  readonly exports?: unknown;
}

function entryModuleOf(pkg: PackageJson, dir: string): string {
  const exports = pkg.exports;
  const entry =
    typeof exports === 'string'
      ? exports
      : typeof exports === 'object' && exports !== null
        ? (exports as Record<string, unknown>)['.']
        : undefined;
  if (typeof entry !== 'string') throw new Error(`${dir}/package.json: no "exports" entry`);
  return entry;
}

function isPlugin(value: unknown): value is ServicePlugin {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ServicePlugin>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.version === 'string' &&
    Array.isArray(candidate.tools) &&
    typeof candidate.catalog === 'object'
  );
}

/** Imports the plugin of a folder through its package entry and returns its declaration. */
export async function importPlugin(repoRoot: string, dir: string): Promise<ServicePlugin> {
  const pkgPath = join(repoRoot, dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageJson;
  const entry = entryModuleOf(pkg, dir);
  const mod = (await import(pathToFileURL(join(repoRoot, dir, entry)).href)) as {
    default?: unknown;
  };
  if (!isPlugin(mod.default)) throw new Error(`${dir}: the entry module exports no plugin`);
  return mod.default;
}
