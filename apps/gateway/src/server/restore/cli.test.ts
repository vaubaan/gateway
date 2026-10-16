import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadInstanceConfig } from '../config';
import { validEnv } from '../config/testing';
import { createEncryptor } from '../crypto';
import { openStore, SetCatalogIndex } from '../store';
import { backupTo, openReadonlyDb } from '../store/db';
import {
  EXIT_CANNOT_CREATE,
  EXIT_CONFIG,
  EXIT_DATA,
  EXIT_NO_INPUT,
  EXIT_NO_PERMISSION,
  EXIT_OK,
  EXIT_USAGE,
  parseRestoreArgs,
  runRestoreCli,
} from './cli';

const KEY = randomBytes(32).toString('base64');
const URL_TEXT = 'https://bucket.example.com/b.sqlite?X-Amz-Signature=cli-secret-part';

function capture(uid: number | null = 10001) {
  let out = '';
  let err = '';
  return {
    io: { stdout: (t: string) => (out += t), stderr: (t: string) => (err += t), uid },
    out: () => out,
    err: () => err,
    all: () => out + err,
  };
}

describe('restore command', () => {
  let dir: string;
  let backup: string;
  let sha: string;
  let storePath: string;
  let extraEnv: Record<string, string>;
  const loadConfig = () =>
    loadInstanceConfig({
      env: validEnv({
        VAUBAAN_STORE_PATH: storePath,
        VAUBAAN_MASTER_KEY: KEY,
        VAUBAAN_MASTER_KEY_VERSION: '2',
        ...extraEnv,
      }),
    });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vaubaan-restore-cli-'));
    extraEnv = {};
    const source = join(dir, 'source.db');
    storePath = source;
    const encryptor = await createEncryptor(loadConfig().config.encryption);
    const store = openStore({ path: source, encryptor, catalog: new SetCatalogIndex([]) });
    await store.config.setSecret('idp.client_secret', 'cli-secret');
    await store.close();
    backup = join(dir, 'backup.sqlite');
    const db = openReadonlyDb(source);
    backupTo(db, backup);
    db.close();
    sha = createHash('sha256').update(readFileSync(backup)).digest('hex');
    storePath = join(dir, 'gateway.db');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('parses its arguments without echoing a value', () => {
    expect(parseRestoreArgs(['/x.sqlite', '--sha256', 'A'.repeat(64), '--dry-run'])).toEqual({
      kind: 'run',
      source: '/x.sqlite',
      sha256: 'a'.repeat(64),
      dryRun: true,
      force: false,
      maxMb: null,
    });
    expect(parseRestoreArgs(['--max-mb=5', '--force'])).toMatchObject({ maxMb: 5, force: true });
    expect(parseRestoreArgs(['--help'])).toEqual({ kind: 'help' });
    const twoSources = parseRestoreArgs(['/a', URL_TEXT]);
    expect(twoSources).toEqual({ kind: 'usage', problem: 'unexpected argument #2' });
    const badSha = parseRestoreArgs(['--sha256', URL_TEXT]);
    expect(JSON.stringify(badSha)).not.toContain('cli-secret-part');
  });

  it('restores a file, prints the checks and the key versions, never a key', async () => {
    const run = capture();
    expect(await runRestoreCli([backup, '--sha256', sha], run.io, { loadConfig })).toBe(EXIT_OK);
    expect(existsSync(storePath)).toBe(true);
    expect(run.out()).toContain('integrity_check: ok');
    expect(run.out()).toContain(
      'master key version 2: 1 sealed secret(s), key configured, 1 open(s)',
    );
    expect(run.out()).toContain('the store is in place');
    expect(run.all()).not.toContain(KEY);
  });

  it('a dry run writes nothing', async () => {
    const run = capture();
    expect(await runRestoreCli([backup, '--dry-run'], run.io, { loadConfig })).toBe(EXIT_OK);
    expect(existsSync(storePath)).toBe(false);
    expect(run.out()).toContain('nothing was written');
  });

  it('never overwrites a store without --force (73), and replaces it with it', async () => {
    writeFileSync(storePath, 'live');
    expect(await runRestoreCli([backup], capture().io, { loadConfig })).toBe(EXIT_CANNOT_CREATE);
    expect(readFileSync(storePath, 'utf8')).toBe('live');
    const run = capture();
    expect(await runRestoreCli([backup, '--force'], run.io, { loadConfig })).toBe(EXIT_OK);
    expect(run.out()).toContain('kept aside:');
  });

  it('maps refusals to exit codes: wrong hash 65, missing file 66, http 64, root 77, no source 64', async () => {
    const wrong = capture();
    expect(
      await runRestoreCli([backup, '--sha256', 'f'.repeat(64)], wrong.io, { loadConfig }),
    ).toBe(EXIT_DATA);
    expect(wrong.err()).toContain('SHA-256 mismatch');
    expect(await runRestoreCli([join(dir, 'none.sqlite')], capture().io, { loadConfig })).toBe(
      EXIT_NO_INPUT,
    );
    const http = capture();
    expect(
      await runRestoreCli(['http://bucket.example.com/x?sig=cli-secret-part'], http.io, {
        loadConfig,
      }),
    ).toBe(EXIT_USAGE);
    expect(http.err()).toContain('must use https');
    expect(http.all()).not.toContain('cli-secret-part');
    expect(await runRestoreCli([URL_TEXT], capture().io, { loadConfig })).toBe(EXIT_USAGE);
    expect(await runRestoreCli([backup], capture(0).io, { loadConfig })).toBe(EXIT_NO_PERMISSION);
    expect(await runRestoreCli([], capture().io, { loadConfig })).toBe(EXIT_USAGE);
  });

  it('uses the configured source and hash when none is given, and never prints the URL', async () => {
    extraEnv = { VAUBAAN_RESTORE_FROM: URL_TEXT, VAUBAAN_RESTORE_SHA256: sha };
    const body = readFileSync(backup);
    const fetchImpl = (async () =>
      new Response(new Uint8Array(body), { status: 200 })) as typeof fetch;
    const run = capture();
    expect(await runRestoreCli([], run.io, { loadConfig, fetch: fetchImpl })).toBe(EXIT_OK);
    expect(run.out()).toContain('an https URL (not shown)');
    expect(run.all()).not.toContain('cli-secret-part');
    expect(existsSync(storePath)).toBe(true);
  });

  it('refuses an unconfigured instance (78)', async () => {
    const run = capture();
    const loadBroken = () =>
      loadInstanceConfig({ env: validEnv({ VAUBAAN_MASTER_KEY: undefined }) });
    expect(await runRestoreCli([backup], run.io, { loadConfig: loadBroken })).toBe(EXIT_CONFIG);
  });
});
