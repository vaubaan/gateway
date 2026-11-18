/**
 * A plugin the accounts need, restored from the catalog at a start (ADR
 * plugins-installed-when-first-needed): an instance holding notion accounts starts on an
 * image that does not compile notion — an upgrade from an image that did. The start
 * installs the version this release knows (`catalog-versions.json`, pinned by its sha256)
 * before anything reads the accounts, audited as the start; when the catalog cannot be
 * reached, the start stops naming the plugin, as before.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { STARTUP_ACTOR_ID } from '@vaubaan/gateway-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { loadInstanceConfig } from '../../../src/server/config';
import { validEnv } from '../../support/config/testing';
import { REPOSITORY_PLUGINS } from '../../support/plugins/repository';

const NOTION = readFileSync(new URL('../../fixtures/sigstore/notion-v0.2.0.tgz', import.meta.url));
const WITHOUT_NOTION = REPOSITORY_PLUGINS.filter((plugin) => plugin.id !== 'notion');

describe('a plugin the accounts need, restored at a start', () => {
  let dir: string;
  let root: GatewayRoot | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vbn-restore-plugin-'));
  });

  afterEach(async () => {
    await root?.close();
    root = null;
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(
    bundled: typeof REPOSITORY_PLUGINS,
    catalogFetch: typeof fetch = async () => new Response('Not Found', { status: 404 }),
  ): Promise<GatewayRoot> {
    await root?.close();
    root = null;
    root = await buildRoot({
      loadConfig: () =>
        loadInstanceConfig({ env: validEnv({ VAUBAAN_STORE_PATH: join(dir, 'gateway.db') }) }),
      logWrite: () => undefined,
      requestRestart: () => undefined,
      bundled,
      catalogFetch,
    });
    return root;
  }

  /** An instance that compiled notion, with one notion account. */
  async function withNotionAccount(): Promise<void> {
    const before = await start(REPOSITORY_PLUGINS);
    const ada = await before.store.users.upsertFromIdp({
      issuer: 'https://idp.example.com',
      subject: 'ada',
      email: 'ada@example.com',
    });
    await before.store.accounts.create({
      service: 'notion',
      owner: { kind: 'user', id: ada.id },
      displayName: 'Acme workspace',
      credential: null,
    });
    await before.close();
    root = null;
  }

  it('installs it from the catalog before the accounts are read, audited as the start', async () => {
    await withNotionAccount();
    const requested: string[] = [];
    const r = await start(WITHOUT_NOTION, async (url) => {
      requested.push(String(url));
      return new Response(Buffer.from(NOTION));
    });
    expect(requested).toEqual([
      'https://github.com/vaubaan/gateway-plugins/releases/download/notion-v0.2.0/notion-v0.2.0.tgz',
    ]);
    expect(r.registry.get('notion')?.plugin.version).toBe('0.2.0');
    expect(r.plugins.entries.find((e) => e.id === 'notion')).toMatchObject({
      origin: 'installed',
      trust: 'vaubaan',
    });
    const acts = (await r.store.audit.list({ kind: 'admin' })).flatMap((e) =>
      e.kind === 'admin' && e.object.id !== undefined ? [{ act: e.act, user: e.user_id }] : [],
    );
    expect(acts).toEqual(
      expect.arrayContaining([{ act: 'plugin-activated', user: STARTUP_ACTOR_ID }]),
    );
  });

  it('stops the start, naming the plugin, when the catalog cannot give it', async () => {
    await withNotionAccount();
    await expect(start(WITHOUT_NOTION)).rejects.toThrow(/notion/);
  });

  it('refuses an archive whose sha256 is not the one this release pins', async () => {
    await withNotionAccount();
    const other = Buffer.concat([Buffer.from(NOTION), Buffer.from([0])]);
    await expect(start(WITHOUT_NOTION, async () => new Response(other))).rejects.toThrow(/notion/);
  });
});
