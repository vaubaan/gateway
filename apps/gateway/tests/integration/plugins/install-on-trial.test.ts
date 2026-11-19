/**
 * An installed plugin, end to end over a real SQLite file and real archives (ADR
 * plugins-activated-by-an-administrator-on-trial; intents install-a-plugin-on-my-gateway):
 * an upload stays inert, an activation runs the version's trial at once in the running
 * instance (amendment 2026-11-19), a version that does not pass its trial is never served
 * and the previous one keeps serving, going back to a kept version works, a folder
 * modified on the volume is not loaded, and `plugins.safe_mode` loads none.
 *
 * The plugin is the SDK's `acme` fixture built by esbuild into a self-contained bundle,
 * packed as `vaubaan-plugin build` packs one.
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { SDK_VERSION } from '@vaubaan/plugin-sdk';
import {
  ARCHIVE_MANIFEST_FILE,
  manifestOfFiles,
  packArchive,
  sha256Hex,
} from '@vaubaan/plugin-sdk/archive';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { loadInstanceConfig } from '../../../src/server/config';
import { validEnv } from '../../support/config/testing';
import { REPOSITORY_PLUGINS } from '../../support/plugins/repository';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const ACME = join(REPO, 'packages/plugin-sdk/tests/fixtures/acme');
const ADMIN = { userId: 'user-ops' };

async function acmeBundle(version: string): Promise<string> {
  const result = await build({
    stdin: {
      contents: [
        `import { acmePlugin } from ${JSON.stringify(join(ACME, 'acme-plugin.ts'))};`,
        `import { definePlugin } from '@vaubaan/plugin-sdk';`,
        `export default definePlugin({ ...acmePlugin, version: ${JSON.stringify(version)} });`,
      ].join('\n'),
      resolveDir: REPO,
      loader: 'ts',
      sourcefile: 'acme-entry.ts',
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

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** An archive of the acme plugin at `version`, or of `code` in its place. */
function archive(version: string, code: string): Uint8Array {
  const files = new Map<string, Uint8Array>([
    ['index.js', encode(code)],
    [
      'package.json',
      encode(
        JSON.stringify({
          name: '@acme/vaubaan-plugin-acme',
          version,
          type: 'module',
          exports: { '.': './index.js' },
          peerDependencies: { '@vaubaan/plugin-sdk': `^${SDK_VERSION}` },
          license: 'UNLICENSED',
        }),
      ),
    ],
    ['risk-catalog.yaml', readFileSync(join(ACME, 'risk-catalog.yaml'))],
  ]);
  files.set(ARCHIVE_MANIFEST_FILE, encode(JSON.stringify(manifestOfFiles(files, 'acme', version))));
  return packArchive(files);
}

describe('installing a plugin, on trial', () => {
  let dir: string;
  let storePath: string;
  let v100: Uint8Array;
  let v110: Uint8Array;
  let broken: Uint8Array;
  const roots: GatewayRoot[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vbn-installed-'));
    storePath = join(dir, 'gateway.db');
    v100 = archive('1.0.0', await acmeBundle('1.0.0'));
    v110 = archive('1.1.0', await acmeBundle('1.1.0'));
    broken = archive('1.2.0', `throw new Error('broken at import');\nexport default {};\n`);
  }, 60_000);

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((r) => r.close()));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(env: Record<string, string> = {}): Promise<GatewayRoot> {
    await Promise.all(roots.splice(0).map((r) => r.close()));
    const root = await buildRoot({
      loadConfig: () =>
        loadInstanceConfig({
          env: validEnv({
            VAUBAAN_STORE_PATH: storePath,
            VAUBAAN_PLUGINS_ALLOW_UNSIGNED: 'acme',
            ...env,
          }),
        }),
      logWrite: () => undefined,
      bundled: REPOSITORY_PLUGINS,
      requestRestart: () => undefined,
    });
    roots.push(root);
    return root;
  }

  async function upload(root: GatewayRoot, bytes: Uint8Array): Promise<string> {
    const result = await root.pluginInstall.service.upload(bytes, ADMIN);
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    return result.version.digest;
  }

  it('keeps an upload inert, then serves it as soon as it is activated, with no restart', async () => {
    const root = await start();
    const digest = await upload(root, v100);
    expect(digest).toBe(sha256Hex(v100));
    expect(root.registry.get('acme')).toBeUndefined();
    expect((await root.store.pluginVersions.get(digest))?.state).toBe('pending');

    expect(await root.pluginInstall.service.activate(digest, 'not-acme', ADMIN)).toMatchObject({
      ok: false,
      code: 'confirmation-mismatch',
    });
    expect(await root.pluginInstall.service.activate(digest, 'acme', ADMIN)).toEqual({
      ok: true,
      live: true,
    });
    expect(root.registry.get('acme')?.plugin.version).toBe('1.0.0');
    expect(root.plugins.entries.find((e) => e.id === 'acme')).toMatchObject({
      origin: 'installed',
      version: '1.0.0',
    });
    expect((await root.store.pluginVersions.get(digest))?.state).toBe('active');
    const acts = (await root.store.audit.list({ kind: 'admin' })).flatMap((e) =>
      e.kind === 'admin' ? [e.act] : [],
    );
    expect(acts).toEqual(expect.arrayContaining(['plugin-uploaded', 'plugin-activated']));

    // The next start runs the same version, without a trial.
    const next = await start();
    expect(next.registry.get('acme')?.plugin.version).toBe('1.0.0');
  });

  it('never serves a version that fails its trial: the previous one keeps serving and the failure is shown', async () => {
    const root = await start();
    const running = root.registry.get('acme')?.plugin;
    const digest = await upload(root, broken);
    expect(await root.pluginInstall.service.activate(digest, 'acme', ADMIN)).toMatchObject({
      ok: false,
      code: 'did-not-load',
      message: expect.stringMatching(/broken at import/) as string,
    });
    expect(root.registry.get('acme')?.plugin).toBe(running);
    const failed = await root.store.pluginVersions.get(digest);
    expect(failed?.state).toBe('failed');
    expect(failed?.failure).toMatch(/broken at import/);
    expect((await root.store.pluginVersions.get(sha256Hex(v100)))?.state).toBe('active');

    const next = await start();
    expect(next.registry.get('acme')?.plugin.version).toBe('1.0.0');
  });

  it('moves to a newer version, then back to the kept one, without a restart', async () => {
    const root = await start();
    const toolName = root.registry.get('acme')!.plugin.tools[0]!.name;
    const newer = await upload(root, v110);
    expect(await root.pluginInstall.service.activate(newer, 'acme', ADMIN)).toEqual({
      ok: true,
      live: true,
    });
    expect(root.registry.get('acme')?.plugin.version).toBe('1.1.0');
    // The next call of the service meets the new version.
    expect(root.registry.serviceForTool(toolName)?.plugin.version).toBe('1.1.0');
    expect((await root.store.pluginVersions.get(sha256Hex(v100)))?.state).toBe('previous');

    const view = await root.pluginInstall.service.activationView(sha256Hex(v100));
    expect(view?.running).toEqual({ version: '1.1.0', origin: 'installed' });
    expect(await root.pluginInstall.service.activate(sha256Hex(v100), 'acme', ADMIN)).toEqual({
      ok: true,
      live: true,
    });
    expect(root.registry.get('acme')?.plugin.version).toBe('1.0.0');
    expect((await root.store.pluginVersions.get(newer))?.state).toBe('previous');

    const back = await start();
    expect(back.registry.get('acme')?.plugin.version).toBe('1.0.0');
  });

  it('starts without any installed plugin in safe mode', async () => {
    const root = await start({ VAUBAAN_PLUGINS_SAFE_MODE: 'true' });
    expect(root.registry.get('acme')).toBeUndefined();
    expect((await root.store.pluginVersions.get(sha256Hex(v100)))?.state).toBe('active');
  });

  it('refuses an unsigned plugin the configuration does not name, and turns the active one away', async () => {
    const root = await start({ VAUBAAN_PLUGINS_ALLOW_UNSIGNED: '' });
    expect(await root.pluginInstall.service.upload(v110, ADMIN)).toMatchObject({
      ok: false,
      code: 'unsigned-not-allowed',
    });
    // The same rule at every start: the unsigned version that ran is no longer admitted.
    expect(root.registry.get('acme')).toBeUndefined();
    expect(await root.store.pluginVersions.get(sha256Hex(v100))).toMatchObject({
      state: 'failed',
      failure: expect.stringMatching(/not signed/) as string,
    });
  });

  it('leaves out a version whose folder was modified on the volume', async () => {
    const again = await start();
    expect(await again.pluginInstall.service.activate(sha256Hex(v100), 'acme', ADMIN)).toEqual({
      ok: true,
      live: true,
    });
    appendFileSync(join(dir, 'plugins', sha256Hex(v100), 'index.js'), '\n// planted\n');
    const root = await start();
    expect(root.registry.get('acme')).toBeUndefined();
    const failed = await root.store.pluginVersions.get(sha256Hex(v100));
    expect(failed).toMatchObject({ state: 'failed' });
    expect(failed?.failure).toMatch(/index\.js was modified/);
  });

  it('keeps the trial for the next start in safe mode, where installed versions do not run', async () => {
    const root = await start({ VAUBAAN_PLUGINS_SAFE_MODE: 'true' });
    const newer = sha256Hex(v110);
    expect(await root.pluginInstall.service.activate(newer, 'acme', ADMIN)).toEqual({
      ok: true,
      live: false,
    });
    expect(root.registry.get('acme')).toBeUndefined();
    expect((await root.store.pluginVersions.get(newer))?.state).toBe('trial');
  });
});
