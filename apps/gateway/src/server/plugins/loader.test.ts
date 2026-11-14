/**
 * The plugins directory, read against fixture directories (ADR
 * plugins-bundled-or-pinned-by-the-operator). The pinned plugin is a real bundle:
 * the SDK's `acme` fixture built by esbuild the way `scripts/build-plugin-bundle.mjs`
 * builds one (its own SDK copy inside, its catalog read beside it), then copied into
 * directories whose manifests vary. No network, no provider.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { isUpstreamAuthError, UpstreamAuthError, type ProviderPlugin } from '@vaubaan/plugin-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ConfigError } from '../config';
import { createLogger } from '../logging';
import { loadPlugins } from './index';
import { readPinManifest, readPinnedPlugins, sdkInRange } from './loader';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const ACME = join(REPO, 'packages/plugin-sdk/tests/fixtures/acme');
const SDK = '0.6.0';

let root: string;
let bundle: string;

/** The acme fixture as a self-contained ESM bundle at `version`, its credential replaced by `credential` (a JS expression). */
async function bundleAcme(version: string, credential?: string): Promise<string> {
  const overrides = credential === undefined ? '' : `, credential: ${credential}`;
  const result = await build({
    stdin: {
      contents: [
        `import { acmePlugin } from ${JSON.stringify(join(ACME, 'acme-plugin.ts'))};`,
        `import { definePlugin, UpstreamAuthError } from '@vaubaan/plugin-sdk';`,
        `export default definePlugin({ ...acmePlugin, version: ${JSON.stringify(version)}${overrides} });`,
        `export const throwAuth = async () => { throw new UpstreamAuthError('no', 401); };`,
      ].join('\n'),
      resolveDir: REPO,
      loader: 'ts',
      sourcefile: 'pin-entry.ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    write: false,
    logLevel: 'silent',
  });
  const [out] = result.outputFiles;
  if (!out) throw new Error('esbuild wrote nothing');
  return out.text;
}

interface PinFixture {
  readonly version?: string;
  readonly range?: string;
  readonly manifest?: Record<string, unknown>;
  readonly catalog?: boolean;
  readonly code?: string;
}

/** A pin directory `<dir>/<name>` built from the bundle (or `code`). */
function pin(dir: string, name: string, fixture: PinFixture = {}): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'index.js'), fixture.code ?? bundle);
  if (fixture.catalog !== false)
    cpSync(join(ACME, 'risk-catalog.yaml'), join(path, 'risk-catalog.yaml'));
  writeFileSync(
    join(path, 'package.json'),
    JSON.stringify({
      name: `@vaubaan/plugin-${name}`,
      version: fixture.version ?? '1.2.4',
      type: 'module',
      exports: { '.': './index.js' },
      peerDependencies: { '@vaubaan/plugin-sdk': fixture.range ?? `^${SDK}` },
      ...fixture.manifest,
    }),
  );
  return path;
}

function freshDir(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof ConfigError) return err.message;
    throw err;
  }
  throw new Error('expected a ConfigError');
}

const quiet = createLogger({ level: 'error', redact: (s) => s, write: () => undefined });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'vaubaan-pins-'));
  bundle = await bundleAcme('1.2.4');
}, 60_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('readPinnedPlugins', () => {
  it('loads a bundle with its own SDK copy, skipping dotfiles and plain files', async () => {
    const dir = freshDir('ok');
    pin(dir, 'acme');
    mkdirSync(join(dir, '.cache'));
    writeFileSync(join(dir, 'README.txt'), 'not a plugin');
    const pins = await readPinnedPlugins(dir, { sdkVersion: SDK });
    expect(pins.map((p) => [p.id, p.version, p.path])).toEqual([
      ['acme', '1.2.4', join(dir, 'acme')],
    ]);
    // The catalog was read beside the bundle, by the bundle's own SDK.
    expect(pins[0]?.plugin.catalog.provider).toBe('acme');
  });

  it('recognises an error of the pinned copy of the SDK by its brand, not instanceof', async () => {
    const dir = freshDir('brand');
    const path = pin(dir, 'acme');
    const module = (await import(join(path, 'index.js'))) as { throwAuth: () => Promise<never> };
    const thrown = await module.throwAuth().catch((err: unknown) => err);
    // eslint-disable-next-line no-restricted-syntax -- the point: instanceof misses the other copy
    expect(thrown instanceof UpstreamAuthError).toBe(false);
    expect(isUpstreamAuthError(thrown)).toBe(true);
  });

  it('refuses a pin built for another SDK range, naming the range and the directory', async () => {
    const dir = freshDir('range');
    const path = pin(dir, 'acme', { range: '^0.5.1' });
    const message = await refusal(() => readPinnedPlugins(dir, { sdkVersion: SDK }));
    expect(message).toContain(path);
    expect(message).toContain('^0.5.1');
    expect(message).toContain(SDK);
    expect(message).toContain('plugins.dir');
  });

  it('refuses two directories that pin the same plugin id', async () => {
    const dir = freshDir('dup');
    pin(dir, 'acme');
    pin(dir, 'acme-again');
    const message = await refusal(() => readPinnedPlugins(dir, { sdkVersion: SDK }));
    expect(message).toContain(`pins plugin 'acme' again`);
    expect(message).toContain(join(dir, 'acme'));
  });

  it('refuses a plugin definePlugin or the registry refuses', async () => {
    const dir = freshDir('refused');
    const path = pin(dir, 'bad', {
      code: "export default { id: 'Bad Id', version: '1.2.4' };",
    });
    const message = await refusal(() => readPinnedPlugins(dir, { sdkVersion: SDK }));
    expect(message).toContain(`${path}: refused:`);
  });

  it('refuses a plugin that declares a host account: only the image binds one', async () => {
    const dir = freshDir('host-kind');
    pin(dir, 'acme', { code: await bundleAcme('1.2.4', "{ kind: 'host' }") });
    expect(await refusal(() => readPinnedPlugins(dir, { sdkVersion: SDK }))).toContain(
      "plugin 'acme' declares a host account, which only a plugin bundled with the gateway may declare",
    );
  });

  it('refuses a plugin whose import throws', async () => {
    const dir = freshDir('throws');
    pin(dir, 'acme', { code: "throw new Error('broken at import');" });
    expect(await refusal(() => readPinnedPlugins(dir, { sdkVersion: SDK }))).toContain(
      'the plugin failed to load: Error: broken at import',
    );
  });

  it('refuses a manifest whose version is not the plugin’s', async () => {
    const dir = freshDir('version');
    pin(dir, 'acme', { version: '9.9.9' });
    expect(await refusal(() => readPinnedPlugins(dir, { sdkVersion: SDK }))).toContain(
      'package.json says version 9.9.9, the plugin says 1.2.4',
    );
  });

  it('refuses a pin without its catalog, without a manifest, or a missing directory', async () => {
    const noCatalog = freshDir('no-catalog');
    pin(noCatalog, 'acme', { catalog: false });
    expect(await refusal(() => readPinnedPlugins(noCatalog, { sdkVersion: SDK }))).toContain(
      'no risk-catalog.yaml beside the entry',
    );
    const noManifest = freshDir('no-manifest');
    mkdirSync(join(noManifest, 'acme'));
    expect(await refusal(() => readPinnedPlugins(noManifest, { sdkVersion: SDK }))).toContain(
      'no package.json',
    );
    expect(
      await refusal(() => readPinnedPlugins(join(root, 'absent'), { sdkVersion: SDK })),
    ).toContain('the plugins directory does not exist');
  });

  it('reads an empty directory as no pin', async () => {
    expect(await readPinnedPlugins(freshDir('empty'), { sdkVersion: SDK })).toEqual([]);
  });
});

describe('loadPlugins', () => {
  it('lets the pin replace the bundled plugin of its id and logs it', async () => {
    const dir = freshDir('replace');
    pin(dir, 'acme');
    const bundled = (await import(join(ACME, 'acme-plugin.ts'))) as { acmePlugin: ProviderPlugin };
    const lines: string[] = [];
    const logger = createLogger({
      level: 'info',
      redact: (s) => s,
      write: (_level, line) => lines.push(line),
    });
    const { registry, inventory } = await loadPlugins({ plugins: { dir, enabled: null } }, logger, {
      bundled: [bundled.acmePlugin],
      sdkVersion: SDK,
    });
    expect(registry.require('acme').plugin.version).toBe('1.2.4');
    expect(inventory.entries).toEqual([
      {
        id: 'acme',
        name: 'Acme',
        version: '1.2.4',
        origin: 'pinned',
        replaces: '1.2.3',
        enabled: true,
        path: join(dir, 'acme'),
      },
    ]);
    expect(lines.join('')).toContain(
      `plugin acme 1.2.4 pinned from ${join(dir, 'acme')} (replaces bundled 1.2.3)`,
    );
  });

  it('reads no directory when plugins.dir is unset', async () => {
    const { registry, inventory } = await loadPlugins(
      { plugins: { dir: null, enabled: null } },
      quiet,
      {
        bundled: [],
      },
    );
    expect(registry.size).toBe(0);
    expect(inventory).toEqual({ dir: null, entries: [] });
  });
});

describe('readPinManifest', () => {
  const base = {
    name: '@vaubaan/plugin-acme',
    version: '1.0.0',
    type: 'module',
    peerDependencies: { '@vaubaan/plugin-sdk': '^0.6.0' },
  };

  it('takes exports["."] as a string or as conditions, else main', () => {
    const entryOf = (raw: Record<string, unknown>): string | null => {
      const read = readPinManifest({ ...base, ...raw });
      return read.ok ? read.manifest.entry : null;
    };
    expect(entryOf({ exports: { '.': './index.js' } })).toBe('./index.js');
    expect(entryOf({ exports: { '.': { import: './esm.js' } } })).toBe('./esm.js');
    expect(entryOf({ main: 'main.mjs', type: 'commonjs' })).toBe('main.mjs');
  });

  it('refuses what is not a self-contained ESM entry with an SDK range', () => {
    const problem = (raw: unknown): string | null => {
      const read = readPinManifest(raw);
      return read.ok ? null : read.problem;
    };
    expect(problem([])).toContain('not a JSON object');
    expect(problem({ ...base, version: 'one' })).toContain('semver "version"');
    expect(problem({ ...base, peerDependencies: {}, main: 'a.js' })).toContain('peerDependencies');
    expect(problem({ ...base })).toContain('names no entry');
    expect(problem({ ...base, main: '../escape.js' })).toContain('not inside');
    expect(problem({ ...base, main: '/abs.js' })).toContain('not inside');
    expect(problem({ ...base, type: 'commonjs', main: 'index.js' })).toContain('not an ES module');
  });
});

describe('sdkInRange', () => {
  it('reads the range as semver, prereleases included', () => {
    expect(sdkInRange('0.6.0', '^0.6.0')).toBe(true);
    expect(sdkInRange('0.6.3', '^0.6.0')).toBe(true);
    expect(sdkInRange('0.7.0', '^0.6.0')).toBe(false);
    expect(sdkInRange('0.6.0', '^0.5.1')).toBe(false);
    expect(sdkInRange('0.7.0-rc.1', '^0.7.0-rc.0')).toBe(true);
    expect(sdkInRange('0.6.1-beta.1', '^0.6.0')).toBe(true);
  });
});
