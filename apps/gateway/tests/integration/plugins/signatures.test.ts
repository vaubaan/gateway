/**
 * Who signed a plugin decides whether an instance installs it (ADR
 * plugin-signature-sets-the-trust-level), end to end on a store file:
 *
 *   - an archive the catalog published (`notion-v0.2.0.tgz`, signed by the release workflow of
 *     vaubaan/gateway-plugins) is "Vaubaan", verified offline, and may replace the image's own;
 *   - an unsigned archive never takes an id of the image, whatever `plugins.allow_unsigned` says;
 *   - a company key's signature is refused until an administrator trusts the key, then shown by
 *     its name; once the key is removed, the version is turned away at the next start.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { SDK_VERSION } from '@vaubaan/plugin-sdk';
import {
  ARCHIVE_MANIFEST_FILE,
  generateSigningKey,
  manifestOfFiles,
  packArchive,
  readArchive,
  SIGNATURE_FILE,
  signManifest,
} from '@vaubaan/plugin-sdk/archive';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { loadInstanceConfig } from '../../../src/server/config';
import { validEnv } from '../../support/config/testing';
import { REPOSITORY_PLUGINS } from '../../support/plugins/repository';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const ACME = join(REPO, 'packages/plugin-sdk/tests/fixtures/acme');
const NOTION = readFileSync(new URL('../../fixtures/sigstore/notion-v0.2.0.tgz', import.meta.url));
const ADMIN = { userId: 'user-ops' };
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

async function acmeBundle(): Promise<string> {
  const result = await build({
    stdin: {
      contents: [
        `import { acmePlugin } from ${JSON.stringify(join(ACME, 'acme-plugin.ts'))};`,
        `import { definePlugin } from '@vaubaan/plugin-sdk';`,
        `export default definePlugin({ ...acmePlugin, version: '1.0.0' });`,
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

/** An archive of `id` (the acme plugin's code unless `id` differs), signed by `key` if given. */
function archive(code: string, key?: string, id = 'acme'): Uint8Array {
  const files = new Map<string, Uint8Array>([
    ['index.js', encode(code)],
    [
      'package.json',
      encode(
        JSON.stringify({
          name: `@acme/${id}`,
          version: '1.0.0',
          type: 'module',
          exports: { '.': './index.js' },
          peerDependencies: { '@vaubaan/plugin-sdk': `^${SDK_VERSION}` },
        }),
      ),
    ],
    [
      'risk-catalog.yaml',
      encode(readFileSync(join(ACME, 'risk-catalog.yaml'), 'utf8').replace(/\bacme\b/g, id)),
    ],
  ]);
  const manifest = encode(JSON.stringify(manifestOfFiles(files, id, '1.0.0')));
  files.set(ARCHIVE_MANIFEST_FILE, manifest);
  if (key !== undefined) {
    files.set(SIGNATURE_FILE, encode(JSON.stringify(signManifest(manifest, key))));
  }
  return packArchive(files);
}

describe('signatures decide what an instance installs', () => {
  let dir: string;
  let code: string;
  let root: GatewayRoot | null = null;
  const key = generateSigningKey();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vbn-signatures-'));
    code = await acmeBundle();
  }, 60_000);

  afterAll(async () => {
    await root?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(env: Record<string, string> = {}): Promise<GatewayRoot> {
    await root?.close();
    root = await buildRoot({
      loadConfig: () =>
        loadInstanceConfig({
          env: validEnv({ VAUBAAN_STORE_PATH: join(dir, 'gateway.db'), ...env }),
        }),
      logWrite: () => undefined,
      bundled: REPOSITORY_PLUGINS,
      requestRestart: () => undefined,
    });
    return root;
  }

  it('installs the catalog’s notion, signed by Vaubaan, over the image’s own', async () => {
    const r = await start();
    expect(readArchive(NOTION).manifest.id).toBe('notion');
    const uploaded = await r.pluginInstall.service.upload(NOTION, ADMIN);
    expect(uploaded).toMatchObject({ ok: true, version: { trust: 'vaubaan', pluginId: 'notion' } });
    if (!uploaded.ok) return;
    await r.pluginInstall.service.activate(uploaded.version.digest, 'notion', ADMIN);
    const next = await start();
    expect(next.plugins.entries.find((e) => e.id === 'notion')).toMatchObject({
      origin: 'installed',
      version: '0.2.0',
      trust: 'vaubaan',
    });
  });

  it('never lets an unsigned archive take an id of the image', async () => {
    const r = await start({ VAUBAAN_PLUGINS_ALLOW_UNSIGNED: 'notion' });
    const result = await r.pluginInstall.service.upload(archive(code, undefined, 'notion'), ADMIN);
    expect(result).toMatchObject({ ok: false, code: 'reserved-id' });
  });

  it('trusts a company key only once an administrator named it, then turns its versions away once removed', async () => {
    const r = await start();
    const signed = archive(code, key.privateKeyPem);
    expect(await r.pluginInstall.service.upload(signed, ADMIN)).toMatchObject({
      ok: false,
      code: 'signature-invalid',
    });

    expect(
      await r.pluginInstall.service.addSigner(
        { name: 'Acme release key', publicKeyPem: key.publicKeyPem, typedName: 'Acme' },
        ADMIN,
      ),
    ).toMatchObject({ ok: false, code: 'confirmation-mismatch' });
    expect(
      await r.pluginInstall.service.addSigner(
        { name: 'Acme release key', publicKeyPem: key.publicKeyPem, typedName: 'Acme release key' },
        ADMIN,
      ),
    ).toEqual({ ok: true, keyId: key.keyId });

    const uploaded = await r.pluginInstall.service.upload(signed, ADMIN);
    expect(uploaded).toMatchObject({
      ok: true,
      version: { trust: 'signer', signer: 'Acme release key' },
    });
    if (!uploaded.ok) return;
    await r.pluginInstall.service.activate(uploaded.version.digest, 'acme', ADMIN);
    const running = await start();
    expect(running.registry.get('acme')?.plugin.version).toBe('1.0.0');
    expect(running.plugins.entries.find((e) => e.id === 'acme')).toMatchObject({ trust: 'signer' });

    expect(
      await running.pluginInstall.service.removeSigner(key.keyId, 'Acme release key', ADMIN),
    ).toEqual({ ok: true, keyId: key.keyId });
    const after = await start();
    expect(after.registry.get('acme')).toBeUndefined();
    const version = await after.store.pluginVersions.get(uploaded.version.digest);
    expect(version?.state).toBe('failed');
    expect(version?.failure).toMatch(/does not trust/);

    const acts = (await after.store.audit.list({ kind: 'admin' })).flatMap((e) =>
      e.kind === 'admin' ? [e.act] : [],
    );
    expect(acts).toEqual(expect.arrayContaining(['plugin-signer-added', 'plugin-signer-removed']));
  });

  it('refuses the catalog’s signature on an archive changed after it was signed', async () => {
    const r = await start();
    const files = new Map(readArchive(NOTION).files);
    files.set('index.js', encode('export default {};\n'));
    // A new manifest over the changed files: the catalog's signature no longer covers it.
    const { ARCHIVE_MANIFEST_FILE: m } = { ARCHIVE_MANIFEST_FILE };
    const rest = new Map([...files].filter(([path]) => !path.startsWith('vaubaan-manifest')));
    files.set(m, encode(JSON.stringify(manifestOfFiles(rest, 'notion', '0.2.0'))));
    expect(await r.pluginInstall.service.upload(packArchive(files), ADMIN)).toMatchObject({
      ok: false,
      code: 'signature-invalid',
    });
  });
});
