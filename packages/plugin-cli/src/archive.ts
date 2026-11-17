/**
 * A plugin's archive: the one directory a plugin version ships as, built from the
 * plugin's own folder by `vaubaan-plugin build` (spec plugin-authoring §0 "Archive";
 * ADR plugin-signature-sets-the-trust-level; handbook plugin-loading).
 *
 *   index.js               src/index.ts bundled by esbuild: one ESM file for Node 26, every
 *                          dependency inside, the SDK included (a loaded plugin carries
 *                          its own SDK copy; the host reads its errors by brand)
 *   *.yaml                 the files the plugin reads beside its module (risk-catalog.yaml,
 *                          through catalogPathNextTo); JSON imports are inlined by esbuild
 *   package.json           the plugin's name, version, licence, `type: module`, `exports`,
 *                          and the SDK range it was built against (peerDependencies)
 *   LICENSE, README.md     when the plugin has them (or the licence file given)
 *   docs/connect/          the connect guide's screenshots, served by the host
 *   vaubaan-manifest.json  the sha256 of every other file: what a signature covers
 *
 * The bundle is imported under plain Node before the manifest is written (the smoke
 * test): its default export must be a plugin whose version is the package's.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import type * as Esbuild from 'esbuild';

/** The package a plugin is written against; its version is the archive's SDK range. */
export const SDK_PACKAGE = '@vaubaan/plugin-sdk';
/** The file of the archive that lists the digest of every other file. */
export const ARCHIVE_MANIFEST_FILE = 'vaubaan-manifest.json';
/** The format of {@link ARCHIVE_MANIFEST_FILE}. */
export const ARCHIVE_MANIFEST_FORMAT = 'vaubaan-plugin-manifest/v1';
/** Where a plugin keeps its connect guide's screenshots (`GUIDE_SCREENSHOT_DIR` of the SDK). */
const CONNECT_DIR = join('docs', 'connect');

// esbuild's ESM output has no `require`; a CommonJS dependency that requires a Node
// builtin needs one (the same shim every Node ESM bundle carries).
const REQUIRE_SHIM =
  "import { createRequire as __vaubaanCreateRequire } from 'node:module';\n" +
  'const require = __vaubaanCreateRequire(import.meta.url);';

/** A build refused, with a message naming the plugin and the step. */
export class ArchiveError extends Error {}

/** What the builder reads of a plugin's `package.json`. */
export interface PluginPackage {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly license?: string;
  readonly vaubaan?: { readonly bundleable?: unknown; readonly reason?: unknown };
}

/** The `package.json` an archive carries. */
export interface ArchivePackage {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly type: 'module';
  readonly exports: { readonly '.': './index.js' };
  readonly peerDependencies: Readonly<Record<string, string>>;
  readonly license: string;
}

/** The archive's manifest: the digest of every file but itself and a signature. */
export interface ArchiveManifest {
  readonly format: typeof ARCHIVE_MANIFEST_FORMAT;
  readonly id: string;
  readonly version: string;
  /** Path inside the archive (`/`-separated) → hex sha256, sorted by path. */
  readonly files: Readonly<Record<string, string>>;
}

/** The archive's `package.json`, from the plugin's own. Pure. */
export function archivePackage(manifest: PluginPackage, sdkVersion: string): ArchivePackage {
  return {
    name: manifest.name,
    version: manifest.version,
    ...(manifest.description !== undefined ? { description: manifest.description } : {}),
    type: 'module',
    exports: { '.': './index.js' },
    peerDependencies: { [SDK_PACKAGE]: `^${sdkVersion}` },
    license: manifest.license ?? 'UNLICENSED',
  };
}

/** `null` when the plugin can be bundled, else the reason it declares. Pure. */
export function notBundleableReason(manifest: Pick<PluginPackage, 'vaubaan'>): string | null {
  const vaubaan = manifest.vaubaan;
  if (typeof vaubaan !== 'object' || vaubaan === null) return null;
  if (vaubaan.bundleable !== false) return null;
  const reason = vaubaan.reason;
  return typeof reason === 'string' && reason !== '' ? reason : 'declared not bundleable';
}

/** Whether a file of the archive is left out of its manifest (itself, a signature). */
export function outsideManifest(path: string): boolean {
  return path === ARCHIVE_MANIFEST_FILE || path.endsWith('.sig') || path.endsWith('.sig.json');
}

function filesUnder(dir: string, root: string = dir): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? filesUnder(path, root) : [relative(root, path)];
    })
    .map((path) => path.split(sep).join('/'));
}

/** The manifest of an archive directory, every file hashed. */
export function manifestOf(dir: string, id: string, version: string): ArchiveManifest {
  const files: Record<string, string> = {};
  for (const path of filesUnder(dir)
    .filter((p) => !outsideManifest(p))
    .sort()) {
    files[path] = createHash('sha256')
      .update(readFileSync(join(dir, ...path.split('/'))))
      .digest('hex');
  }
  return { format: ARCHIVE_MANIFEST_FORMAT, id, version, files };
}

/**
 * The version of the SDK the plugin resolves, read from the nearest
 * `node_modules/@vaubaan/plugin-sdk/package.json` above its folder (the SDK's `exports`
 * do not expose its manifest to `require.resolve`).
 */
export function resolveSdkVersion(pluginDir: string): string {
  let dir = resolve(pluginDir);
  for (;;) {
    const manifest = join(dir, 'node_modules', ...SDK_PACKAGE.split('/'), 'package.json');
    if (existsSync(manifest)) {
      const version = (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown }).version;
      if (typeof version === 'string') return version;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new ArchiveError(
        `${pluginDir}: ${SDK_PACKAGE} is not installed (npm install ${SDK_PACKAGE})`,
      );
    }
    dir = parent;
  }
}

function smoke(entry: string): { id: unknown; version: unknown } {
  const code =
    'const m = await import(process.argv[1]);' +
    "const p = m.default; if (!p || typeof p !== 'object') throw new Error('no default export');" +
    'process.stdout.write(JSON.stringify({ id: p.id, version: p.version }));';
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', code, pathToFileURL(entry).href],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return JSON.parse(out) as { id: unknown; version: unknown };
}

export interface BuildArchiveOptions {
  /** The plugin's folder: `package.json` and `src/index.ts`. */
  readonly pluginDir: string;
  /** Where the archive is written; emptied first. */
  readonly outDir: string;
  /** Default: the one this package depends on. */
  readonly esbuild?: typeof Esbuild;
  /** Default: the version {@link resolveSdkVersion} finds. */
  readonly sdkVersion?: string;
  /** Copied as `LICENSE` when the plugin has none. */
  readonly licenseFile?: string;
}

export type BuildArchiveResult =
  | { readonly skipped: string }
  | { readonly id: string; readonly version: string; readonly path: string };

/** Builds one plugin's archive into `outDir`. */
export async function buildArchive(options: BuildArchiveOptions): Promise<BuildArchiveResult> {
  const source = resolve(options.pluginDir);
  const manifestPath = join(source, 'package.json');
  if (!existsSync(manifestPath)) throw new ArchiveError(`${source}: no package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PluginPackage;
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new ArchiveError(`${manifestPath}: needs a "name" and a "version"`);
  }
  const reason = notBundleableReason(manifest);
  if (reason !== null) return { skipped: reason };
  const sdkVersion = options.sdkVersion ?? resolveSdkVersion(source);
  const esbuild = options.esbuild ?? (await import('esbuild'));

  const target = resolve(options.outDir);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const entry = join(target, 'index.js');
  try {
    await esbuild.build({
      entryPoints: [join(source, 'src', 'index.ts')],
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
    const errors =
      typeof err === 'object' && err !== null && Array.isArray((err as { errors?: unknown }).errors)
        ? (err as { errors: { text: string }[] }).errors.map((e) => e.text)
        : [String(err)];
    throw new ArchiveError(`${manifest.name}: esbuild refused the bundle: ${errors.join('; ')}`);
  }
  for (const file of readdirSync(join(source, 'src'))) {
    if (file.endsWith('.yaml')) copyFileSync(join(source, 'src', file), join(target, file));
  }
  writeFileSync(
    join(target, 'package.json'),
    `${JSON.stringify(archivePackage(manifest, sdkVersion), null, 2)}\n`,
  );
  const license = existsSync(join(source, 'LICENSE'))
    ? join(source, 'LICENSE')
    : options.licenseFile;
  if (license !== undefined) copyFileSync(license, join(target, 'LICENSE'));
  if (existsSync(join(source, 'README.md'))) {
    copyFileSync(join(source, 'README.md'), join(target, 'README.md'));
  }
  if (existsSync(join(source, CONNECT_DIR))) {
    cpSync(join(source, CONNECT_DIR), join(target, CONNECT_DIR), { recursive: true });
  }

  let loaded: { id: unknown; version: unknown };
  try {
    loaded = smoke(entry);
  } catch (err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    const last = typeof stderr === 'string' ? stderr.trim().split('\n').at(-1) : undefined;
    throw new ArchiveError(
      `${manifest.name}: the bundle does not import under node: ${last ?? String(err)}`,
    );
  }
  if (typeof loaded.id !== 'string' || loaded.version !== manifest.version) {
    throw new ArchiveError(
      `${manifest.name}: the bundle's plugin is ${String(loaded.id)} ${String(loaded.version)}, expected version ${manifest.version}`,
    );
  }
  writeFileSync(
    join(target, ARCHIVE_MANIFEST_FILE),
    `${JSON.stringify(manifestOf(target, loaded.id, manifest.version), null, 2)}\n`,
  );
  return { id: loaded.id, version: manifest.version, path: target };
}
