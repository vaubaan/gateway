/**
 * The v4 importer ships in the standalone output and runs from it (see
 * docs/handbook/import-from-v4.md): `.next/standalone/apps/gateway/import-v4.mjs`,
 * bundled by `scripts/build-commands.mjs` after `next build`, is started the
 * way the container starts it — a separate Node process in the standalone
 * tree, with the instance's configuration in its environment and its store
 * file on disk — and runs a dry run of a bundle read on stdin: the shipped
 * plugins load their catalogs, the store opens with its migrations, the
 * native addons load, nothing is written and no provider is contacted.
 *
 * Skipped when the bundle is absent (no build yet). CI builds before testing;
 * the container smoke test (`deploy/docker/smoke.sh`) runs `--help` inside the
 * image.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RegistryCatalogIndex } from '../../src/server/compose/registry';
import { buildShippedRegistry } from '../../src/server/compose/shipped-plugins';
import { loadInstanceConfig } from '../../src/server/config';
import { validEnv } from '../../src/server/config/testing';
import { createEncryptor } from '../../src/server/crypto';
import { fixtureBundle } from '../../src/server/import-v4/testing';
import { openStore } from '../../src/server/store';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const standaloneApp = join(appDir, '.next/standalone/apps/gateway');
const bundlePath = join(standaloneApp, 'import-v4.mjs');
const hasBundle = existsSync(bundlePath);

const OWNER = 'owner@example.com';

describe.skipIf(!hasBundle)('the importer runs from the standalone output', () => {
  let dir: string;
  let env: Record<string, string>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vaubaan-import-v4-'));
    env = validEnv({ VAUBAAN_STORE_PATH: join(dir, 'gateway.db') });
    const { config } = loadInstanceConfig({ env });
    // The instance has run once and the owner has signed in.
    const store = openStore({
      path: config.store.path,
      encryptor: await createEncryptor(config.encryption),
      catalog: new RegistryCatalogIndex(await buildShippedRegistry()),
    });
    await store.users.upsertFromIdp({ issuer: 'http://idp.test', subject: 'owner', email: OWNER });
    await store.close();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(args: string[], input: string) {
    return spawnSync(process.execPath, [bundlePath, ...args], {
      cwd: standaloneApp,
      // The image's environment: production, where a source of client addresses is required.
      env: {
        PATH: process.env.PATH ?? '',
        NODE_ENV: 'production',
        VAUBAAN_TRUSTED_PROXIES: '127.0.0.1',
        ...env,
      },
      input,
      encoding: 'utf8',
      timeout: 60_000,
    });
  }

  it('prints a dry run of a bundle read on stdin', () => {
    const result = run(['--owner', OWNER], JSON.stringify(fixtureBundle()));
    expect(result.stderr).toContain("Import of v4 organization 'acme'");
    expect(result.stderr).toContain('DRY RUN');
    expect(result.stderr).toMatch(/ssh "vps-ops": to create/);
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('refuses an unknown owner with its exit code', () => {
    const result = run(['--owner', 'stranger@example.com'], JSON.stringify(fixtureBundle()));
    expect(result.status).toBe(67);
  });
});
