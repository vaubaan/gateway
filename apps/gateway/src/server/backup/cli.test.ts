import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadInstanceConfig } from '../config';
import { validEnv } from '../../../tests/support/config/testing';
import { createEncryptor } from '../crypto';
import { openStore, SetCatalogIndex } from '../store';
import {
  defaultBackupName,
  EXIT_CANNOT_CREATE,
  EXIT_CONFIG,
  EXIT_NO_PERMISSION,
  EXIT_OK,
  EXIT_USAGE,
  runBackupCli,
} from './cli';

const KEY = randomBytes(32).toString('base64');

function capture(uid: number | null = 10001) {
  let out = '';
  let err = '';
  return {
    io: { stdout: (t: string) => (out += t), stderr: (t: string) => (err += t), uid },
    out: () => out,
    err: () => err,
  };
}

describe('backup command', () => {
  let dir: string;
  let storePath: string;
  const loadConfig = () =>
    loadInstanceConfig({
      env: validEnv({
        VAUBAAN_STORE_PATH: storePath,
        VAUBAAN_MASTER_KEY: KEY,
        VAUBAAN_MASTER_KEY_VERSION: '3',
      }),
    });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vaubaan-backup-'));
    storePath = join(dir, 'gateway.db');
    const encryptor = await createEncryptor(loadConfig().config.encryption);
    const store = openStore({ path: storePath, encryptor, catalog: new SetCatalogIndex([]) });
    await store.config.setSecret('idp.client_secret', 'company-secret');
    await store.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('copies the store beside it, checks the copy, names the key versions it needs', async () => {
    const run = capture();
    const now = new Date('2026-10-16T08:00:00.000Z');
    expect(await runBackupCli([], run.io, { loadConfig, now: () => now })).toBe(EXIT_OK);
    const target = join(dir, defaultBackupName(now));
    expect(existsSync(target)).toBe(true);
    expect(run.out()).toContain(target);
    expect(run.out()).toContain('integrity_check: ok');
    expect(run.out()).toContain('master key version(s) 3');
    expect(run.out()).not.toContain(KEY);
  });

  it('never overwrites a file, never writes elsewhere, refuses root', async () => {
    writeFileSync(join(dir, 'taken.sqlite'), 'x');
    expect(await runBackupCli(['taken.sqlite'], capture().io, { loadConfig })).toBe(
      EXIT_CANNOT_CREATE,
    );
    for (const bad of ['../escape.sqlite', '/tmp/x.sqlite', '.hidden', 'a b']) {
      expect(await runBackupCli([bad], capture().io, { loadConfig }), bad).toBe(EXIT_USAGE);
    }
    expect(await runBackupCli([], capture(0).io, { loadConfig })).toBe(EXIT_NO_PERMISSION);
  });

  it('refuses without a store file', async () => {
    rmSync(storePath);
    expect(await runBackupCli([], capture().io, { loadConfig })).toBe(EXIT_CONFIG);
  });
});
