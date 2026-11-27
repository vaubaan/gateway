/**
 * One click installs a catalog version (intent "Install a catalog plugin in one click"),
 * end to end on a store file, the catalog faked by a `fetch` serving real archives:
 *
 *   - the archive the catalog published for notion 0.2.0 (signed by its release workflow)
 *     is kept pending, trust "Vaubaan", the download audited with where it came from;
 *   - an archive without the catalog's signature, or of another version than asked, is
 *     refused and nothing is kept, even for an id the configuration allows unsigned;
 *   - a version the catalog has not published is said so;
 *   - an update activates in one act, with no id typed, a version already downloaded
 *     without fetching it again, and activates nothing when the download is refused;
 *   - once the versions feed names a catalog id, an archive of that id the catalog did not
 *     sign is refused at upload, even one the configuration allows unsigned.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { manifestOfFiles, packArchive, readArchive } from '@vaubaan/plugin-sdk/archive';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { loadInstanceConfig } from '../../../src/server/config';
import { validEnv } from '../../support/config/testing';
import { WITH_NOTION_FIXTURE } from '../../support/plugins/catalog-fixture';
import { REPOSITORY_PLUGINS } from '../../support/plugins/repository';

const NOTION = readFileSync(new URL('../../fixtures/sigstore/notion-v0.2.0.tgz', import.meta.url));
const ADMIN = { userId: 'user-ops' };
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** notion 0.2.0's files, its signatures removed: an unsigned archive of the same plugin. */
function unsignedNotion(version = '0.2.0'): Uint8Array {
  const files = new Map(
    [...readArchive(NOTION).files].filter(([path]) => !path.startsWith('vaubaan-manifest')),
  );
  if (version !== '0.2.0') {
    const pkg = JSON.parse(new TextDecoder().decode(files.get('package.json'))) as Record<
      string,
      unknown
    >;
    files.set('package.json', encode(JSON.stringify({ ...pkg, version })));
  }
  files.set(
    'vaubaan-manifest.json',
    encode(JSON.stringify(manifestOfFiles(files, 'notion', version))),
  );
  return packArchive(files);
}

/** An unsigned archive of id `id`, made of notion's files renamed: never run, only stored. */
function unsignedOf(id: string): Uint8Array {
  const files = new Map(
    [...readArchive(NOTION).files].filter(([path]) => !path.startsWith('vaubaan-manifest')),
  );
  const rename = (path: string): void => {
    const text = new TextDecoder().decode(files.get(path));
    files.set(path, encode(text.replace(/\bnotion\b/g, id)));
  };
  rename('risk-catalog.yaml');
  rename('package.json');
  files.set('vaubaan-manifest.json', encode(JSON.stringify(manifestOfFiles(files, id, '0.2.0'))));
  return packArchive(files);
}

const FEED = {
  schema: 1,
  generated_at: '2026-11-18T10:00:00Z',
  gateway: { latest: '2.0.0', prerelease: false },
  plugins: { notion: { latest: '0.2.0' }, linear: { latest: '1.0.0' } },
  advisories: [],
};

describe('installing a catalog version in one click', () => {
  let dir: string;
  let root: GatewayRoot | null = null;
  /** What the fake catalog serves, by `<tag>/<tag>.tgz`; absent → 404. */
  const served = new Map<string, Uint8Array>();
  const requested: string[] = [];
  const catalogFetch = (async (url: URL | string) => {
    const path = new URL(String(url)).pathname.split('/').slice(-2).join('/');
    requested.push(String(url));
    const bytes = served.get(path);
    return bytes === undefined
      ? new Response('Not Found', { status: 404 })
      : new Response(Buffer.from(bytes));
  }) as typeof fetch;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vbn-catalog-install-'));
    root = await buildRoot({
      loadConfig: () =>
        loadInstanceConfig({
          env: validEnv({
            VAUBAAN_STORE_PATH: join(dir, 'gateway.db'),
            // Even an id allowed unsigned takes nothing unsigned from the catalog.
            VAUBAAN_PLUGINS_ALLOW_UNSIGNED: 'notion,linear',
            VAUBAAN_UPDATES_CHECK: 'true',
            VAUBAAN_UPDATES_FEED_URL: 'https://feed.example.com/versions.json',
          }),
        }),
      logWrite: () => undefined,
      bundled: REPOSITORY_PLUGINS,
      requestRestart: () => undefined,
      knownCatalogVersions: WITH_NOTION_FIXTURE,
      catalogFetch,
      updatesFetch: async () => new Response(JSON.stringify(FEED)),
      updatesTimers: { setTimeout: () => 'armed', clearTimeout: () => undefined },
    });
  }, 60_000);

  afterAll(async () => {
    await root?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const kept = (): string[] => readdirSync(join(dir, 'plugins')).filter((n) => !n.startsWith('.'));

  it('keeps the catalog’s archive pending, signed by Vaubaan, and audits where it came from', async () => {
    served.set('notion-v0.2.0/notion-v0.2.0.tgz', NOTION);
    const result = await root!.pluginInstall.service.installFromCatalog('notion', '0.2.0', ADMIN);
    expect(result).toMatchObject({
      ok: true,
      version: { pluginId: 'notion', version: '0.2.0', state: 'pending', trust: 'vaubaan' },
    });
    expect(requested.at(-1)).toBe(
      'https://github.com/vaubaan/gateway-plugins/releases/download/notion-v0.2.0/notion-v0.2.0.tgz',
    );
    const entries = await root!.store.audit.list({ kind: 'admin' });
    const entry = entries.find((e) => e.kind === 'admin' && e.act === 'plugin-uploaded');
    expect(entry).toMatchObject({
      act: 'plugin-uploaded',
      after: { from: 'catalog', trust: 'vaubaan', source: requested.at(-1) },
    });
  });

  it('refuses an archive the catalog did not sign, and keeps nothing', async () => {
    const before = kept();
    served.set('notion-v0.2.1/notion-v0.2.1.tgz', unsignedNotion('0.2.1'));
    expect(
      await root!.pluginInstall.service.installFromCatalog('notion', '0.2.1', ADMIN),
    ).toMatchObject({ ok: false, code: 'signature-invalid' });
    expect(kept()).toEqual(before);
  });

  it('refuses another version than the one asked for, and keeps nothing', async () => {
    const before = kept();
    // The catalog's real 0.2.0 archive, served where 0.3.0 was expected.
    served.set('notion-v0.3.0/notion-v0.3.0.tgz', NOTION);
    expect(
      await root!.pluginInstall.service.installFromCatalog('notion', '0.3.0', ADMIN),
    ).toMatchObject({ ok: false, code: 'not-the-catalog-version' });
    expect(kept()).toEqual(before);
    expect(await root!.pluginInstall.service.list()).toHaveLength(1);
  });

  it('reserves the ids the versions feed names to the catalog’s signature, at upload', async () => {
    // Before the feed is read, `linear` is no id this instance knows: allowed unsigned.
    const first = await root!.pluginInstall.service.upload(unsignedOf('linear'), ADMIN);
    expect(first).toMatchObject({ ok: true, version: { pluginId: 'linear', trust: 'unsigned' } });
    await root!.pluginInstall.service.refuse(
      (first as { version: { digest: string } }).version.digest,
      ADMIN,
    );

    expect((await root!.updates.refresh())?.catalogIds).toEqual(['linear', 'notion']);
    expect(await root!.pluginInstall.service.upload(unsignedOf('linear'), ADMIN)).toMatchObject({
      ok: false,
      code: 'reserved-id',
    });
  });

  it('keeps a version built for another SDK, and never activates it', async () => {
    // What a gateway upgrade leaves behind: a kept version the new SDK does not read.
    const digest = 'f'.repeat(64);
    await root!.store.pluginVersions.addPending({
      digest,
      pluginId: 'notion',
      version: '0.1.0',
      packageName: '@vaubaan/plugin-notion',
      sdkRange: '^0.1.0',
      trust: 'vaubaan',
      signer: null,
      riskIds: [],
      uploadedBy: ADMIN.userId,
      viaMissionId: null,
    });
    expect((await root!.pluginInstall.service.activationView(digest))?.sdkProblem).toMatch(
      /built for the SDK \^0\.1\.0; this gateway runs/,
    );
    expect(await root!.pluginInstall.service.activate(digest, 'notion', ADMIN)).toMatchObject({
      ok: false,
      code: 'sdk-out-of-range',
    });
    await root!.pluginInstall.service.refuse(digest, ADMIN);
  });

  it('updates a plugin in one act, with nothing typed, activating the version already downloaded', async () => {
    // notion 0.2.0 is pending since the first test: it is activated, not fetched again.
    const before = requested.length;
    const result = await root!.pluginInstall.service.updateFromCatalog('notion', '0.2.0', ADMIN);
    expect(requested.length).toBe(before);
    expect(result).toMatchObject({ ok: true });
    const notion = (await root!.pluginInstall.service.list()).find(
      (v) => v.pluginId === 'notion' && v.version === '0.2.0',
    );
    expect(notion).toMatchObject({ trust: 'vaubaan' });
    expect(['active', 'trial']).toContain(notion?.state);
    const acts = (await root!.store.audit.list({ kind: 'admin' })).map((e) =>
      e.kind === 'admin' ? e.act : null,
    );
    expect(acts).toContain('plugin-activated');
  });

  it('activates nothing when the catalog download is refused', async () => {
    served.set('notion-v0.2.2/notion-v0.2.2.tgz', unsignedNotion('0.2.2'));
    expect(
      await root!.pluginInstall.service.updateFromCatalog('notion', '0.2.2', ADMIN),
    ).toMatchObject({ ok: false, code: 'signature-invalid' });
    expect((await root!.pluginInstall.service.list()).some((v) => v.version === '0.2.2')).toBe(
      false,
    );
  });

  it('says a version the catalog has not published', async () => {
    expect(
      await root!.pluginInstall.service.installFromCatalog('notion', '9.9.9', ADMIN),
    ).toMatchObject({ ok: false, code: 'not-in-catalog' });
  });
});
