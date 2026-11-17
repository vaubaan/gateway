/**
 * The manifest `npm pack` and `npm publish` ship, swapped in around the pack.
 *
 *   node scripts/publish-manifest.ts apply     (prepack)  keeps the repository's
 *                                              manifest aside and writes the
 *                                              published one : `exports` and
 *                                              `types` from `publishConfig`,
 *                                              pointing at the built `dist/`
 *   node scripts/publish-manifest.ts restore   (postpack) puts the repository's
 *                                              manifest back
 *
 * Why : inside the repository every workspace imports the SDK's TypeScript
 * sources (`exports` → `./src/*.ts`) ; a published package must point at the
 * built JavaScript and declarations. pnpm and Yarn apply `publishConfig.exports`
 * themselves ; npm does not, so the swap does it. `apply` refuses a manifest
 * whose published entries are not built. Handbook : docs/handbook/plugin-sdk.md.
 */

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { INLINED } from './build.ts';

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(PACKAGE, 'package.json');
const KEPT = join(PACKAGE, 'package.repo.json');

interface Manifest {
  dependencies?: Record<string, string>;
  exports?: unknown;
  types?: unknown;
  publishConfig?: { exports?: Record<string, { types: string; default: string }>; types?: string };
  [key: string]: unknown;
}

/**
 * The published `dependencies`: the workspace packages `build.ts` compiles into `dist/`
 * are left out, they ship inside the package. Pure.
 */
export function publishedDependencies(
  dependencies: Record<string, string> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dependencies ?? {}).filter(([name]) => !(name in INLINED)),
  );
}

function apply(): void {
  if (existsSync(KEPT)) throw new Error(`${KEPT} exists: run 'restore' first`);
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;
  const published = manifest.publishConfig?.exports;
  if (!published) throw new Error('package.json: publishConfig.exports is missing');
  const missing = Object.values(published)
    .flatMap((entry) => [entry.types, entry.default])
    .filter((file) => !existsSync(join(PACKAGE, file)));
  if (missing.length > 0) throw new Error(`not built: ${missing.join(', ')} (npm run build)`);
  copyFileSync(MANIFEST, KEPT);
  const { publishConfig, ...rest } = manifest;
  const { exports: _exports, types: _types, ...config } = publishConfig ?? {};
  const out: Manifest = {
    ...rest,
    dependencies: publishedDependencies(manifest.dependencies),
    exports: published,
    ...(publishConfig?.types ? { types: publishConfig.types } : {}),
    publishConfig: config,
  };
  writeFileSync(MANIFEST, `${JSON.stringify(out, null, 2)}\n`);
}

function restore(): void {
  if (existsSync(KEPT)) renameSync(KEPT, MANIFEST);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const command = process.argv[2];
  if (command === 'apply') apply();
  else if (command === 'restore') restore();
  else throw new Error('usage: node scripts/publish-manifest.ts apply | restore');
}
