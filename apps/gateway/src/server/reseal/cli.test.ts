import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { loadInstanceConfig, type LoadedConfig } from '../config';
import { validEnv } from '../../../tests/support/config/testing';
import { createEncryptor, type EncryptedBlob, type Encryptor } from '../crypto';
import { openMemoryStore, SetCatalogIndex, type Store } from '../store';
import {
  EXIT_CONFIG,
  EXIT_INCOMPLETE,
  EXIT_NO_PERMISSION,
  EXIT_OK,
  EXIT_USAGE,
  parseResealArgs,
  runResealCli,
  type ResealDeps,
} from './cli';

const OLD_KEY = randomBytes(32).toString('base64');
const NEW_KEY = randomBytes(32).toString('base64');

class SwitchableEncryptor implements Encryptor {
  constructor(public inner: Encryptor) {}
  get currentKeyVersion(): number {
    return this.inner.currentKeyVersion;
  }
  encrypt(ad: string, plain: string): Promise<EncryptedBlob> {
    return this.inner.encrypt(ad, plain);
  }
  decrypt(ad: string, sealed: EncryptedBlob): Promise<string> {
    return this.inner.decrypt(ad, sealed);
  }
}

function rotatedConfig(previous: string | undefined = `1=${OLD_KEY}`): LoadedConfig {
  return loadInstanceConfig({
    env: validEnv({
      VAUBAAN_MASTER_KEY: NEW_KEY,
      VAUBAAN_MASTER_KEY_VERSION: '2',
      VAUBAAN_MASTER_KEY_PREVIOUS: previous,
    }),
  });
}

/** A store whose two credentials were sealed under version 1, reopened with the CLI's encryptor. */
async function seededDeps(loaded: LoadedConfig): Promise<{ deps: ResealDeps; store: Store }> {
  const switchable = new SwitchableEncryptor(
    await createEncryptor({
      masterKey: new Uint8Array(Buffer.from(OLD_KEY, 'base64')),
      keyVersion: 1,
      previousKeys: new Map(),
    }),
  );
  const store = openMemoryStore({ encryptor: switchable, catalog: new SetCatalogIndex([]) });
  const user = await store.users.upsertFromIdp({
    issuer: 'https://idp.example.com',
    subject: 's',
    email: 's@example.com',
  });
  for (const credential of ['one', 'two']) {
    await store.connections.create({
      provider: 'github',
      owner: { kind: 'user', id: user.id },
      displayName: credential,
      credential,
    });
  }
  return {
    store,
    deps: {
      loadConfig: () => loaded,
      storeExists: () => true,
      catalog: async () => new SetCatalogIndex([]),
      openStore: async (ctx) => {
        switchable.inner = ctx.encryptor;
        return { ...store, close: async () => undefined };
      },
    },
  };
}

function capture(uid: number | null = 10001): {
  io: { stdout: (t: string) => void; stderr: (t: string) => void; uid: number | null };
  out: () => string;
  err: () => string;
} {
  let out = '';
  let err = '';
  return {
    io: { stdout: (t) => (out += t), stderr: (t) => (err += t), uid },
    out: () => out,
    err: () => err,
  };
}

describe('reseal command', () => {
  it('parses --apply and --help; never echoes an unknown argument', () => {
    expect(parseResealArgs([])).toEqual({ kind: 'run', apply: false });
    expect(parseResealArgs(['--apply'])).toEqual({ kind: 'run', apply: true });
    expect(parseResealArgs(['--help'])).toEqual({ kind: 'help' });
    const usage = parseResealArgs([NEW_KEY]);
    expect(usage).toEqual({ kind: 'usage', problem: 'unknown argument #1' });
  });

  it('refuses root and an unknown argument', async () => {
    const root = capture(0);
    expect(await runResealCli([], root.io)).toBe(EXIT_NO_PERMISSION);
    const bad = capture();
    expect(await runResealCli([NEW_KEY], bad.io)).toBe(EXIT_USAGE);
    expect(bad.err()).not.toContain(NEW_KEY);
  });

  it('refuses to run without a store file', async () => {
    const run = capture();
    const code = await runResealCli([], run.io, {
      loadConfig: () => rotatedConfig(),
      storeExists: () => false,
    });
    expect(code).toBe(EXIT_CONFIG);
    expect(run.err()).toContain('no store');
  });

  it('a dry run reports what it would reseal and writes nothing', async () => {
    const loaded = rotatedConfig();
    const { deps, store } = await seededDeps(loaded);
    const run = capture();
    expect(await runResealCli([], run.io, deps)).toBe(EXIT_OK);
    expect(run.out()).toContain('dry run');
    expect(run.out()).toMatch(/connections\s+0\s+0\s+2\s+0\s+0/);
    expect((await store.sealedBlobs.versions()).map((v) => v.keyVersion)).toEqual([1]);
  });

  it('--apply reseals, then says the previous key can be removed; never prints a key', async () => {
    const loaded = rotatedConfig();
    const { deps, store } = await seededDeps(loaded);
    const run = capture();
    expect(await runResealCli(['--apply'], run.io, deps)).toBe(EXIT_OK);
    expect(run.out()).toMatch(/connections\s+0\s+0\s+2\s+0\s+0/);
    expect(run.out()).toContain('VAUBAAN_MASTER_KEY_PREVIOUS can now be removed');
    expect(run.out() + run.err()).not.toContain(OLD_KEY);
    expect(run.out() + run.err()).not.toContain(NEW_KEY);
    expect((await store.sealedBlobs.versions()).map((v) => v.keyVersion)).toEqual([2]);

    const again = capture();
    expect(await runResealCli(['--apply'], again.io, deps)).toBe(EXIT_OK);
    expect(again.out()).toMatch(/connections\s+2\s+0\s+0\s+0\s+0/);
  });

  it('exits 1 and keeps the previous key when a blob does not open', async () => {
    const loaded = rotatedConfig(`1=${randomBytes(32).toString('base64')}`);
    const { deps } = await seededDeps(loaded);
    const run = capture();
    expect(await runResealCli(['--apply'], run.io, deps)).toBe(EXIT_INCOMPLETE);
    expect(run.out()).toContain('2 blob(s) did not open');
    expect(run.out()).toContain('blobs remain under version(s) 1');
  });
  it('the confirmation dry run states the verdict: nothing to reseal, PREVIOUS can go (re-check H-2)', async () => {
    const loaded = rotatedConfig();
    const { deps } = await seededDeps(loaded);
    expect(await runResealCli(['--apply'], capture().io, deps)).toBe(EXIT_OK);
    const confirm = capture();
    expect(await runResealCli([], confirm.io, deps)).toBe(EXIT_OK);
    expect(confirm.out()).toContain('nothing to reseal');
    expect(confirm.out()).toContain('VAUBAAN_MASTER_KEY_PREVIOUS can now be removed');
    expect(confirm.out()).not.toContain('run with --apply');
  });

  it('a new key set without raising its version: current blobs do not open, exit 1 (re-check M-1)', async () => {
    const loaded = loadInstanceConfig({
      env: validEnv({ VAUBAAN_MASTER_KEY: NEW_KEY, VAUBAAN_MASTER_KEY_VERSION: undefined }),
    });
    const { deps } = await seededDeps(loaded);
    const run = capture();
    expect(await runResealCli([], run.io, deps)).toBe(EXIT_INCOMPLETE);
    expect(run.out()).toMatch(/connections\s+2\s+2\s+0\s+0\s+0/);
    expect(run.out()).toContain('do not open: the current key');
    expect(run.out()).not.toContain('can now be removed');
  });
});
