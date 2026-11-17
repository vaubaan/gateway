#!/usr/bin/env node
// Builds the pinnable bundle of one or more bundled plugins (ADR
// plugins-bundled-or-pinned-by-the-operator; docs/handbook/plugin-loading.md).
//
//   node scripts/build-plugin-bundle.mjs <id> [<id>…] [--out dist/plugins]
//   node scripts/build-plugin-bundle.mjs --all [--out dist/plugins]
//
// For each plugin, writes <out>/<id>/:
//
//   index.js            plugins/<id>/src/index.ts bundled by esbuild: one ESM file for
//                       Node 26, every dependency inside, the SDK included (a pinned
//                       plugin carries its own SDK copy; the host reads its errors by
//                       brand, never by instanceof)
//   *.yaml              the files the plugin reads beside its module (risk-catalog.yaml,
//                       through catalogPathNextTo); JSON imports are inlined by esbuild
//   package.json        name @vaubaan/plugin-<id>, the plugin's version, type module,
//                       exports ".", peerDependencies["@vaubaan/plugin-sdk"]: ^<SDK version>
//   LICENSE, README.md
//   docs/connect/       the screenshots of the connect guide, when the plugin has any
//                       (`GUIDE_SCREENSHOT_DIR`; the host serves them from the pin)
//
//   vaubaan-manifest.json  the sha256 of every other file (what a signature covers)
//
// then imports the bundle under plain Node in a child process and checks that its
// default export is a plugin of that id and version (the smoke test). The build itself
// is `buildArchive` of @vaubaan/plugin-cli, the same one a plugin author runs as
// `vaubaan-plugin build`; this script adds the repository's ids, licence and --all.
//
// A plugin whose dependency needs a native addon declares in its package.json
//   "vaubaan": { "bundleable": false, "reason": "<one line>" }
// and is skipped, said so on stderr; it stays a bundled plugin of the image.
// `--all` takes every plugin of plugins/ but _template. Exit 1 when a bundleable plugin
// fails to build or to import; the release workflow runs this before publishing the
// images (deploy/docker/plugin.Dockerfile).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { archivePackage, buildArchive, notBundleableReason } from '@vaubaan/plugin-cli';

export { notBundleableReason };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS = join(ROOT, 'plugins');
const SDK_MANIFEST = join(ROOT, 'packages/plugin-sdk/package.json');
const TEMPLATE = '_template';
const USAGE = 'usage: node scripts/build-plugin-bundle.mjs (<id>… | --all) [--out <dir>]';

export class BundleError extends Error {}

/**
 * The package.json of a bundled plugin's archive: the repository names every plugin
 * `@vaubaan/plugin-<id>` under the project's licence. Pure.
 * @param {{ name: string, version: string, description?: string, license?: string }} manifest the plugin's package.json
 * @param {string} id
 * @param {string} sdkVersion
 */
export function bundleManifest(manifest, id, sdkVersion) {
  return archivePackage(
    { ...manifest, name: `@vaubaan/plugin-${id}`, license: manifest.license ?? 'Apache-2.0' },
    sdkVersion,
  );
}

/**
 * Parses the command line. Pure.
 * @param {string[]} argv
 */
export function parseArguments(argv) {
  const ids = [];
  let out = 'dist/plugins';
  let all = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--out') {
      out = argv[index + 1] ?? '';
      index += 1;
      if (out === '') throw new BundleError(`--out needs a directory\n${USAGE}`);
    } else if (argument === '--all') {
      all = true;
    } else if (argument.startsWith('--')) {
      throw new BundleError(`unknown option ${argument}\n${USAGE}`);
    } else {
      ids.push(argument);
    }
  }
  if (all === ids.length > 0) throw new BundleError(USAGE);
  return { ids, out, all };
}

/**
 * @param {string} path
 * @returns {Record<string, any>}
 */
function readJson(path) {
  /** @type {Record<string, any>} */
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return parsed;
}

/** Every plugin id of plugins/ but the template, sorted. */
export function allPluginIds() {
  return readdirSync(PLUGINS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== TEMPLATE)
    .filter((entry) => existsSync(join(PLUGINS, entry.name, 'package.json')))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Builds one plugin's bundle into `<out>/<id>/`. Returns what was built, or the
 * reason it was skipped.
 * @param {string} id
 * @param {{ out: string, sdkVersion: string, esbuild: typeof import('esbuild') }} options
 */
export async function buildPluginBundle(id, { out, sdkVersion, esbuild }) {
  const source = join(PLUGINS, id);
  if (!existsSync(join(source, 'package.json'))) {
    throw new BundleError(`${id}: no plugins/${id}/package.json`);
  }
  let result;
  try {
    result = await buildArchive({
      pluginDir: source,
      outDir: join(out, id),
      esbuild,
      sdkVersion,
      licenseFile: join(ROOT, 'LICENSE'),
    });
  } catch (err) {
    throw new BundleError(`${id}: ${err.message}`);
  }
  if ('skipped' in result) return { id, skipped: result.skipped };
  if (result.id !== id) {
    throw new BundleError(`${id}: the bundle's plugin is ${result.id}, expected ${id}`);
  }
  return { id, version: result.version, path: result.path };
}

async function main() {
  const { ids, out, all } = parseArguments(process.argv.slice(2));
  const esbuild = await import('esbuild');
  const sdkVersion = readJson(SDK_MANIFEST).version;
  const outDir = resolve(ROOT, out);
  let failed = false;
  for (const id of all ? allPluginIds() : ids) {
    try {
      const result = await buildPluginBundle(id, { out: outDir, sdkVersion, esbuild });
      if ('skipped' in result) {
        console.error(`skipped ${id}: not bundleable (${result.skipped})`);
      } else {
        console.log(`built ${id} ${result.version} → ${result.path}`);
      }
    } catch (err) {
      failed = true;
      console.error(err instanceof BundleError ? err.message : `${id}: ${err.stack ?? err}`);
    }
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof BundleError ? err.message : err);
    process.exitCode = 1;
  });
}
