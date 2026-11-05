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
//
// then imports the bundle under plain Node in a child process and checks that its
// default export is a plugin of that id and version (the smoke test).
//
// A plugin whose dependency needs a native addon declares in its package.json
//   "vaubaan": { "bundleable": false, "reason": "<one line>" }
// and is skipped, said so on stderr; it stays a bundled plugin of the image.
// `--all` takes every plugin of plugins/ but _template. Exit 1 when a bundleable plugin
// fails to build or to import; the release workflow runs this before publishing the
// images (deploy/docker/plugin.Dockerfile).
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS = join(ROOT, 'plugins');
const SDK_MANIFEST = join(ROOT, 'packages/plugin-sdk/package.json');
const SDK_PACKAGE = '@vaubaan/plugin-sdk';
const TEMPLATE = '_template';
const USAGE = 'usage: node scripts/build-plugin-bundle.mjs (<id>… | --all) [--out <dir>]';
// esbuild's ESM output has no `require`; a CommonJS dependency that requires a Node
// builtin needs one (the same shim every Node ESM bundle carries).
const REQUIRE_SHIM =
  "import { createRequire as __vaubaanCreateRequire } from 'node:module';\n" +
  'const require = __vaubaanCreateRequire(import.meta.url);';

export class BundleError extends Error {}

/**
 * The package.json of a bundle, from the plugin's own. Pure.
 * @param {{ name: string, version: string }} manifest the plugin's package.json
 * @param {string} id
 * @param {string} sdkVersion
 */
export function bundleManifest(manifest, id, sdkVersion) {
  return {
    name: `@vaubaan/plugin-${id}`,
    version: manifest.version,
    description: manifest.description,
    type: 'module',
    exports: { '.': './index.js' },
    peerDependencies: { [SDK_PACKAGE]: `^${sdkVersion}` },
    license: 'Apache-2.0',
  };
}

/**
 * `null` when the plugin can be bundled, else the reason it declares. Pure.
 * @param {{ vaubaan?: { bundleable?: unknown, reason?: unknown } }} manifest
 * @returns {string | null}
 */
export function notBundleableReason(manifest) {
  const vaubaan = manifest.vaubaan;
  if (typeof vaubaan !== 'object' || vaubaan === null) return null;
  if (vaubaan.bundleable !== false) return null;
  const reason = vaubaan.reason;
  return typeof reason === 'string' && reason !== '' ? reason : 'declared not bundleable';
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
 * Imports the bundle under plain Node and returns its default export's id and version.
 * @param {string} entry
 * @returns {{ id: unknown, version: unknown }}
 */
function smoke(entry) {
  const code =
    'const m = await import(process.argv[1]);' +
    "const p = m.default; if (!p || typeof p !== 'object') throw new Error('no default export');" +
    'process.stdout.write(JSON.stringify({ id: p.id, version: p.version }));';
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', code, pathToFileURL(entry).href],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  /** @type {{ id: unknown, version: unknown }} */
  const loaded = JSON.parse(out);
  return loaded;
}

/**
 * Builds one plugin's bundle into `<out>/<id>/`. Returns what was built, or the
 * reason it was skipped.
 * @param {string} id
 * @param {{ out: string, sdkVersion: string, esbuild: typeof import('esbuild') }} options
 */
export async function buildPluginBundle(id, { out, sdkVersion, esbuild }) {
  const source = join(PLUGINS, id);
  const manifestPath = join(source, 'package.json');
  if (!existsSync(manifestPath)) throw new BundleError(`${id}: no plugins/${id}/package.json`);
  const manifest = readJson(manifestPath);
  const reason = notBundleableReason(manifest);
  if (reason !== null) return { id, skipped: reason };

  const target = join(out, id);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const entry = join(target, 'index.js');
  try {
    await esbuild.build({
      entryPoints: [join(source, 'src/index.ts')],
      outfile: entry,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node26',
      banner: { js: REQUIRE_SHIM },
      legalComments: 'eof',
      logLevel: 'silent',
    });
  } catch (err) {
    /** @type {string[]} */
    const errors = Array.isArray(err.errors)
      ? err.errors.map((/** @type {{ text: string }} */ e) => e.text)
      : [String(err.message)];
    throw new BundleError(`${id}: esbuild refused the bundle: ${errors.join('; ')}`);
  }
  for (const file of readdirSync(join(source, 'src'))) {
    if (file.endsWith('.yaml')) copyFileSync(join(source, 'src', file), join(target, file));
  }
  writeFileSync(
    join(target, 'package.json'),
    `${JSON.stringify(bundleManifest(manifest, id, sdkVersion), null, 2)}\n`,
  );
  copyFileSync(join(ROOT, 'LICENSE'), join(target, 'LICENSE'));
  if (existsSync(join(source, 'README.md'))) {
    copyFileSync(join(source, 'README.md'), join(target, 'README.md'));
  }

  let loaded;
  try {
    loaded = smoke(entry);
  } catch (err) {
    const stderr = typeof err.stderr === 'string' ? err.stderr.trim().split('\n').at(-1) : '';
    throw new BundleError(`${id}: the bundle does not import under node: ${stderr || err.message}`);
  }
  if (loaded.id !== id || loaded.version !== manifest.version) {
    throw new BundleError(
      `${id}: the bundle's plugin is ${String(loaded.id)} ${String(loaded.version)}, expected ${id} ${manifest.version}`,
    );
  }
  return { id, version: manifest.version, path: target };
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
