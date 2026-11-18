/**
 * What `npm pack` and `npm publish` ship of `@vaubaan/plugin-cli`, built around the pack.
 *
 *   node scripts/package.ts build     dist/cli.js and dist/index.js, bundled by esbuild for
 *                                     Node (the SDK and esbuild stay dependencies), and
 *                                     template/: plugins/_template's src/ and tests/, the
 *                                     plugin every `vaubaan-plugin init` starts from
 *   node scripts/package.ts apply     (prepack) keeps the repository's manifest aside and
 *                                     writes the published one: `bin` and `exports` on dist/,
 *                                     the SDK at the version it is in this repository
 *   node scripts/package.ts restore   (postpack) puts the repository's manifest back
 *
 * Why: inside the repository the CLI runs from its TypeScript (`tsx`, or Node's own
 * stripping) and imports the SDK's sources; a published package runs plain JavaScript
 * against the published SDK. Same swap as packages/plugin-sdk/scripts/publish-manifest.ts.
 */

import { cpSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(PACKAGE, '..', '..');
const MANIFEST = join(PACKAGE, 'package.json');
const KEPT = join(PACKAGE, 'package.repo.json');
const SDK_MANIFEST = join(REPO, 'packages', 'plugin-sdk', 'package.json');

/** Bundled into dist/; the rest of the dependencies are installed beside the CLI. */
const EXTERNAL = ['@vaubaan/plugin-sdk', '@vaubaan/plugin-sdk/*', 'esbuild'];

interface Manifest {
  private?: boolean;
  bin?: Record<string, string>;
  exports?: unknown;
  dependencies?: Record<string, string>;
  files?: string[];
  [key: string]: unknown;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

async function buildPackage(): Promise<void> {
  rmSync(join(PACKAGE, 'dist'), { recursive: true, force: true });
  await build({
    entryPoints: { cli: join(PACKAGE, 'src', 'bin.ts'), index: join(PACKAGE, 'src', 'index.ts') },
    outdir: join(PACKAGE, 'dist'),
    bundle: true,
    splitting: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: EXTERNAL,
    logLevel: 'warning',
  });
  const template = join(PACKAGE, 'template');
  rmSync(template, { recursive: true, force: true });
  for (const folder of ['src', 'tests']) {
    cpSync(join(REPO, 'plugins', '_template', folder), join(template, folder), { recursive: true });
  }
}

/** The published manifest of `repository`, given the SDK's version. Pure. */
export function publishedManifest(repository: Manifest, sdkVersion: string): Manifest {
  const { private: _private, ...rest } = repository;
  void _private;
  return {
    ...rest,
    bin: { 'vaubaan-plugin': './dist/cli.js' },
    exports: { '.': './dist/index.js' },
    files: ['dist', 'template', 'scaffold', 'README.md'],
    dependencies: {
      ...repository.dependencies,
      '@vaubaan/plugin-sdk': `^${sdkVersion}`,
    },
  };
}

function apply(): void {
  for (const built of [
    'dist/cli.js',
    'dist/index.js',
    'template/src/index.ts',
    'scaffold/AGENTS.md',
  ]) {
    if (!existsSync(join(PACKAGE, built))) {
      throw new Error(`${built} is missing: run \`node scripts/package.ts build\` first`);
    }
  }
  if (existsSync(KEPT)) throw new Error(`${KEPT} exists: a previous pack did not restore`);
  const repository = readJson<Manifest>(MANIFEST);
  const sdk = readJson<{ version: string }>(SDK_MANIFEST);
  renameSync(MANIFEST, KEPT);
  writeFileSync(
    MANIFEST,
    `${JSON.stringify(publishedManifest(repository, sdk.version), null, 2)}\n`,
  );
}

function restore(): void {
  if (existsSync(KEPT)) renameSync(KEPT, MANIFEST);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const command = process.argv[2];
  if (command === 'build') await buildPackage();
  else if (command === 'apply') apply();
  else if (command === 'restore') restore();
  else {
    console.error('usage: node scripts/package.ts build | apply | restore');
    process.exitCode = 2;
  }
}
