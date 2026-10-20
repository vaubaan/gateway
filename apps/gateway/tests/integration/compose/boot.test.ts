/**
 * Boot against a real SQLite file: the production wiring of the composition
 * root (default `openStore`, default empty registry) with a minimal valid
 * configuration pointing `store.path` at a temporary directory.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { bootOrExit, EXIT_BOOT_ERROR } from '../../../src/server/compose/boot';
import { buildRoot, type GatewayRoot, type RootDeps } from '../../../src/server/compose/root';
import { loadInstanceConfig } from '../../../src/server/config';
import { validEnv } from '../../../src/server/config/testing';
import { healthResponse } from '../../../src/server/http/healthz';
import { UnknownRiskIdError } from '../../../src/server/store';
import { SHIPPED_PLUGINS } from '../../../src/server/compose/shipped-plugins';

describe('composition root over the embedded SQLite store', () => {
  const dirs: string[] = [];
  const roots: GatewayRoot[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((r) => r.close()));
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'vbn-boot-'));
    dirs.push(dir);
    return dir;
  }

  function depsFor(storePath: string, lines: string[] = []): RootDeps {
    return {
      loadConfig: () => loadInstanceConfig({ env: validEnv({ VAUBAAN_STORE_PATH: storePath }) }),
      logWrite: (_lvl, line) => lines.push(line),
    };
  }

  async function boot(storePath: string, lines: string[] = []): Promise<GatewayRoot> {
    const root = await buildRoot(depsFor(storePath, lines));
    roots.push(root);
    return root;
  }

  it('creates the database, applies the migrations, pings, and /healthz reports the store kind', async () => {
    const path = join(tempDir(), 'gateway.db');
    const lines: string[] = [];
    const root = await boot(path, lines);

    expect(existsSync(path)).toBe(true);
    expect(root.store.kind).toBe('sqlite');
    expect(root.store.schemaVersion).toBe(20);
    expect(
      root.store.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM schema_migrations').get()
        ?.n,
    ).toBe(20);
    await expect(root.store.ping()).resolves.toBeUndefined();
    expect(root.registry.size).toBe(SHIPPED_PLUGINS.length);

    const res = await healthResponse(root);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'ok',
      store: { kind: 'sqlite', status: 'ok' },
    });

    const log = lines.join('\n');
    expect(log).toContain('"msg":"store opened"');
    expect(log).toContain('"schema_version":20');
    expect(log).toContain('"msg":"composition root ready"');
  });

  it('seals store secrets with the encryptor built from the configuration, and reopens without re-migrating', async () => {
    const path = join(tempDir(), 'gateway.db');
    const first = await boot(path);
    await first.store.config.setSecret('idp.client_secret', 's3cret-value');
    const raw = first.store.db
      .prepare<[string], { secret_blob: Buffer; key_version: number }>(
        'SELECT secret_blob, key_version FROM instance_config WHERE key = ?',
      )
      .get('idp.client_secret');
    expect(raw?.key_version).toBe(first.encryptor.currentKeyVersion);
    expect(raw?.secret_blob.toString('utf8')).not.toContain('s3cret-value');
    await first.close();
    roots.splice(roots.indexOf(first), 1);

    // Same master key (validEnv is stable per process), same file: the secret opens.
    const second = await boot(path);
    expect(second.store.schemaVersion).toBe(20);
    expect(
      second.store.db
        .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM schema_migrations')
        .get()?.n,
    ).toBe(20);
    await expect(second.store.config.getSecret('idp.client_secret')).resolves.toBe('s3cret-value');
  });

  it('refuses to persist a risk id the registry does not know', async () => {
    const root = await boot(join(tempDir(), 'gateway.db'));
    const owner = await root.store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'u1',
      email: 'u1@example.test',
    });
    const connection = await root.store.connections.create({
      provider: 'acme',
      owner: { kind: 'user', id: owner.id },
      displayName: 'Acme',
      credential: null,
    });
    await expect(
      root.store.shares.create({
        connectionId: connection.id,
        target: { kind: 'user', id: owner.id },
        restriction: ['acme.read-things'],
        createdByUserId: owner.id,
      }),
    ).rejects.toBeInstanceOf(UnknownRiskIdError);
  });

  it('fails the boot naming store.path when the database cannot be opened', async () => {
    const missingDir = join(tempDir(), 'does-not-exist', 'gateway.db');
    let out = '';
    let code: number | null = null;
    await bootOrExit(depsFor(missingDir), { stderr: (t) => (out += t), exit: (c) => (code = c) });
    expect(code).toBe(EXIT_BOOT_ERROR);
    expect(out).toContain('store.path: cannot open the embedded store at ');
    expect(out).toContain(missingDir);
    expect(out).toContain('(env: VAUBAAN_STORE_PATH)');
  });
});
