/**
 * The scheduled backup (ADR scheduled-encrypted-backup-to-object-storage) against real
 * SQLite files and an in-process S3-compatible server that checks every signature:
 * the upload, what it reports, the restore of what was uploaded (file, URL, after a
 * rotation), the self-check refusing a copy the keys do not open, an upload refused by
 * the storage, multipart, the retention, no overlap, and the schedule. Every key and
 * credential is generated here; none is real.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryAuditWriter } from '@vaubaan/gateway-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BackupService,
  BACKUP_STATUS_KEY,
  backupObjectKey,
  type BackupTimers,
} from '../../../src/server/backup';
import { CATCH_UP_DELAY_MS } from '../../../src/server/backup/scheduled';
import { backupStatusStore } from '../../../src/server/backup/status';
import { loadInstanceConfig, secretValues, type InstanceConfig } from '../../../src/server/config';
import { validEnv } from '../../../src/server/config/testing';
import { createEncryptor } from '../../../src/server/crypto';
import { healthResponse } from '../../../src/server/http/healthz';
import { createLogger, createRedactor } from '../../../src/server/logging';
import { RestoreError, restoreStore } from '../../../src/server/restore/restore';
import { openStore, SetCatalogIndex, type Store } from '../../../src/server/store';
import { startFakeS3, type FakeS3 } from './fake-s3';

const KEY_V1 = randomBytes(32).toString('base64');
const KEY_V2 = randomBytes(32).toString('base64');
const ACCESS_KEY_ID = 'TESTACCESSKEY';
const SECRET_ACCESS_KEY = randomBytes(24).toString('base64url');
const BUCKET = 'acme-backups';
const PREFIX = 'acme/';
const SECRET = 'company-secret-sealed-in-the-store';
const T0 = new Date('2026-10-21T10:15:00Z');

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Timers the test fires by hand. */
function manualTimers(): BackupTimers & { pending: { fn: () => void; ms: number }[] } {
  const pending: { fn: () => void; ms: number }[] = [];
  return {
    pending,
    setTimeout(fn, ms) {
      const entry = { fn, ms };
      pending.push(entry);
      return entry;
    },
    clearTimeout(handle) {
      const i = pending.indexOf(handle as { fn: () => void; ms: number });
      if (i >= 0) pending.splice(i, 1);
    },
  };
}

describe('the scheduled backup', () => {
  let dir: string;
  let storePath: string;
  let s3: FakeS3;
  let store: Store;
  let lines: string[];
  let audit: MemoryAuditWriter;

  function configFor(extra: Record<string, string | undefined> = {}): InstanceConfig {
    return loadInstanceConfig({
      env: validEnv({
        VAUBAAN_STORE_PATH: storePath,
        VAUBAAN_MASTER_KEY: KEY_V1,
        VAUBAAN_MASTER_KEY_VERSION: '1',
        VAUBAAN_BACKUP_S3_ENDPOINT: s3.endpoint,
        VAUBAAN_BACKUP_S3_REGION: 'auto',
        VAUBAAN_BACKUP_S3_BUCKET: BUCKET,
        VAUBAAN_BACKUP_S3_PREFIX: PREFIX,
        VAUBAAN_BACKUP_S3_PATH_STYLE: 'true',
        VAUBAAN_BACKUP_S3_ACCESS_KEY_ID: ACCESS_KEY_ID,
        VAUBAAN_BACKUP_S3_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
        ...extra,
      }),
    }).config;
  }

  async function serviceFor(
    config: InstanceConfig,
    options: {
      now?: () => Date;
      timers?: BackupTimers;
      upload?: { singlePutMaxBytes: number; partBytes: number };
    } = {},
  ): Promise<BackupService> {
    return new BackupService({
      config,
      store,
      encryptor: await createEncryptor(config.encryption),
      status: backupStatusStore(store.config),
      audit,
      logger: createLogger({
        level: 'debug',
        redact: createRedactor(secretValues(config)),
        write: (_level, line) => lines.push(line),
      }),
      now: options.now ?? (() => T0),
      timers: options.timers ?? manualTimers(),
      upload: options.upload,
    });
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vaubaan-backup-'));
    mkdirSync(join(dir, 'data'));
    storePath = join(dir, 'data', 'gateway.db');
    s3 = await startFakeS3(
      {
        accessKeyId: ACCESS_KEY_ID,
        secretAccessKey: SECRET_ACCESS_KEY,
        region: 'auto',
        service: 's3',
      },
      BUCKET,
    );
    const config = configFor();
    store = openStore({
      path: storePath,
      encryptor: await createEncryptor(config.encryption),
      catalog: new SetCatalogIndex([]),
    });
    await store.config.setSecret('idp.client_secret', SECRET);
    lines = [];
    audit = new MemoryAuditWriter();
  });

  afterEach(async () => {
    await store.close();
    await s3.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('uploads an encrypted, self-checked backup and reports it without a secret', async () => {
    const service = await serviceFor(configFor());
    const status = await service.runOnce();

    expect(status.lastOutcome).toBe('ok');
    expect(status.lastError).toBeNull();
    const key = backupObjectKey(PREFIX, T0);
    expect(key).toBe('acme/vaubaan-backup-20261021T101500Z.vbk');
    const object = s3.objects.get(key);
    expect(object).toBeDefined();
    if (!object) return;
    expect(object.body.subarray(0, 14).toString()).toBe('VAUBAAN-BACKUP');
    expect(object.body.includes(Buffer.from('SQLite format 3'))).toBe(false);
    expect(object.body.includes(Buffer.from(SECRET))).toBe(false);
    expect(object.metadata.sha256).toBe(sha256(object.body));
    expect(status.latest).toMatchObject({
      objectKey: key,
      bytes: object.body.length,
      sha256: sha256(object.body),
      keyVersion: 1,
      sealedKeyVersions: [1],
      selfCheck: 'passed',
    });
    expect(s3.operations).toEqual(['PutObject']);

    // Nothing left on the volume but the store.
    expect(readdirSync(join(dir, 'data')).filter((f) => !f.startsWith('gateway.db'))).toEqual([]);

    // The record survives in the store.
    const recorded = JSON.parse((await store.config.get(BACKUP_STATUS_KEY)) ?? '{}') as {
      lastOutcome?: string;
    };
    expect(recorded.lastOutcome).toBe('ok');

    // The activity.
    expect(audit.admin).toHaveLength(1);
    expect(audit.admin[0]).toMatchObject({
      act: 'backup-made',
      user_id: 'schedule',
      object: { type: 'instance-config', id: 'backup' },
    });

    // /healthz: the latest backup, and no endpoint, bucket or credential.
    const response = await healthResponse({
      store,
      logger: createLogger({ level: 'error', redact: (t) => t, write: () => undefined }),
      build: { version: 'test', commit: 'test' },
      startedAt: T0,
      backup: service,
    });
    const text = await response.text();
    const body = JSON.parse(text) as { backup: Record<string, unknown> };
    expect(body.backup).toMatchObject({
      configured: true,
      last_outcome: 'ok',
      schedule: { every_seconds: 86_400, at: '03:00', keep: 0 },
      latest: { object_key: key, sha256: sha256(object.body), self_check: 'passed' },
    });
    for (const secret of [SECRET_ACCESS_KEY, ACCESS_KEY_ID, BUCKET, s3.endpoint, KEY_V1]) {
      expect(text).not.toContain(secret);
    }
    for (const line of lines) {
      expect(line).not.toContain(SECRET_ACCESS_KEY);
      expect(line).not.toContain(KEY_V1);
    }
  });

  describe('the uploaded object restores', () => {
    async function uploaded(): Promise<{ file: string; sha: string; body: Buffer }> {
      await (await serviceFor(configFor())).runOnce();
      const body = s3.objects.get(backupObjectKey(PREFIX, T0))?.body ?? Buffer.alloc(0);
      const file = join(dir, 'downloaded.vbk');
      writeFileSync(file, body);
      return { file, sha: sha256(body), body };
    }

    async function restoreInto(
      source: Parameters<typeof restoreStore>[0]['source'],
      sha: string,
      env: Record<string, string | undefined>,
      fetchImpl?: typeof fetch,
    ) {
      mkdirSync(join(dir, 'new'), { recursive: true });
      const target = join(dir, 'new', 'gateway.db');
      const config = configFor({ VAUBAAN_STORE_PATH: target, ...env });
      const encryptor = await createEncryptor(config.encryption);
      const report = await restoreStore({
        source,
        sha256: sha,
        maxBytes: 64 * 1024 * 1024,
        storePath: target,
        encryptor,
        keyVersions: [config.encryption.keyVersion, ...config.encryption.previousKeys.keys()],
        masterKeys: config.encryption,
        fetch: fetchImpl,
      });
      return { report, target, encryptor };
    }

    it('from a file, with the sha256 of the object: its secrets open, its backup record is gone', async () => {
      const { file, sha } = await uploaded();
      const { report, target, encryptor } = await restoreInto(
        { kind: 'file', path: file },
        sha,
        {},
      );
      expect(report.installed).toBe(true);
      expect(report.encryption).toEqual({ keyVersion: 1, sealedKeyVersions: [1] });
      expect(report.sha256).toBe(sha);
      const restored = openStore({ path: target, encryptor, catalog: new SetCatalogIndex([]) });
      try {
        expect(await restored.config.getSecret('idp.client_secret')).toBe(SECRET);
        expect(await restored.config.get(BACKUP_STATUS_KEY)).toBeNull();
      } finally {
        await restored.close();
      }
    });

    it('from a presigned https URL, the way the first boot restores it', async () => {
      const { sha, body } = await uploaded();
      const url = 'https://bucket.example.com/acme/backup.vbk?X-Amz-Signature=presigned';
      const fetchImpl = (async (input: RequestInfo | URL) =>
        String(input) === url
          ? new Response(new Uint8Array(body), {
              status: 200,
              headers: { 'content-length': String(body.length) },
            })
          : new Response('no', { status: 404 })) as typeof fetch;
      const { report } = await restoreInto({ kind: 'url', url: new URL(url) }, sha, {}, fetchImpl);
      expect(report.installed).toBe(true);
      expect(report.encryption?.keyVersion).toBe(1);
    });

    it('after a rotation, with the previous key kept', async () => {
      const { file, sha } = await uploaded();
      const { report } = await restoreInto({ kind: 'file', path: file }, sha, {
        VAUBAAN_MASTER_KEY: KEY_V2,
        VAUBAAN_MASTER_KEY_VERSION: '2',
        VAUBAAN_MASTER_KEY_PREVIOUS: `1=${KEY_V1}`,
      });
      expect(report.installed).toBe(true);
      expect(report.encryption?.keyVersion).toBe(1);
    });

    it('is refused, naming the version, by an instance without its key', async () => {
      const { file, sha } = await uploaded();
      const err = await restoreInto({ kind: 'file', path: file }, sha, {
        VAUBAAN_MASTER_KEY: KEY_V2,
        VAUBAAN_MASTER_KEY_VERSION: '2',
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(RestoreError);
      expect((err as RestoreError).kind).toBe('verify');
      expect((err as RestoreError).message).toContain('master key version 1');
      expect(readdirSync(join(dir, 'new'))).toEqual([]);
    });

    it('is refused by a wrong SHA-256 before it is opened', async () => {
      const { file } = await uploaded();
      const err = await restoreInto({ kind: 'file', path: file }, 'b'.repeat(64), {}).then(
        () => null,
        (e: unknown) => e,
      );
      expect((err as RestoreError).message).toContain('SHA-256 mismatch');
    });
  });

  it('does not upload a copy that fails its self-check, and records why', async () => {
    // The store holds a secret sealed under key A as version 1; this configuration says
    // version 1 is key B: the copy is made and encrypted, then its secret does not open.
    const service = await serviceFor(
      configFor({ VAUBAAN_MASTER_KEY: randomBytes(32).toString('base64') }),
    );
    const status = await service.runOnce();
    expect(status.lastOutcome).toBe('failed');
    expect(status.lastError?.stage).toBe('self-check');
    expect(status.lastError?.message).toContain('do not open');
    expect(status.latest).toBeNull();
    expect(s3.objects.size).toBe(0);
    expect(s3.operations).toEqual([]);
    expect(audit.admin.map((e) => e.act)).toEqual(['backup-failed']);
    expect(readdirSync(join(dir, 'data')).filter((f) => !f.startsWith('gateway.db'))).toEqual([]);
  });

  it('records an upload the storage refused, and keeps the latest good backup', async () => {
    const config = configFor();
    let now = T0;
    const service = await serviceFor(config, { now: () => now });
    await service.runOnce();
    now = new Date(T0.getTime() + 86_400_000);
    s3.failNext('PutObject', 403, 'AccessDenied');
    const status = await service.runOnce();
    expect(status.lastOutcome).toBe('failed');
    expect(status.lastError).toEqual({
      stage: 'upload',
      message: 'PutObject: the storage answered 403 AccessDenied',
    });
    expect(status.lastAttemptAt).toBe(now.toISOString());
    expect(status.latest?.objectKey).toBe(backupObjectKey(PREFIX, T0));
    expect(JSON.stringify(status)).not.toContain(SECRET_ACCESS_KEY);
  });

  it('a wrong secret is refused by the storage as a signature mismatch', async () => {
    const service = await serviceFor(
      configFor({ VAUBAAN_BACKUP_S3_SECRET_ACCESS_KEY: 'not-the-right-secret' }),
    );
    const status = await service.runOnce();
    expect(status.lastError?.message).toBe(
      'PutObject: the storage answered 403 SignatureDoesNotMatch',
    );
  });

  it('uploads in parts above the single-PUT size, and the parts restore', async () => {
    const service = await serviceFor(configFor(), {
      upload: { singlePutMaxBytes: 1024, partBytes: 16 * 1024 },
    });
    const status = await service.runOnce();
    expect(status.lastOutcome).toBe('ok');
    expect(s3.operations[0]).toBe('CreateMultipartUpload');
    expect(s3.operations.filter((op) => op === 'UploadPart').length).toBeGreaterThan(1);
    expect(s3.operations.at(-1)).toBe('CompleteMultipartUpload');
    const body = s3.objects.get(backupObjectKey(PREFIX, T0))?.body ?? Buffer.alloc(0);
    expect(sha256(body)).toBe(status.latest?.sha256);
  });

  it('aborts a multipart upload that fails half-way', async () => {
    const service = await serviceFor(configFor(), {
      upload: { singlePutMaxBytes: 1024, partBytes: 16 * 1024 },
    });
    s3.failNext('CompleteMultipartUpload', 500, 'InternalError');
    const status = await service.runOnce();
    expect(status.lastError?.stage).toBe('upload');
    expect(s3.operations.at(-1)).toBe('AbortMultipartUpload');
    expect(s3.objects.size).toBe(0);
  });

  it('keeps the newest backups of its own naming and touches nothing else', async () => {
    const stub = { body: Buffer.from('x'), metadata: {} };
    for (const day of ['20261018', '20261019', '20261020']) {
      s3.objects.set(`${PREFIX}vaubaan-backup-${day}T030000Z.vbk`, stub);
    }
    s3.objects.set(`${PREFIX}notes.txt`, stub);
    s3.objects.set(`${PREFIX}vaubaan-backup-manual.vbk`, stub);
    s3.objects.set('other/vaubaan-backup-20261001T030000Z.vbk', stub);
    const status = await (await serviceFor(configFor({ VAUBAAN_BACKUP_KEEP: '2' }))).runOnce();
    expect(status.lastOutcome).toBe('ok');
    expect(status.pruneError).toBeNull();
    expect([...s3.objects.keys()].sort()).toEqual([
      `${PREFIX}notes.txt`,
      `${PREFIX}vaubaan-backup-20261020T030000Z.vbk`,
      `${PREFIX}vaubaan-backup-20261021T101500Z.vbk`,
      `${PREFIX}vaubaan-backup-manual.vbk`,
      'other/vaubaan-backup-20261001T030000Z.vbk',
    ]);
    expect(audit.admin[0]?.after).toMatchObject({ pruned: 2 });
  });

  it('a retention that fails does not fail the backup', async () => {
    s3.failNext('ListObjectsV2', 403, 'AccessDenied');
    const status = await (await serviceFor(configFor({ VAUBAAN_BACKUP_KEEP: '2' }))).runOnce();
    expect(status.lastOutcome).toBe('ok');
    expect(status.pruneError).toBe('ListObjectsV2: the storage answered 403 AccessDenied');
  });

  it('never runs two backups at once', async () => {
    const service = await serviceFor(configFor());
    const [a, b] = await Promise.all([service.runOnce(), service.runOnce()]);
    expect(a).toBe(b);
    expect(s3.operations).toEqual(['PutObject']);
  });

  describe('the schedule', () => {
    it('makes up a missed run once, a minute after the start, then follows the slots', async () => {
      const timers = manualTimers();
      let now = T0;
      const service = await serviceFor(configFor({ VAUBAAN_BACKUP_EVERY: '6h' }), {
        timers,
        now: () => now,
      });
      await service.start();
      expect(timers.pending.map((t) => t.ms)).toEqual([CATCH_UP_DELAY_MS]);
      expect(service.nextRunAt()?.toISOString()).toBe('2026-10-21T10:16:00.000Z');

      now = new Date('2026-10-21T10:16:00Z');
      const tick = timers.pending.shift();
      tick?.fn();
      await expect.poll(() => s3.operations.length).toBe(1);
      await expect.poll(() => service.nextRunAt()?.toISOString()).toBe('2026-10-21T15:00:00.000Z');
      await service.stop();
      expect(timers.pending).toEqual([]);
    });

    it('waits for the next slot when the latest attempt is recent', async () => {
      const timers = manualTimers();
      await backupStatusStore(store.config).write({
        lastAttemptAt: '2026-10-21T03:00:00.000Z',
        lastOutcome: 'ok',
        lastError: null,
        latest: null,
        pruneError: null,
      });
      const service = await serviceFor(configFor(), { timers });
      await service.start();
      expect(service.nextRunAt()?.toISOString()).toBe('2026-10-22T03:00:00.000Z');
      await service.stop();
    });

    it('is off without a bucket', async () => {
      const timers = manualTimers();
      const config = configFor({
        VAUBAAN_BACKUP_S3_ENDPOINT: undefined,
        VAUBAAN_BACKUP_S3_REGION: undefined,
        VAUBAAN_BACKUP_S3_BUCKET: undefined,
        VAUBAAN_BACKUP_S3_PREFIX: undefined,
        VAUBAAN_BACKUP_S3_PATH_STYLE: undefined,
        VAUBAAN_BACKUP_S3_ACCESS_KEY_ID: undefined,
        VAUBAAN_BACKUP_S3_SECRET_ACCESS_KEY: undefined,
      });
      expect(config.backup).toBeNull();
      const service = await serviceFor(config, { timers });
      await service.start();
      expect(timers.pending).toEqual([]);
      expect(await service.health()).toEqual({ configured: false });
    });
  });
});
