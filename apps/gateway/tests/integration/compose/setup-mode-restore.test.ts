/**
 * Setup mode (ADR master-key-generated-and-handed-over-by-the-instance,
 * amendment): a new instance configured to restore a copy, with an empty store
 * and no key file, starts without a root and receives the key of the copy on
 * the setup page; the first-boot restore then runs with every verification.
 * Real files in a temporary directory: the copy is made as `backup` makes it.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bootOrExit, EXIT_CONFIG_ERROR, startInstance } from '../../../src/server/compose/boot';
import { getRoot, resetRoot } from '../../../src/server/compose/root';
import { loadInstanceConfig } from '../../../src/server/config';
import { validEnv } from '../../../src/server/config/testing';
import { createEncryptor } from '../../../src/server/crypto';
import { setupResponse } from '../../../src/server/http';
import {
  createSetupHandlers,
  currentSetup,
  KEY_FIELD,
  servedInSetupMode,
  SetupModeError,
  TOKEN_FIELD,
} from '../../../src/server/setup';
import { openStore, SetCatalogIndex } from '../../../src/server/store';
import { backupTo, openReadonlyDb } from '../../../src/server/store/db';

const KEY = randomBytes(32).toString('base64');
const SECRET = 'company-secret-to-carry';
const PUBLIC_URL = 'https://gateway.example.com';
const TOKEN = 'setup-' + randomBytes(24).toString('hex');

describe('setup mode: the setup receives the key for a restore', () => {
  let dir: string;
  let backup: string;
  let backupSha: string;
  let store: string;
  let keyFile: string;
  let env: Record<string, string>;
  let lines: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vbn-setup-'));
    mkdirSync(join(dir, 'old'));
    mkdirSync(join(dir, 'new'));
    const source = join(dir, 'old', 'gateway.db');
    const encryptor = await createEncryptor(
      loadInstanceConfig({ env: validEnv({ VAUBAAN_STORE_PATH: source, VAUBAAN_MASTER_KEY: KEY }) })
        .config.encryption,
    );
    const old = openStore({ path: source, encryptor, catalog: new SetCatalogIndex([]) });
    await old.config.setSecret('idp.client_secret', SECRET);
    await old.close();
    backup = join(dir, 'old', 'backup.sqlite');
    const db = openReadonlyDb(source);
    backupTo(db, backup);
    db.close();
    backupSha = createHash('sha256').update(readFileSync(backup)).digest('hex');
    store = join(dir, 'new', 'gateway.db');
    keyFile = join(dir, 'new', 'master.key');
    env = validEnv({
      VAUBAAN_PUBLIC_URL: PUBLIC_URL,
      VAUBAAN_STORE_PATH: store,
      VAUBAAN_MASTER_KEY: undefined,
      VAUBAAN_MASTER_KEY_FILE: keyFile,
      VAUBAAN_RESTORE_FROM: backup,
      VAUBAAN_RESTORE_SHA256: backupSha,
      VAUBAAN_BOOTSTRAP_TOKEN: TOKEN,
    });
    lines = [];
  });

  afterEach(async () => {
    await resetRoot();
    rmSync(dir, { recursive: true, force: true });
  });

  async function start() {
    const state = await startInstance({ env, logWrite: (_lvl, line) => lines.push(line) });
    const setup = currentSetup();
    if (state !== 'setup' || !setup) throw new Error(`expected setup mode, got ${state}`);
    return { setup, handlers: createSetupHandlers(setup) };
  }

  function receive(
    handlers: ReturnType<typeof createSetupHandlers>,
    fields: { token?: string; key?: string | null },
    origin: string = PUBLIC_URL,
  ): Promise<Response> {
    const form = new FormData();
    if (fields.token !== undefined) form.set(TOKEN_FIELD, fields.token);
    if (fields.key !== undefined && fields.key !== null) {
      form.set(KEY_FIELD, new Blob([fields.key]), 'vaubaan-master-key.txt');
    }
    return handlers.receiveKey(
      new Request(`${PUBLIC_URL}/api/setup/master-key`, {
        method: 'POST',
        headers: { origin },
        body: form,
      }),
    );
  }

  function location(res: Response): string | null {
    return res.headers.get('location');
  }

  it('starts without a root: no store, the environment scrubbed, 503-free health, every other path redirected', async () => {
    const { setup } = await start();
    expect(existsSync(store)).toBe(false);
    expect(existsSync(keyFile)).toBe(false);
    expect(setup.masterKeyFile).toBe(keyFile);
    expect(setup.config.publicUrl.origin).toBe(PUBLIC_URL);
    await expect(getRoot()).rejects.toBeInstanceOf(SetupModeError);
    // The secrets left the environment; the setup keeps what the final load needs.
    expect(env.VAUBAAN_RESTORE_FROM).toBeUndefined();
    expect(env.VAUBAAN_BOOTSTRAP_TOKEN).toBeUndefined();
    expect(env.VAUBAAN_MASTER_KEY_FILE).toBeUndefined();
    expect(env.VAUBAAN_STORE_PATH).toBe(store);

    const health = setupResponse({ build: setup.build, startedAt: setup.startedAt });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'setup' });
    for (const path of ['/admin/bootstrap', '/api/setup/master-key', '/healthz', '/_next/x']) {
      expect(servedInSetupMode(path), path).toBe(true);
    }
    for (const path of ['/', '/login', '/admin', '/mcp', '/api/admin/master-key/download']) {
      expect(servedInSetupMode(path), path).toBe(false);
    }
    const log = lines.join('\n');
    expect(log).toContain('"msg":"starting in setup mode');
    expect(log).not.toContain(backup);
    expect(log).not.toContain(TOKEN);
  });

  it('refuses a foreign origin, a wrong token, a missing key and a malformed key, writing nothing', async () => {
    const { setup, handlers } = await start();
    expect(
      (await receive(handlers, { token: TOKEN, key: KEY }, 'https://evil.example.com')).status,
    ).toBe(403);
    const wrong = await receive(handlers, { token: 'not-the-token-at-all-0123456789', key: KEY });
    expect(wrong.status).toBe(303);
    expect(location(wrong)).toBe('/admin/bootstrap?error=bootstrap-refused');
    expect(setup.misses).toBe(1);
    expect(location(await receive(handlers, { token: TOKEN }))).toBe(
      '/admin/bootstrap?error=key-missing',
    );
    expect(location(await receive(handlers, { token: TOKEN, key: 'not a key' }))).toBe(
      '/admin/bootstrap?error=key-invalid',
    );
    expect(location(await receive(handlers, { token: TOKEN, key: 'x'.repeat(5000) }))).toBe(
      '/admin/bootstrap?error=key-invalid',
    );
    expect(existsSync(keyFile)).toBe(false);
    expect(existsSync(store)).toBe(false);
    expect(currentSetup()).not.toBeNull();
    expect(lines.join('\n')).not.toContain(KEY);
  });

  it('a key that does not open the copy: the restore is refused, the key file removed, setup mode kept', async () => {
    const { setup, handlers } = await start();
    const other = randomBytes(32).toString('base64');
    const res = await receive(handlers, { token: TOKEN, key: other });
    expect(location(res)).toBe('/admin/bootstrap?error=restore-refused');
    expect(existsSync(keyFile)).toBe(false);
    expect(existsSync(store)).toBe(false);
    expect(currentSetup()).toBe(setup);
    expect(setup.lastRefusal?.message).toContain('restore at first boot refused (verify)');
    expect(setup.lastRefusal?.message).not.toContain(backup);
    await expect(getRoot()).rejects.toBeInstanceOf(SetupModeError);
    const log = lines.join('\n');
    expect(log).toContain('the boot refused the received key');
    expect(log).not.toContain(other);
  });

  it('the right key: written 0600, the copy verified and restored, the gateway serves', async () => {
    const { handlers } = await start();
    const res = await receive(handlers, { token: TOKEN, key: `${KEY}\n` });
    expect(res.status).toBe(303);
    expect(location(res)).toBe('/admin/bootstrap');
    expect(currentSetup()).toBeNull();
    expect(readFileSync(keyFile, 'utf8')).toBe(`${KEY}\n`);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);

    const root = await getRoot();
    expect(root.store.kind).toBe('sqlite');
    await expect(root.store.config.getSecret('idp.client_secret')).resolves.toBe(SECRET);
    expect((await root.masterKey.service.state()).generatedAt).toBeNull();
    const log = lines.join('\n');
    expect(log).toContain('"msg":"store restored"');
    expect(log).toContain('setup complete');
    expect(log).not.toContain(KEY);
    expect(log).not.toContain(backup);
  });

  it('a key file in a directory the empty volume does not have yet: the directory is created (0700)', async () => {
    const nested = join(dir, 'new', 'keys', 'master.key');
    env.VAUBAAN_MASTER_KEY_FILE = nested;
    const { handlers } = await start();
    const res = await receive(handlers, { token: TOKEN, key: `${KEY}\n` });
    expect(res.status).toBe(303);
    expect(currentSetup()).toBeNull();
    expect(readFileSync(nested, 'utf8')).toBe(`${KEY}\n`);
    expect(statSync(nested).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'new', 'keys')).mode & 0o777).toBe(0o700);
  });

  it('a second key while one is being installed is refused as busy', async () => {
    const { handlers } = await start();
    const [first, second] = await Promise.all([
      receive(handlers, { token: TOKEN, key: KEY }),
      receive(handlers, { token: TOKEN, key: KEY }),
    ]);
    const locations = [location(first), location(second)].sort();
    expect(locations).toEqual(['/admin/bootstrap', '/admin/bootstrap?error=key-busy']);
    expect(currentSetup()).toBeNull();
  });

  it('with a store that holds data, an absent key is a configuration error, not setup mode', async () => {
    const { handlers } = await start();
    await receive(handlers, { token: TOKEN, key: KEY });
    await resetRoot();
    rmSync(keyFile);
    let out = '';
    let code: number | null = null;
    await bootOrExit(
      {
        env: validEnv({
          ...env,
          VAUBAAN_MASTER_KEY: undefined,
          VAUBAAN_MASTER_KEY_FILE: keyFile,
          VAUBAAN_RESTORE_FROM: backup,
          VAUBAAN_RESTORE_SHA256: backupSha,
          VAUBAAN_BOOTSTRAP_TOKEN: TOKEN,
        }),
        logWrite: () => undefined,
      },
      { stderr: (t) => (out += t), exit: (c) => (code = c) },
    );
    expect(code).toBe(EXIT_CONFIG_ERROR);
    expect(out).toContain('the store already holds data');
    expect(currentSetup()).toBeNull();
  });

  it('without a bootstrap token the page can receive nothing', async () => {
    env = validEnv({
      ...env,
      VAUBAAN_MASTER_KEY: undefined,
      VAUBAAN_MASTER_KEY_FILE: keyFile,
      VAUBAAN_RESTORE_FROM: backup,
      VAUBAAN_RESTORE_SHA256: backupSha,
      VAUBAAN_BOOTSTRAP_TOKEN: undefined,
      VAUBAAN_SIGN_IN_GITHUB_KIND: 'github',
      VAUBAAN_SIGN_IN_GITHUB_CLIENT_ID: 'Ov23liExample',
      VAUBAAN_SIGN_IN_GITHUB_CLIENT_SECRET: 'gh-secret',
      VAUBAAN_SIGN_IN_GITHUB_INVITATION_ONLY: 'true',
    });
    const { setup, handlers } = await start();
    expect(setup.config.bootstrapToken).toBeNull();
    expect(location(await receive(handlers, { token: 'x', key: KEY }))).toBe(
      '/admin/bootstrap?error=no-bootstrap-token',
    );
  });
});
