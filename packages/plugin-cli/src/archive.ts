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
 *   vaubaan-manifest.json  the sha256 of every other file, and the service's icon and colour
 *                          when the plugin declares them: what a signature covers
 *
 * and the same files packed beside it as `<out>.tgz` (`@vaubaan/plugin-sdk/archive`), the
 * one file an administrator uploads.
 *
 * The bundle is imported under plain Node before the manifest is written (the smoke
 * test): its default export must be a plugin whose version is the package's.
 */

import { execFileSync } from 'node:child_process';
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

import {
  ARCHIVE_MANIFEST_FILE,
  ARCHIVE_MANIFEST_FORMAT,
  manifestOfFiles,
  outsideManifest,
  packArchive,
  type ArchiveManifest,
  type ArchiveMark,
} from '@vaubaan/plugin-sdk/archive';
import { HEX_COLOUR_PATTERN, SVG_PATH_DATA_PATTERN } from '@vaubaan/plugin-sdk';
import { sdkBuildRange } from '@vaubaan/plugin-sdk/version';

import type * as Esbuild from 'esbuild';

/** The package a plugin is written against; its version is the archive's SDK range. */
export const SDK_PACKAGE = '@vaubaan/plugin-sdk';
export { ARCHIVE_MANIFEST_FILE, ARCHIVE_MANIFEST_FORMAT, outsideManifest, type ArchiveManifest };
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

/** The archive's `package.json`, from the plugin's own. Pure. */
export function archivePackage(manifest: PluginPackage, sdkVersion: string): ArchivePackage {
  return {
    name: manifest.name,
    version: manifest.version,
    ...(manifest.description !== undefined ? { description: manifest.description } : {}),
    type: 'module',
    exports: { '.': './index.js' },
    peerDependencies: { [SDK_PACKAGE]: sdkBuildRange(sdkVersion) },
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

function filesUnder(dir: string, root: string = dir): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? filesUnder(path, root) : [relative(root, path)];
    })
    .map((path) => path.split(sep).join('/'));
}

/** Every file of a directory, by its `/`-separated path inside it. */
export function filesOf(dir: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const path of filesUnder(dir).sort()) {
    files.set(path, readFileSync(join(dir, ...path.split('/'))));
  }
  return files;
}

/** The manifest of an archive directory, every file hashed, with the service's mark if any. */
export function manifestOf(
  dir: string,
  id: string,
  version: string,
  mark: ArchiveMark = {},
): ArchiveManifest {
  return manifestOfFiles(filesOf(dir), id, version, mark);
}

/**
 * The service's mark of a loaded plugin, for the manifest: its `icon` and `iconColor` when
 * they are what `definePlugin` accepts, nothing otherwise. Pure.
 */
export function markOf(loaded: { icon?: unknown; iconColor?: unknown }): ArchiveMark {
  const { icon, iconColor } = loaded;
  if (typeof icon !== 'string' || !SVG_PATH_DATA_PATTERN.test(icon)) return {};
  return typeof iconColor === 'string' && HEX_COLOUR_PATTERN.test(iconColor)
    ? { icon, iconColor }
    : { icon };
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

interface Loaded {
  readonly id: unknown;
  readonly version: unknown;
  readonly icon?: unknown;
  readonly iconColor?: unknown;
}

function smoke(entry: string): Loaded {
  const code =
    'const m = await import(process.argv[1]);' +
    "const p = m.default; if (!p || typeof p !== 'object') throw new Error('no default export');" +
    'process.stdout.write(JSON.stringify({ id: p.id, version: p.version, icon: p.icon, iconColor: p.iconColor }));';
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', code, pathToFileURL(entry).href],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return JSON.parse(out) as Loaded;
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
  | {
      readonly id: string;
      readonly version: string;
      /** The archive's directory. */
      readonly path: string;
      /** The same files packed: `<path>.tgz`, what an administrator uploads. */
      readonly archive: string;
    };

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
  rmSync(`${target}.tgz`, { force: true });
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

  let loaded: Loaded;
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
    `${JSON.stringify(manifestOf(target, loaded.id, manifest.version, markOf(loaded)), null, 2)}\n`,
  );
  const archive = `${target}.tgz`;
  writeFileSync(archive, packArchive(filesOf(target)));
  return { id: loaded.id, version: manifest.version, path: target, archive };
}
