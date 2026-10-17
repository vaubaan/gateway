/**
 * Restore of a store copy (ADR restore-verifies-before-it-replaces-and-runs-at-first-boot),
 * against real SQLite files in a temporary directory: the copy is made the way the
 * `backup` command makes it (`VACUUM INTO` of a store holding a sealed secret), then
 * restored from a file or from an https URL served by a fake `fetch`.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openEmbeddedStore } from '../../../src/server/compose/store';
import { buildRoot, type GatewayRoot } from '../../../src/server/compose/root';
import { ConfigError, loadInstanceConfig, secretValues } from '../../../src/server/config';
import { validEnv } from '../../../src/server/config/testing';
import { createEncryptor } from '../../../src/server/crypto';
import { RestoreError, restoreStore } from '../../../src/server/restore/restore';
import { openStore, SetCatalogIndex } from '../../../src/server/store';
import { backupTo, openDb, openReadonlyDb } from '../../../src/server/store/db';

const KEY = randomBytes(32).toString('base64');
const OTHER_KEY = randomBytes(32).toString('base64');
const SECRET = 'company-secret-to-carry';
const URL_TEXT = 'https://bucket.example.com/backup.sqlite?X-Amz-Signature=presigned-secret-part';
const MB = 1024 * 1024;

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function envFor(storePath: string, extra: Record<string, string | undefined> = {}) {
  return validEnv({
    VAUBAAN_STORE_PATH: storePath,
    VAUBAAN_MASTER_KEY: KEY,
    VAUBAAN_MASTER_KEY_VERSION: '3',
    ...extra,
  });
}

/** A fake `fetch` serving `body` at the presigned URL, with optional redirects in front. */
function fakeFetch(
  body: Buffer,
  options: { redirects?: Record<string, string>; contentLength?: boolean } = {},
): { fetch: typeof fetch; requested: string[] } {
  const requested: string[] = [];
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const href = input instanceof URL ? input.href : String(input);
    requested.push(href);
    const target = options.redirects?.[href];
    if (target) return new Response(null, { status: 302, headers: { location: target } });
    if (href !== URL_TEXT) return new Response('no', { status: 404 });
    const headers: Record<string, string> =
      options.contentLength === false ? {} : { 'content-length': String(body.byteLength) };
    // A stream, so no content-length is implied when the test leaves it out.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < body.byteLength; i += 4096) {
          controller.enqueue(new Uint8Array(body.subarray(i, i + 4096)));
        }
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers });
  };
  return { fetch: impl, requested };
}

describe('restore of a store copy', () => {
  let dir: string;
  let backup: string;
  let backupSha: string;
  let target: string;

  async function encryptorFor(extra: Record<string, string | undefined> = {}) {
    return createEncryptor(loadInstanceConfig({ env: envFor(target, extra) }).config.encryption);
  }

  async function restore(
    overrides: Partial<Parameters<typeof restoreStore>[0]> = {},
  ): Promise<Awaited<ReturnType<typeof restoreStore>>> {
    return restoreStore({
      source: { kind: 'file', path: backup },
      sha256: backupSha,
      maxBytes: 64 * MB,
      storePath: target,
      encryptor: await encryptorFor(),
      keyVersions: [3],
      ...overrides,
    });
  }

  async function refusal(promise: Promise<unknown>): Promise<RestoreError> {
    const err = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RestoreError);
    return err as RestoreError;
  }

  function onlyFilesIn(path: string): string[] {
    return readdirSync(path).sort();
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vaubaan-restore-'));
    const source = join(dir, 'old', 'gateway.db');
    mkdirSync(join(dir, 'old'));
    mkdirSync(join(dir, 'new'));
    const encryptor = await createEncryptor(
      loadInstanceConfig({ env: envFor(source) }).config.encryption,
    );
    const store = openStore({ path: source, encryptor, catalog: new SetCatalogIndex([]) });
    await store.config.setSecret('idp.client_secret', SECRET);
    await store.close();
    backup = join(dir, 'old', 'backup.sqlite');
    const db = openReadonlyDb(source);
    backupTo(db, backup);
    db.close();
    backupSha = sha256Of(backup);
    target = join(dir, 'new', 'gateway.db');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('restores a good copy from a file: verified, renamed into place, its secrets open', async () => {
    const report = await restore();
    expect(report.installed).toBe(true);
    expect(report.integrity).toBe('ok');
    expect(report.sha256).toBe(backupSha);
    expect(report.schemaVersion).toBe(report.shippedSchemaVersion);
    expect(report.keyVersions).toEqual([
      { keyVersion: 3, blobs: 1, unreadable: 0, configured: true },
    ]);
    expect(onlyFilesIn(join(dir, 'new'))).toEqual(['gateway.db']);
    expect(statSync(target).mode & 0o777).toBe(0o600);

    const store = openStore({
      path: target,
      encryptor: await encryptorFor(),
      catalog: new SetCatalogIndex([]),
    });
    expect(await store.config.getSecret('idp.client_secret')).toBe(SECRET);
    await store.close();
  });

  it('a dry run checks everything and writes nothing', async () => {
    const report = await restore({ dryRun: true });
    expect(report.installed).toBe(false);
    expect(report.keyVersions.map((k) => k.keyVersion)).toEqual([3]);
    expect(onlyFilesIn(join(dir, 'new'))).toEqual([]);
  });

  it('refuses a wrong SHA-256 before reading anything else, and leaves no file', async () => {
    const err = await refusal(restore({ sha256: 'a'.repeat(64) }));
    expect(err.kind).toBe('verify');
    expect(err.message).toContain('SHA-256 mismatch');
    expect(err.report?.integrity).toBe('not checked');
    expect(onlyFilesIn(join(dir, 'new'))).toEqual([]);
  });

  it('refuses a tampered copy: by its hash, and by SQLite when the hash is of the tampered file', async () => {
    // Corrupt a live table page; a rebuilt schema can leave free pages in the middle.
    const db = openDb({ path: backup });
    const rootPage = db
      .prepare<[], { rootpage: number }>("SELECT rootpage FROM sqlite_master WHERE name = 'users'")
      .get()!.rootpage;
    const pageSize = db.pragma('page_size', { simple: true }) as number;
    db.close();
    const bytes = readFileSync(backup);
    bytes.fill(0x5a, (rootPage - 1) * pageSize, (rootPage - 1) * pageSize + 2048);
    writeFileSync(backup, bytes);
    const byHash = await refusal(restore());
    expect(byHash.message).toContain('SHA-256 mismatch');
    const bySqlite = await refusal(restore({ sha256: sha256Of(backup) }));
    expect(bySqlite.kind).toBe('verify');
    expect(bySqlite.message).toMatch(/integrity_check failed|not an SQLite database/);
    expect(onlyFilesIn(join(dir, 'new'))).toEqual([]);
  });

  it('refuses a file that is not a store of this gateway', async () => {
    writeFileSync(backup, 'not a database at all');
    const err = await refusal(restore({ sha256: sha256Of(backup) }));
    expect(err.kind).toBe('verify');
    const empty = join(dir, 'old', 'empty.sqlite');
    const db = openDb({ path: empty });
    db.exec('CREATE TABLE t (x INTEGER)');
    db.close();
    const noSchema = await refusal(
      restore({ source: { kind: 'file', path: empty }, sha256: null }),
    );
    expect(noSchema.message).toContain('no schema_migrations');
  });

  it('refuses a copy newer than this image, accepts an older one', async () => {
    const db = openDb({ path: backup });
    db.prepare(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (9999, 'from_the_future', 'x', '2030-01-01T00:00:00.000Z')",
    ).run();
    db.close();
    const err = await refusal(restore({ sha256: sha256Of(backup) }));
    expect(err.kind).toBe('verify');
    expect(err.message).toContain('newer than this image');
    expect(err.message).toContain('9999_from_the_future');

    // Older: the last migration is not recorded (as if an earlier image wrote it).
    const older = openDb({ path: backup });
    older.prepare('DELETE FROM schema_migrations WHERE version >= 16').run();
    older.close();
    const report = await restore({ sha256: sha256Of(backup), dryRun: true });
    expect(report.schemaVersion).toBe(15);
    expect(report.shippedSchemaVersion).toBe(16);
  });

  it('refuses a copy whose key version this instance does not hold, or whose key does not fit', async () => {
    const noKey = await refusal(
      restore({
        encryptor: await encryptorFor({
          VAUBAAN_MASTER_KEY: OTHER_KEY,
          VAUBAAN_MASTER_KEY_VERSION: '4',
        }),
        keyVersions: [4],
      }),
    );
    expect(noKey.kind).toBe('verify');
    expect(noKey.message).toContain('version 3: no key configured');
    expect(noKey.report?.keyVersions).toEqual([
      { keyVersion: 3, blobs: 1, unreadable: 1, configured: false },
    ]);

    const wrongKey = await refusal(
      restore({ encryptor: await encryptorFor({ VAUBAAN_MASTER_KEY: OTHER_KEY }) }),
    );
    expect(wrongKey.message).toContain('do not open with the key configured for it');

    // The new instance's key, with the old one as previous: accepted, reseal later.
    const report = await restore({
      encryptor: await encryptorFor({
        VAUBAAN_MASTER_KEY: OTHER_KEY,
        VAUBAAN_MASTER_KEY_VERSION: '4',
        VAUBAAN_MASTER_KEY_PREVIOUS: `3=${KEY}`,
      }),
      keyVersions: [4, 3],
      dryRun: true,
    });
    expect(report.keyVersions).toEqual([
      { keyVersion: 3, blobs: 1, unreadable: 0, configured: true },
    ]);
  });

  it('never overwrites an existing store unless forced; forced, keeps the old one aside', async () => {
    writeFileSync(target, 'the live store');
    const err = await refusal(restore());
    expect(err.kind).toBe('exists');
    expect(readFileSync(target, 'utf8')).toBe('the live store');
    expect(onlyFilesIn(join(dir, 'new'))).toEqual(['gateway.db']);

    const now = new Date('2026-10-16T09:00:00.000Z');
    // A file that is not SQLite holds no connection: the forced restore goes ahead.
    const report = await restore({ force: true, now: () => now });
    expect(report.storeExisted).toBe(true);
    const aside = `${target}.replaced-2026-10-16T09-00-00-000Z`;
    expect(report.movedAside).toEqual([aside]);
    expect(readFileSync(aside, 'utf8')).toBe('the live store');
    expect(sha256Of(target)).toBe(backupSha);
  });

  it('an empty store file counts as no store', async () => {
    writeFileSync(target, '');
    const report = await restore();
    expect(report.installed).toBe(true);
    expect(report.storeExisted).toBe(false);
  });

  it('refuses to force over a store another connection holds', async () => {
    const live = openDb({ path: target });
    live.exec('CREATE TABLE t (x INTEGER)');
    try {
      const err = await refusal(restore({ force: true }));
      expect(err.kind).toBe('in-use');
    } finally {
      live.close();
    }
    expect(existsSync(`${target}.replaced`)).toBe(false);
  });

  it('caps the size of a local copy', async () => {
    const err = await refusal(restore({ maxBytes: 1024 }));
    expect(err.kind).toBe('source');
    expect(err.message).toContain('restore.max_mb');
  });

  describe('from an https URL', () => {
    const urlSource = { kind: 'url' as const, url: new URL(URL_TEXT) };

    it('downloads, verifies and installs; follows an https redirect', async () => {
      const first = 'https://short.example.com/b';
      const net = fakeFetch(readFileSync(backup), { redirects: { [first]: URL_TEXT } });
      const report = await restore({
        source: { kind: 'url', url: new URL(first) },
        fetch: net.fetch,
      });
      expect(report.installed).toBe(true);
      expect(net.requested).toEqual([first, URL_TEXT]);
      expect(sha256Of(target)).toBe(backupSha);
    });

    it('needs the expected SHA-256 and checks it', async () => {
      const net = fakeFetch(readFileSync(backup));
      const without = await refusal(restore({ source: urlSource, sha256: null, fetch: net.fetch }));
      expect(without.message).toContain('needs its expected SHA-256');
      expect(net.requested).toEqual([]);
      const wrong = await refusal(
        restore({ source: urlSource, sha256: 'b'.repeat(64), fetch: net.fetch }),
      );
      expect(wrong.message).toContain('SHA-256 mismatch');
      expect(onlyFilesIn(join(dir, 'new'))).toEqual([]);
    });

    it('refuses a redirect to plain http, and never names the URL', async () => {
      const net = fakeFetch(readFileSync(backup), {
        redirects: { [URL_TEXT]: 'http://bucket.example.com/backup.sqlite' },
      });
      const err = await refusal(restore({ source: urlSource, fetch: net.fetch }));
      expect(err.kind).toBe('download');
      expect(err.message).toContain('not https');
      expect(err.message).not.toContain('bucket.example.com');
    });

    it('caps the size: by Content-Length before reading, and while streaming without one', async () => {
      const declared = fakeFetch(readFileSync(backup));
      const early = await refusal(
        restore({ source: urlSource, fetch: declared.fetch, maxBytes: 1024 }),
      );
      expect(early.kind).toBe('download');
      expect(early.message).toContain('restore.max_mb');
      const streamed = fakeFetch(readFileSync(backup), { contentLength: false });
      const late = await refusal(
        restore({ source: urlSource, fetch: streamed.fetch, maxBytes: 1024 }),
      );
      expect(late.kind).toBe('download');
      expect(onlyFilesIn(join(dir, 'new'))).toEqual([]);
    });

    it('reports a network failure by its code, never its message', async () => {
      const failing = (async () => {
        throw Object.assign(new TypeError(`fetch failed for ${URL_TEXT}`), {
          cause: { code: 'ENOTFOUND' },
        });
      }) as typeof fetch;
      const err = await refusal(restore({ source: urlSource, fetch: failing }));
      expect(err.message).toBe('the download failed (ENOTFOUND)');
    });
  });

  describe('configuration', () => {
    it('refuses an http source naming the key, never the value', () => {
      const err = (() => {
        try {
          loadInstanceConfig({
            env: envFor(target, {
              VAUBAAN_RESTORE_FROM: 'http://bucket.example.com/x?sig=leak',
              VAUBAAN_RESTORE_SHA256: backupSha,
            }),
          });
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(ConfigError);
      const message = (err as ConfigError).message;
      expect(message).toContain('restore.from: must use https');
      expect(message).not.toContain('leak');
    });

    it('requires the SHA-256 with the source, and a well-formed one', () => {
      expect(() =>
        loadInstanceConfig({ env: envFor(target, { VAUBAAN_RESTORE_FROM: URL_TEXT }) }),
      ).toThrow(/restore\.sha256: required with restore\.from/);
      expect(() =>
        loadInstanceConfig({
          env: envFor(target, { VAUBAAN_RESTORE_FROM: URL_TEXT, VAUBAAN_RESTORE_SHA256: 'xyz' }),
        }),
      ).toThrow(/restore\.sha256: expected 64 hexadecimal characters/);
    });

    it('treats the source as a secret: redacted, and deleted from the environment after load', () => {
      const loaded = loadInstanceConfig({
        env: envFor(target, {
          VAUBAAN_RESTORE_FROM: URL_TEXT,
          VAUBAAN_RESTORE_SHA256: backupSha.toUpperCase(),
        }),
      });
      expect(loaded.config.restore.sha256).toBe(backupSha);
      expect(loaded.config.restore.maxBytes).toBe(1024 * MB);
      expect(loaded.secretEnvNames).toContain('VAUBAAN_RESTORE_FROM');
      expect(loaded.secretEnvNames).not.toContain('VAUBAAN_RESTORE_SHA256');
      expect(secretValues(loaded.config)).toContain(URL_TEXT);
    });
  });

  describe('at first boot', () => {
    const roots: GatewayRoot[] = [];
    afterEach(async () => {
      await Promise.all(roots.splice(0).map((r) => r.close()));
    });

    function bootWith(extra: Record<string, string>, lines: string[], net?: typeof fetch) {
      return buildRoot({
        loadConfig: () => loadInstanceConfig({ env: envFor(target, extra) }),
        logWrite: (_level, line) => lines.push(line),
        openStore: (ctx) => openEmbeddedStore({ ...ctx, restoreFetch: net }),
      });
    }

    it('restores before the store opens, migrates, then ignores the variables on the next boot', async () => {
      const net = fakeFetch(readFileSync(backup));
      const lines: string[] = [];
      const env = { VAUBAAN_RESTORE_FROM: URL_TEXT, VAUBAAN_RESTORE_SHA256: backupSha };
      const root = await bootWith(env, lines, net.fetch);
      roots.push(root);
      expect(await root.store.config.getSecret('idp.client_secret')).toBe(SECRET);
      const log = lines.join('\n');
      expect(log).toContain('"msg":"store restored"');
      expect(log).toContain('"msg":"store opened"');
      expect(log).not.toContain('presigned-secret-part');
      expect(log).not.toContain('bucket.example.com');
      await root.close();
      roots.splice(0);

      const again: string[] = [];
      const second = await bootWith(env, again, net.fetch);
      roots.push(second);
      expect(net.requested).toEqual([URL_TEXT]);
      const warnings = again.filter((l) => l.includes('restore.from is set but the store exists'));
      expect(warnings).toHaveLength(1);
      expect(again.join('\n')).not.toContain('presigned-secret-part');
    });

    it('a refused restore stops the boot and leaves no store, so the next start tries again', async () => {
      const net = fakeFetch(readFileSync(backup));
      const lines: string[] = [];
      const err = await bootWith(
        { VAUBAAN_RESTORE_FROM: URL_TEXT, VAUBAAN_RESTORE_SHA256: 'c'.repeat(64) },
        lines,
        net.fetch,
      ).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toContain('restore at first boot refused (verify)');
      expect(err?.message).not.toContain('presigned-secret-part');
      expect(existsSync(target)).toBe(false);
      expect(onlyFilesIn(join(dir, 'new'))).toEqual([]);
      expect(lines.join('\n')).not.toContain('presigned-secret-part');
    });

    it('restores from a local file too', async () => {
      const lines: string[] = [];
      const root = await bootWith(
        { VAUBAAN_RESTORE_FROM: backup, VAUBAAN_RESTORE_SHA256: backupSha },
        lines,
      );
      roots.push(root);
      expect(await root.store.config.getSecret('idp.client_secret')).toBe(SECRET);
    });
  });
});
