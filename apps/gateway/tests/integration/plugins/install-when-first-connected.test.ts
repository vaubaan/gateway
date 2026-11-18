/**
 * A catalog plugin installed when a person first connects its service (ADR
 * plugins-installed-when-first-needed), end to end on a store file. The instance starts
 * without notion; the versions feed names notion 0.2.0 and the catalog serves the archive
 * its release workflow signed:
 *
 *   - any person's first connection installs it and loads it at once, no restart: the
 *     registry, the connect picker and the inventory have it, the version is active, both
 *     acts audited;
 *   - the next start loads it as an installed version;
 *   - `plugins.enabled` that does not name it refuses, and nothing is installed.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { REPOSITORY_PLUGINS } from '../../support/plugins/repository';
import { loadInstanceConfig } from '../../../src/server/config';
import { validEnv } from '../../support/config/testing';

const NOTION = readFileSync(new URL('../../fixtures/sigstore/notion-v0.2.0.tgz', import.meta.url));
const PERSON = { userId: 'user-ada' };
const FEED = {
  schema: 1,
  generated_at: '2026-11-18T10:00:00Z',
  gateway: { latest: '2.0.0', prerelease: false },
  plugins: { notion: { latest: '0.2.0' } },
  advisories: [],
};

describe('a catalog plugin installed at its first connection', () => {
  let dir: string;
  let root: GatewayRoot | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vbn-first-connection-'));
  });

  afterEach(async () => {
    await root?.close();
    root = null;
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(env: Record<string, string> = {}): Promise<GatewayRoot> {
    await root?.close();
    root = await buildRoot({
      loadConfig: () =>
        loadInstanceConfig({
          env: validEnv({
            VAUBAAN_STORE_PATH: join(dir, 'gateway.db'),
            VAUBAAN_UPDATES_CHECK: 'true',
            VAUBAAN_UPDATES_FEED_URL: 'https://feed.example.com/versions.json',
            ...env,
          }),
        }),
      logWrite: () => undefined,
      requestRestart: () => undefined,
      // The image without notion: only an installed version can bring it.
      bundled: REPOSITORY_PLUGINS.filter((plugin) => plugin.id !== 'notion'),
      updatesFetch: async () => new Response(JSON.stringify(FEED)),
      updatesTimers: { setTimeout: () => 'armed', clearTimeout: () => undefined },
      catalogFetch: async () => new Response(Buffer.from(NOTION)),
    });
    await root.updates.refresh();
    return root;
  }

  it('installs it for anyone and loads it at once, then keeps it at the next start', async () => {
    const r = await start();
    expect(r.registry.has('notion')).toBe(false);
    expect((await r.accounts.service.services()).map((s) => s.id)).not.toContain('notion');

    const result = await r.pluginInstall.service.installForConnection('notion', PERSON);
    expect(result).toMatchObject({
      ok: true,
      installed: { pluginId: 'notion', version: '0.2.0', state: 'active', trust: 'vaubaan' },
    });
    expect(r.registry.get('notion')?.plugin.version).toBe('0.2.0');
    expect((await r.accounts.service.services()).map((s) => s.id)).toContain('notion');
    expect(r.plugins.entries.find((e) => e.id === 'notion')).toMatchObject({
      origin: 'installed',
      trust: 'vaubaan',
      enabled: true,
    });
    const acts = (await r.store.audit.list({ kind: 'admin' })).flatMap((e) =>
      e.kind === 'admin' ? [{ act: e.act, user: e.user_id }] : [],
    );
    expect(acts).toEqual(
      expect.arrayContaining([
        { act: 'plugin-uploaded', user: PERSON.userId },
        { act: 'plugin-activated', user: PERSON.userId },
      ]),
    );
    // A second person's connection finds it there.
    expect(await r.pluginInstall.service.installForConnection('notion', PERSON)).toEqual({
      ok: true,
      installed: null,
    });

    const next = await start();
    expect(next.registry.get('notion')?.plugin.version).toBe('0.2.0');
    expect(next.plugins.entries.find((e) => e.id === 'notion')?.origin).toBe('installed');
  });

  it('refuses a plugin the configuration does not enable, and installs nothing', async () => {
    const r = await start({ VAUBAAN_PLUGINS_ENABLED: 'github' });
    expect(await r.pluginInstall.service.installForConnection('notion', PERSON)).toMatchObject({
      ok: false,
      code: 'not-enabled',
    });
    expect(await r.pluginInstall.service.list()).toEqual([]);
    expect(r.registry.has('notion')).toBe(false);
  });

  it('says a service the catalog does not offer', async () => {
    const r = await start();
    expect(await r.pluginInstall.service.installForConnection('nope', PERSON)).toMatchObject({
      ok: false,
      code: 'not-in-catalog',
    });
  });
});
