/**
 * Pinned plugins: read once at boot from `plugins.dir`, one directory per plugin
 * (ADR plugins-bundled-or-pinned-by-the-operator; handbook plugin-loading).
 *
 * A pinned plugin is what `scripts/build-plugin-bundle.mjs` writes and the image
 * `ghcr.io/vaubaan/plugin-<id>:<version>` carries:
 *
 *   <plugins.dir>/<dir>/package.json       name, version, the SDK range it was built
 *                                          against (`peerDependencies`), the entry
 *                                          (`exports["."]` or `main`)
 *   <plugins.dir>/<dir>/<entry>.js          one self-contained ESM file, its own SDK copy
 *   <plugins.dir>/<dir>/risk-catalog.yaml   beside the entry, read by the plugin itself
 *
 * Every refusal stops the boot as an invalid key does (`ConfigError`, exit 78), with
 * the directory in the message: a pin is the operator's deliberate choice, never
 * skipped silently. Nothing here downloads anything.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createRegistry,
  PluginRegistryError,
  SDK_CONTRACT_SINCE,
  type ServicePlugin,
} from '@vaubaan/plugin-sdk';
import { satisfies, subset, valid, validRange } from 'semver';

import { ConfigError, envNamesFor, type ConfigIssue } from '../config';
import { isRecord } from '@vaubaan/shared';

/** The peer dependency that names the SDK range a pinned plugin was built against. */
export const SDK_PACKAGE = '@vaubaan/plugin-sdk';
/** The catalog a pinned plugin carries beside its entry. */
export const PINNED_CATALOG_FILE = 'risk-catalog.yaml';
const MANIFEST_FILE = 'package.json';
/** A manifest is a few hundred bytes; anything this large is not one. */
const MANIFEST_MAX_BYTES = 64 * 1024;

/** One plugin read from the plugins directory. */
export interface PinnedPlugin {
  /** `plugin.id`. */
  readonly id: string;
  /** `version` of its `package.json`, equal to `plugin.version`. */
  readonly version: string;
  /** The plugin's directory, absolute. */
  readonly path: string;
  /** The SDK range it declares. */
  readonly sdkRange: string;
  readonly plugin: ServicePlugin;
  /** An installed version's trust level (`trust.ts`); absent for a pin of the operator. */
  readonly trust?: 'vaubaan' | 'signer' | 'unsigned';
}

export interface PinReadOptions {
  /** The host's SDK version (`SDK_VERSION`), checked against each pin's range. */
  readonly sdkVersion: string;
  /** Imports the entry (tests: a fake); default: the runtime's own `import()`. */
  readonly importEntry?: (fileUrl: string) => Promise<unknown>;
}

/** What `package.json` of a pinned plugin says, once checked. */
export interface PinManifest {
  readonly name: string;
  readonly version: string;
  readonly sdkRange: string;
  /** The entry, relative to the plugin's directory. */
  readonly entry: string;
}

/** The runtime's `import()`, out of reach of the bundler: the file is the operator's, read at run time. */
export async function importEntryFile(fileUrl: string): Promise<unknown> {
  return import(/* webpackIgnore: true */ /* turbopackIgnore: true */ fileUrl);
}

function issueAt(path: string, message: string): ConfigIssue {
  return { path: 'plugins.dir', env: envNamesFor('plugins.dir'), message: `${path}: ${message}` };
}

function refuse(path: string, message: string): never {
  throw new ConfigError([issueAt(path, message)]);
}

/** The entry a manifest names: `exports["."]` (a string, or its `import` / `default`), else `main`. */
function entryOf(manifest: Record<string, unknown>): unknown {
  const exported = manifest['exports'];
  if (typeof exported === 'string') return exported;
  if (isRecord(exported)) {
    const dot = exported['.'];
    if (typeof dot === 'string') return dot;
    if (isRecord(dot)) return dot['import'] ?? dot['default'];
  }
  return manifest['main'];
}

/**
 * Checks the manifest of a pinned plugin: the problems, or the manifest. Pure (the
 * caller reads the file). The entry must be an ESM file inside the directory.
 */
export function readPinManifest(
  raw: unknown,
): { readonly ok: true; readonly manifest: PinManifest } | { ok: false; problem: string } {
  if (!isRecord(raw)) return { ok: false, problem: `${MANIFEST_FILE} is not a JSON object` };
  const { name, version } = raw;
  if (typeof name !== 'string' || name.trim() === '') {
    return { ok: false, problem: `${MANIFEST_FILE} has no "name"` };
  }
  if (typeof version !== 'string' || valid(version) === null) {
    return { ok: false, problem: `${MANIFEST_FILE} has no semver "version"` };
  }
  const peers = raw['peerDependencies'];
  const sdkRange = isRecord(peers) ? peers[SDK_PACKAGE] : undefined;
  if (typeof sdkRange !== 'string' || validRange(sdkRange) === null) {
    return {
      ok: false,
      problem: `${MANIFEST_FILE} must name the SDK range it was built against in peerDependencies["${SDK_PACKAGE}"]`,
    };
  }
  const entry = entryOf(raw);
  if (typeof entry !== 'string' || entry.trim() === '') {
    return { ok: false, problem: `${MANIFEST_FILE} names no entry (exports["."] or main)` };
  }
  if (isAbsolute(entry) || entry.split(/[\\/]/).includes('..')) {
    return { ok: false, problem: `the entry '${entry}' is not inside the plugin's directory` };
  }
  const esm = entry.endsWith('.mjs') || (entry.endsWith('.js') && raw['type'] === 'module');
  if (!esm) {
    return {
      ok: false,
      problem: `the entry '${entry}' is not an ES module (an .mjs file, or .js with "type": "module")`,
    };
  }
  return { ok: true, manifest: { name, version, sdkRange, entry } };
}

const PRERELEASES = { includePrerelease: true } as const;

/**
 * Whether a host of the SDK `sdkVersion` runs a plugin built for `range`: its version
 * is in the range, or the whole range lies between the first SDK of the contract it keeps
 * and itself (ADR plugin-sdk-1-0-keeps-the-0-9-4-contract: a 1.0 host runs a `^0.9.4`
 * build, never a `^0.9.3` one nor one built for a later SDK). Prereleases count
 * (`0.7.0-rc.1` satisfies `^0.7.0-rc.0`, and a release host a prerelease range).
 */
export function sdkInRange(
  sdkVersion: string,
  range: string,
  contractSince: string = SDK_CONTRACT_SINCE,
): boolean {
  if (validRange(range) === null || valid(sdkVersion) === null) return false;
  if (satisfies(sdkVersion, range, PRERELEASES)) return true;
  return subset(range, `>=${contractSince} <=${sdkVersion}`, PRERELEASES);
}

/** A plugin built against an SDK before 0.9.4: its catalog names a `provider`, not a `service`. */
function builtBeforeTheServiceWord(plugin: unknown): boolean {
  if (!isRecord(plugin) || !isRecord(plugin['catalog'])) return false;
  const catalog = plugin['catalog'];
  return catalog['service'] === undefined && typeof catalog['provider'] === 'string';
}

/** The directories of `dir` a pin may sit in: no dotfile, no plain file, sorted. */
async function pinDirectories(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') refuse(dir, 'the plugins directory does not exist');
    if (code === 'ENOTDIR') refuse(dir, 'the plugins directory is not a directory');
    refuse(dir, `the plugins directory cannot be read (${code ?? 'error'})`);
  }
  const out: string[] = [];
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue;
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (info?.isDirectory()) out.push(path);
  }
  return out;
}

async function readManifest(path: string): Promise<PinManifest> {
  const file = join(path, MANIFEST_FILE);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) refuse(path, `no ${MANIFEST_FILE}: not a plugin directory`);
  if (info.size > MANIFEST_MAX_BYTES) refuse(path, `${MANIFEST_FILE} is too large`);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    // expected: a manifest that is not JSON refuses the plugin, with that reason
    refuse(path, `${MANIFEST_FILE} is not valid JSON`);
  }
  const read = readPinManifest(raw);
  if (!read.ok) refuse(path, read.problem);
  return read.manifest;
}

/** A plugin as the registry would refuse it, with the issues; `[]` when it registers. */
function registrationIssues(candidate: unknown): string[] {
  if (!isRecord(candidate)) return ['the entry has no default export that is a plugin'];
  try {
    createRegistry([candidate as unknown as ServicePlugin]);
    return [];
  } catch (err) {
    if (err instanceof PluginRegistryError) return [...err.issues];
    return [err instanceof Error ? err.message : String(err)];
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message.split('\n')[0] ?? ''}`;
  return String(err);
}

/**
 * Reads, checks and imports the plugin in `path`: a pin, or an installed version
 * (`installed.ts`). Throws a `ConfigError` naming the directory.
 */
export async function readPluginDirectory(
  path: string,
  options: PinReadOptions,
): Promise<PinnedPlugin> {
  return readPin(path, options);
}

async function readPin(path: string, options: PinReadOptions): Promise<PinnedPlugin> {
  const manifest = await readManifest(path);
  if (!sdkInRange(options.sdkVersion, manifest.sdkRange)) {
    refuse(
      path,
      `${manifest.name} ${manifest.version} was built for ${SDK_PACKAGE} ${manifest.sdkRange}; this gateway runs ${options.sdkVersion}: pin a build of the plugin for this gateway, or remove the directory`,
    );
  }
  const entry = resolve(path, manifest.entry);
  if (relative(path, entry).startsWith('..') || !entry.startsWith(path + sep)) {
    refuse(path, `the entry '${manifest.entry}' is not inside the plugin's directory`);
  }
  if (!(await stat(entry).catch(() => null))?.isFile()) {
    refuse(path, `the entry '${manifest.entry}' does not exist`);
  }
  if (!(await stat(join(dirname(entry), PINNED_CATALOG_FILE)).catch(() => null))?.isFile()) {
    refuse(path, `no ${PINNED_CATALOG_FILE} beside the entry '${manifest.entry}'`);
  }
  let loaded: unknown;
  try {
    loaded = await (options.importEntry ?? importEntryFile)(pathToFileURL(entry).href);
  } catch (err) {
    // `definePlugin` throws here, at import, for a plugin it refuses.
    refuse(path, `the plugin failed to load: ${errorText(err)}`);
  }
  const plugin = isRecord(loaded) ? loaded['default'] : undefined;
  // A pin built against an SDK before 0.9.4 says provider where this host says service
  // (ADR plugin-sdk-1-0-keeps-the-0-9-4-contract): no longer translated.
  if (builtBeforeTheServiceWord(plugin)) {
    refuse(
      path,
      `${manifest.name} ${manifest.version} was built against an SDK before 0.9.4 (it says provider, not service): pin a build of the plugin for this gateway, or remove the directory`,
    );
  }
  const issues = registrationIssues(plugin);
  if (issues.length > 0) {
    throw new ConfigError(issues.map((issue) => issueAt(path, `refused: ${issue}`)));
  }
  const accepted = plugin as ServicePlugin;
  // A `host` account runs on the gateway's own services, which only the image
  // binds (ADR platform-management-is-a-plugin-on-the-execution-door): never a pin.
  if (accepted.credential.kind === 'host') {
    refuse(
      path,
      `plugin '${accepted.id}' declares a host account, which only a plugin bundled with the gateway may declare: remove the directory`,
    );
  }
  if (accepted.version !== manifest.version) {
    refuse(
      path,
      `${MANIFEST_FILE} says version ${manifest.version}, the plugin says ${accepted.version}`,
    );
  }
  return {
    id: accepted.id,
    version: manifest.version,
    path,
    sdkRange: manifest.sdkRange,
    plugin: accepted,
  };
}

/**
 * Every pinned plugin of `dir`, in the order of their directory names. Throws a
 * `ConfigError` at the first directory refused, or when two directories hold the same
 * plugin id (both paths named).
 */
export async function readPinnedPlugins(
  dir: string,
  options: PinReadOptions,
): Promise<PinnedPlugin[]> {
  const root = resolve(dir);
  const pins: PinnedPlugin[] = [];
  for (const path of await pinDirectories(root)) pins.push(await readPin(path, options));
  const seen = new Map<string, string>();
  const duplicates: ConfigIssue[] = [];
  for (const pin of pins) {
    const first = seen.get(pin.id);
    if (first === undefined) seen.set(pin.id, pin.path);
    else duplicates.push(issueAt(pin.path, `pins plugin '${pin.id}' again (also in ${first})`));
  }
  if (duplicates.length > 0) throw new ConfigError(duplicates);
  return pins;
}
