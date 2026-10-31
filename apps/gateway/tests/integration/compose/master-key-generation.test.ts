/**
 * The master key generated at the first start, on a real data directory (ADR
 * master-key-generated-and-handed-over-by-the-instance): the production
 * loader of the composition root (`loadBootConfig`) against a temporary
 * directory holding the store and the key file.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { bootOrExit, EXIT_CONFIG_ERROR } from '../../../src/server/compose/boot';
import { loadBootConfig } from '../../../src/server/compose/boot-config';
import { buildRoot, type GatewayRoot, type RootDeps } from '../../../src/server/compose/root';
import { validEnv } from '../../support/config/testing';
import { MASTER_KEY_GENERATED_KEY } from '../../../src/server/master-key';

describe('master key generated at the first start', () => {
  const dirs: string[] = [];
  const roots: GatewayRoot[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((r) => r.close()));
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function dataDir(): { dir: string; store: string; key: string } {
    const dir = mkdtempSync(join(tmpdir(), 'vbn-mk-'));
    dirs.push(dir);
    return { dir, store: join(dir, 'gateway.db'), key: join(dir, 'master.key') };
  }

  function depsFor(
    paths: { store: string; key: string },
    lines: string[] = [],
    extra: Record<string, string | undefined> = {},
  ): RootDeps {
    return {
      loadConfig: () =>
        loadBootConfig({
          env: validEnv({
            VAUBAAN_STORE_PATH: paths.store,
            VAUBAAN_MASTER_KEY: undefined,
            VAUBAAN_MASTER_KEY_FILE: paths.key,
            VAUBAAN_MASTER_KEY_GENERATE: '1',
            ...extra,
          }),
          scrub: false,
        }),
      logWrite: (_lvl, line) => lines.push(line),
    };
  }

  async function boot(
    paths: { store: string; key: string },
    lines: string[] = [],
    extra: Record<string, string | undefined> = {},
  ): Promise<GatewayRoot> {
    const root = await buildRoot(depsFor(paths, lines, extra));
    roots.push(root);
    return root;
  }

  it('writes the key file (0600, 32 bytes base64), logs one line, remembers it in the store, and boots', async () => {
    const paths = dataDir();
    const lines: string[] = [];
    const root = await boot(paths, lines);

    expect(existsSync(paths.key)).toBe(true);
    expect(statSync(paths.key).mode & 0o777).toBe(0o600);
    const text = readFileSync(paths.key, 'utf8');
    expect(text).toMatch(/^[A-Za-z0-9+/]{43}=\n$/);
    expect(Buffer.from(root.config.encryption.masterKey).toString('base64')).toBe(text.trim());
    expect(root.config.encryption.masterKeyFile).toBe(paths.key);

    const log = lines.join('\n');
    expect(log).toContain(
      '"msg":"master key generated at the first start: the setup hands it over"',
    );
    expect(log).toContain(`"path":"${paths.key}"`);
    expect(log).not.toContain(text.trim());

    expect(await root.store.config.get(MASTER_KEY_GENERATED_KEY)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await root.masterKey.service.state()).toMatchObject({
      file: paths.key,
      handedOverAt: null,
      handoverPending: true,
    });
  });

  it('reuses the file at the next start: the secret sealed before still opens, nothing is generated again', async () => {
    const paths = dataDir();
    const first = await boot(paths);
    const key = readFileSync(paths.key, 'utf8');
    await first.store.config.setSecret(
      'sign_in.company.client_secret',
      'sealed-under-the-generated-key',
    );
    await first.close();
    roots.splice(roots.indexOf(first), 1);

    const lines: string[] = [];
    const second = await boot(paths, lines);
    expect(readFileSync(paths.key, 'utf8')).toBe(key);
    expect(lines.join('\n')).not.toContain('master key generated');
    await expect(second.store.config.getSecret('sign_in.company.client_secret')).resolves.toBe(
      'sealed-under-the-generated-key',
    );
    expect((await second.masterKey.service.state()).generatedAt).not.toBeNull();
  });

  it('refuses to generate when the store already holds data (exit 78, no file written)', async () => {
    const paths = dataDir();
    const first = await boot(paths);
    await first.close();
    roots.splice(roots.indexOf(first), 1);
    rmSync(paths.key); // the operator lost the key file; the store is there

    let out = '';
    let code: number | null = null;
    await bootOrExit(depsFor(paths), { stderr: (t) => (out += t), exit: (c) => (code = c) });
    expect(code).toBe(EXIT_CONFIG_ERROR);
    expect(out).toContain('encryption.master_key');
    expect(out).toContain('already holds data');
    expect(out).toContain('never a reason to generate a new one');
    expect(existsSync(paths.key)).toBe(false);
  });

  it('without the opt-in a missing key file stops the start as before (exit 78)', async () => {
    const paths = dataDir();
    let out = '';
    let code: number | null = null;
    await bootOrExit(depsFor(paths, [], { VAUBAAN_MASTER_KEY_GENERATE: undefined }), {
      stderr: (t) => (out += t),
      exit: (c) => (code = c),
    });
    expect(code).toBe(EXIT_CONFIG_ERROR);
    expect(out).toContain(`encryption.master_key: cannot read secret file "${paths.key}"`);
    expect(existsSync(paths.key)).toBe(false);
    expect(existsSync(paths.store)).toBe(false);
  });

  it('an empty store file counts as no store: the key is generated', async () => {
    const paths = dataDir();
    writeFileSync(paths.store, '');
    const root = await boot(paths);
    expect(existsSync(paths.key)).toBe(true);
    expect(root.store.kind).toBe('sqlite');
  });
});
