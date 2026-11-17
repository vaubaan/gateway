/**
 * Installed plugins: archives an administrator uploaded or installed from the catalog,
 * kept on the data volume by digest and loaded at start (ADR
 * plugins-activated-by-an-administrator-on-trial; spec vaubaan-gateway §4.2
 * Administration › Plugins; handbook plugin-loading).
 *
 *   <data dir>/plugins/<sha256 of the archive>/   the archive's files, as packed
 *
 * The store says which version of each plugin is `active`, which one starts on
 * `trial`; this module only reads and writes the directories and decides, at start,
 * what a trial became. Nothing here registers a plugin: the loader's `composePlugins`
 * does, with the pins and the image's plugins.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

import { parseCatalogYaml, type ServicePlugin } from '@vaubaan/plugin-sdk';
import {
  ARCHIVE_MANIFEST_FILE,
  ArchiveFormatError,
  outsideManifest,
  parseArchiveManifest,
  readArchive,
  sha256Hex,
} from '@vaubaan/plugin-sdk/archive';

import { ConfigError } from '../config';
import type { Logger } from '../logging';
import {
  PINNED_CATALOG_FILE,
  readPinManifest,
  readPluginDirectory,
  sdkInRange,
  SDK_PACKAGE,
  type PinnedPlugin,
  type PinReadOptions,
} from './loader';

/** The folder of installed plugins inside the data directory. */
export const INSTALLED_DIR_NAME = 'plugins';
const MANIFEST_FILE = 'package.json';

/**
 * Where installed plugins live: `plugins/` beside the store's file. `null` for a store
 * in memory, where nothing can be installed.
 */
export function installedDirFor(storePath: string): string | null {
  if (storePath === ':memory:' || storePath.trim() === '') return null;
  return join(/* turbopackIgnore: true */ dirname(storePath), INSTALLED_DIR_NAME);
}

/** Why an upload was refused: a code for the protocol, a sentence for the person. */
export type InstallRefusalCode =
  'archive-invalid' | 'sdk-out-of-range' | 'catalog-invalid' | 'id-mismatch';

export class InstallRefusal extends Error {
  override readonly name = 'InstallRefusal';
  constructor(
    readonly code: InstallRefusalCode,
    message: string,
  ) {
    super(message);
  }
}

/** An archive written to the installed folder, as the store records it. */
export interface StoredArchive {
  /** Hex sha256 of the uploaded bytes; also its folder's name. */
  readonly digest: string;
  readonly pluginId: string;
  readonly version: string;
  /** `name` of its `package.json`. */
  readonly packageName: string;
  readonly sdkRange: string;
  /** The risk ids of its catalog: the store accepts them while the version is kept. */
  readonly riskIds: readonly string[];
  readonly path: string;
}

function text(bytes: Uint8Array | undefined): string | undefined {
  return bytes === undefined ? undefined : Buffer.from(bytes).toString('utf8');
}

/**
 * Checks an uploaded archive without running any of its code, and writes its files to
 * `<dir>/<digest>/` (atomically: a sibling folder renamed into place). The same bytes
 * uploaded twice land in the same folder once.
 */
export async function storeArchive(
  dir: string,
  bytes: Uint8Array,
  options: { readonly sdkVersion: string },
): Promise<StoredArchive> {
  let archive;
  try {
    archive = readArchive(bytes);
  } catch (err) {
    if (err instanceof ArchiveFormatError) throw new InstallRefusal('archive-invalid', err.message);
    throw err;
  }
  const { manifest, files, digest } = archive;
  let pkg: unknown;
  try {
    pkg = JSON.parse(text(files.get(MANIFEST_FILE)) ?? 'null');
  } catch {
    pkg = null;
  }
  const read = readPinManifest(pkg);
  if (!read.ok) throw new InstallRefusal('archive-invalid', read.problem);
  const entry = read.manifest.entry.replace(/^\.\//, '');
  if (!files.has(entry)) {
    throw new InstallRefusal(
      'archive-invalid',
      `the entry '${read.manifest.entry}' is not in the archive`,
    );
  }
  if (read.manifest.version !== manifest.version) {
    throw new InstallRefusal(
      'id-mismatch',
      `${MANIFEST_FILE} says version ${read.manifest.version}, ${ARCHIVE_MANIFEST_FILE} says ${manifest.version}`,
    );
  }
  if (!sdkInRange(options.sdkVersion, read.manifest.sdkRange)) {
    throw new InstallRefusal(
      'sdk-out-of-range',
      `${read.manifest.name} ${manifest.version} was built for ${SDK_PACKAGE} ${read.manifest.sdkRange}; this gateway runs ${options.sdkVersion}: rebuild the plugin for this gateway`,
    );
  }
  const catalogText = text(files.get(PINNED_CATALOG_FILE));
  if (catalogText === undefined) {
    throw new InstallRefusal('catalog-invalid', `no ${PINNED_CATALOG_FILE} in the archive`);
  }
  let riskIds: string[];
  try {
    const { catalog } = parseCatalogYaml(catalogText, { source: PINNED_CATALOG_FILE });
    if (catalog.service !== manifest.id) {
      throw new InstallRefusal(
        'id-mismatch',
        `the catalog is for '${catalog.service}', the archive for '${manifest.id}'`,
      );
    }
    riskIds = catalog.risks.map((risk) => risk.id);
  } catch (err) {
    if (err instanceof InstallRefusal) throw err;
    throw new InstallRefusal(
      'catalog-invalid',
      err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err),
    );
  }

  const path = join(/* turbopackIgnore: true */ dir, digest);
  if (!(await stat(path).catch(() => null))?.isDirectory()) {
    await mkdir(dir, { recursive: true });
    const partial = join(
      /* turbopackIgnore: true */ dir,
      `.${digest}.${randomBytes(6).toString('hex')}.partial`,
    );
    try {
      for (const [file, content] of files) {
        const target = join(/* turbopackIgnore: true */ partial, ...file.split('/'));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, { mode: 0o644 });
      }
      await rename(partial, path).catch(async (err: unknown) => {
        // Another upload of the same bytes won the race: its folder is the same.
        if ((await stat(path).catch(() => null))?.isDirectory()) return;
        throw err;
      });
    } finally {
      await rm(partial, { recursive: true, force: true });
    }
  }
  return {
    digest,
    pluginId: manifest.id,
    version: manifest.version,
    packageName: read.manifest.name,
    sdkRange: read.manifest.sdkRange,
    riskIds,
    path,
  };
}

async function filesUnder(dir: string, root: string = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(/* turbopackIgnore: true */ dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(path, root)));
    else out.push(relative(root, path).split(sep).join('/'));
  }
  return out;
}

/**
 * Whether an installed folder still holds exactly what its manifest lists: the problem,
 * or `null`. Run at every start, before anything of it is imported.
 */
export async function installedFolderProblem(path: string): Promise<string | null> {
  let manifest;
  try {
    manifest = parseArchiveManifest(
      JSON.parse(
        await readFile(join(/* turbopackIgnore: true */ path, ARCHIVE_MANIFEST_FILE), 'utf8'),
      ),
    );
  } catch (err) {
    return `${ARCHIVE_MANIFEST_FILE} unreadable: ${err instanceof Error ? err.message : String(err)}`;
  }
  let present: string[];
  try {
    present = await filesUnder(path);
  } catch {
    return 'the folder is missing';
  }
  for (const [file, digest] of Object.entries(manifest.files)) {
    const content = await readFile(
      join(/* turbopackIgnore: true */ path, ...file.split('/')),
    ).catch(() => null);
    if (content === null) return `${file} is missing`;
    if (sha256Hex(content) !== digest) return `${file} was modified since it was installed`;
  }
  const extra = present.find((file) => !outsideManifest(file) && !(file in manifest.files));
  return extra === undefined ? null : `${extra} was added since it was installed`;
}

/**
 * Classifies the plugin's own examples (`examples`, the samples its tests run): the
 * health check of a version on trial. The problem, or `null`. A plugin that declares
 * none passes.
 */
export function examplesProblem(plugin: ServicePlugin): string | null {
  for (const [tool, samples] of Object.entries(plugin.examples ?? {})) {
    for (const sample of samples) {
      try {
        plugin.classify(tool, sample.args, sample.resources ?? []);
      } catch (err) {
        return `classifying its example of ${tool} threw: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }
  return null;
}

/** A version the store holds as `trial` or `active`, what the start needs of it. */
export interface InstalledVersion {
  readonly digest: string;
  readonly pluginId: string;
  readonly version: string;
  readonly state: 'trial' | 'active';
}

/** What the start made of each version it tried. */
export type InstalledOutcome =
  | { readonly digest: string; readonly outcome: 'activated'; readonly replaced: string | null }
  | { readonly digest: string; readonly outcome: 'loaded' }
  | { readonly digest: string; readonly outcome: 'failed'; readonly failure: string };

export interface InstalledLoad {
  /** The versions loaded, one per plugin id, sorted by id. */
  readonly plugins: readonly PinnedPlugin[];
  /** One per version tried, for the store to record. */
  readonly outcomes: readonly InstalledOutcome[];
}

async function tryLoad(
  dir: string,
  row: InstalledVersion,
  options: PinReadOptions,
): Promise<{ ok: true; pin: PinnedPlugin } | { ok: false; failure: string }> {
  const path = join(/* turbopackIgnore: true */ dir, row.digest);
  const problem = await installedFolderProblem(path);
  if (problem !== null) return { ok: false, failure: problem };
  let pin: PinnedPlugin;
  try {
    pin = await readPluginDirectory(path, options);
  } catch (err) {
    const message =
      err instanceof ConfigError
        ? err.issues.map((issue) => issue.message.replace(`${path}: `, '')).join('; ')
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, failure: message };
  }
  if (pin.id !== row.pluginId || pin.version !== row.version) {
    return {
      ok: false,
      failure: `the folder holds ${pin.id} ${pin.version}, the store expected ${row.pluginId} ${row.version}`,
    };
  }
  const examples = examplesProblem(pin.plugin);
  if (examples !== null) return { ok: false, failure: examples };
  return { ok: true, pin };
}

/**
 * The installed versions this start loads. Per plugin: its `trial` version when it loads
 * and classifies its examples (it then becomes active), otherwise its `active` one; a
 * version that does not load is reported `failed` and the start goes on without it — a
 * trial falls back to the active version, an active one to the pin or the image's.
 */
export async function loadInstalled(
  dir: string,
  versions: readonly InstalledVersion[],
  options: PinReadOptions & { readonly logger: Logger },
): Promise<InstalledLoad> {
  const byId = new Map<string, { trial?: InstalledVersion; active?: InstalledVersion }>();
  for (const row of versions) {
    const slot = byId.get(row.pluginId) ?? {};
    slot[row.state] = row;
    byId.set(row.pluginId, slot);
  }
  const plugins: PinnedPlugin[] = [];
  const outcomes: InstalledOutcome[] = [];
  for (const id of [...byId.keys()].sort()) {
    const { trial, active } = byId.get(id) as {
      trial?: InstalledVersion;
      active?: InstalledVersion;
    };
    if (trial) {
      const tried = await tryLoad(dir, trial, options);
      if (tried.ok) {
        plugins.push(tried.pin);
        outcomes.push({
          digest: trial.digest,
          outcome: 'activated',
          replaced: active?.digest ?? null,
        });
        options.logger.info(`plugin ${id} ${trial.version} started on trial and is now active`, {
          digest: trial.digest,
        });
        continue;
      }
      outcomes.push({ digest: trial.digest, outcome: 'failed', failure: tried.failure });
      options.logger.error(
        `plugin ${id} ${trial.version} failed its trial; the previous version stays`,
        {
          digest: trial.digest,
          failure: tried.failure,
        },
      );
    }
    if (active) {
      const loaded = await tryLoad(dir, active, options);
      if (loaded.ok) {
        plugins.push(loaded.pin);
        outcomes.push({ digest: active.digest, outcome: 'loaded' });
      } else {
        outcomes.push({ digest: active.digest, outcome: 'failed', failure: loaded.failure });
        options.logger.error(`plugin ${id} ${active.version} no longer loads; it is left out`, {
          digest: active.digest,
          failure: loaded.failure,
        });
      }
    }
  }
  return { plugins, outcomes };
}
