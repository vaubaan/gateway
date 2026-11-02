/**
 * The scheduled backup (ADR scheduled-encrypted-backup-to-object-storage): a timer in
 * the server that, at each slot of `backup.every` from `backup.at` (UTC),
 *
 *   copy       `VACUUM INTO` a temporary file of the store's directory, the sign-in
 *              configuration carried in, `integrity_check` ok (`writeStoreCopy`);
 *   encrypt    the copy, compressed then encrypted under a key derived from the master key
 *              (`crypto/backup-file.ts`, format v2), then the plain copy is removed;
 *   self-check the restore's own dry run on the encrypted bytes, with their SHA-256:
 *              opened, integrity checked, migrations compared, every sealed blob opened;
 *   upload     to the bucket (one PUT up to 64 MiB, multipart above);
 *
 * then prunes beyond `backup.keep`, records the outcome in the store, the log and the
 * activity. A run never overlaps another. At start, a run is made up once when the store
 * records no attempt within the last period (D2). Nothing it reports holds a secret.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { SCHEDULE_ACTOR_ID, type AdminAct, type AuditWriter } from '@vaubaan/gateway-core';

import type { BackupConfig, InstanceConfig } from '../config/types';
import type { Encryptor } from '../crypto';
import type { Logger } from '../logging';
import { RestoreError, restoreStore } from '../restore/restore';
import type { Store } from '../store';
import { MEMORY_PATH } from '../store/db';
import { BackupCipherError, encryptBackupFile } from '../crypto/backup-file';
import { CopyWriteError, writeStoreCopy } from './copy';
import { S3Client, S3Error } from './s3/client';
import { amzDate } from './s3/sigv4';
import type { BackupRecord, BackupStage, BackupStatus, BackupStatusStore } from './status';
import type { NotificationEvents } from '../notifications/events';

/** Up to this size the object goes in one PUT; above, a multipart upload. */
export const SINGLE_PUT_MAX_BYTES = 64 * 1024 * 1024;
/** The part size of a multipart upload (S3 wants at least 5 MiB but for the last). */
export const MULTIPART_PART_BYTES = 16 * 1024 * 1024;
/** A run made up at start waits this long after the boot. */
export const CATCH_UP_DELAY_MS = 60 * 1000;
/** The name of a backup object after the prefix. */
export const BACKUP_OBJECT_NAME = /^vaubaan-backup-\d{8}T\d{6}Z\.vbk$/;
const OBJECT_NAME_START = 'vaubaan-backup-';
const MAX_MESSAGE = 300;

/** The object key of a backup made at `at`. */
export function backupObjectKey(prefix: string, at: Date): string {
  return `${prefix}${OBJECT_NAME_START}${amzDate(at)}.vbk`;
}

/**
 * The first slot strictly after `now`: slots fall at `atMinutes` past midnight UTC plus
 * any multiple of the period, which divides a day (so the slots repeat every day).
 */
export function nextRunAfter(now: Date, everySeconds: number, atMinutes: number): Date {
  const every = everySeconds * 1000;
  const anchor = (atMinutes * 60_000) % every;
  const t = now.getTime();
  const since = (((t - anchor) % every) + every) % every;
  return new Date(t - since + every);
}

/** `HH:MM` of minutes after midnight. */
export function timeOfDay(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** The backup as `/healthz` shows it: no endpoint, bucket, credential or URL. */
export type BackupHealth =
  | { readonly configured: false }
  | {
      readonly configured: true;
      readonly schedule: {
        readonly every_seconds: number;
        readonly at: string;
        readonly keep: number;
      };
      readonly next_run_at: string | null;
      readonly running: boolean;
      readonly last_attempt_at: string | null;
      readonly last_outcome: 'ok' | 'failed' | null;
      readonly last_error: { readonly stage: BackupStage; readonly message: string } | null;
      readonly prune_error: string | null;
      readonly latest: {
        readonly at: string;
        readonly object_key: string;
        readonly bytes: number;
        /** The store the object holds, before compression; `null` in a record older than it. */
        readonly store_bytes: number | null;
        readonly sha256: string;
        readonly key_version: number;
        readonly sealed_key_versions: readonly number[];
        readonly schema_version: number;
        readonly self_check: 'passed';
      } | null;
    };

/** What the Settings page shows: the health view plus where the bucket is. */
export interface BackupView {
  readonly config: BackupConfig | null;
  readonly status: BackupStatus;
  readonly nextRunAt: Date | null;
  readonly running: boolean;
}

export interface BackupTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const NODE_TIMERS: BackupTimers = {
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface BackupServiceDeps {
  readonly config: InstanceConfig;
  readonly store: Pick<Store, 'backupTo' | 'kind'>;
  readonly encryptor: Encryptor;
  readonly status: BackupStatusStore;
  readonly audit: AuditWriter;
  readonly logger: Logger;
  /** Tests: the storage's network. */
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly timers?: BackupTimers;
  /** Tests: the sizes that decide a multipart upload. */
  readonly upload?: { readonly singlePutMaxBytes: number; readonly partBytes: number };
  /** Told of a failed run, after it is recorded (spec §4.2 bis); default: nobody. */
  readonly notifications?: Pick<NotificationEvents, 'backupFailed'>;
}

class BackupFailure extends Error {
  constructor(
    readonly stage: BackupStage,
    message: string,
  ) {
    super(message.slice(0, MAX_MESSAGE));
    this.name = 'BackupFailure';
  }
}

export class BackupService {
  private readonly now: () => Date;
  private readonly timers: BackupTimers;
  private timer: unknown = null;
  private scheduledAt: Date | null = null;
  private running: Promise<BackupStatus> | null = null;
  private stopped = false;

  constructor(private readonly deps: BackupServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.timers = deps.timers ?? NODE_TIMERS;
  }

  /** Whether `backup.s3.*` is configured. */
  get configured(): boolean {
    return this.deps.config.backup !== null;
  }

  /** The next run the timer holds, or `null` (off, stopped, or a run in progress). */
  nextRunAt(): Date | null {
    return this.scheduledAt;
  }

  async view(): Promise<BackupView> {
    return {
      config: this.deps.config.backup,
      status: await this.deps.status.read(),
      nextRunAt: this.scheduledAt,
      running: this.running !== null,
    };
  }

  async health(): Promise<BackupHealth> {
    const backup = this.deps.config.backup;
    if (!backup) return { configured: false };
    const status = await this.deps.status.read();
    const latest = status.latest;
    return {
      configured: true,
      schedule: {
        every_seconds: backup.everySeconds,
        at: timeOfDay(backup.atMinutes),
        keep: backup.keep,
      },
      next_run_at: this.scheduledAt?.toISOString() ?? null,
      running: this.running !== null,
      last_attempt_at: status.lastAttemptAt,
      last_outcome: status.lastOutcome,
      last_error: status.lastError,
      prune_error: status.pruneError,
      latest: latest && {
        at: latest.at,
        object_key: latest.objectKey,
        bytes: latest.bytes,
        store_bytes: latest.storeBytes ?? null,
        sha256: latest.sha256,
        key_version: latest.keyVersion,
        sealed_key_versions: latest.sealedKeyVersions,
        schema_version: latest.schemaVersion,
        self_check: latest.selfCheck,
      },
    };
  }

  /**
   * Arms the timer: a run one minute from now when the store records no attempt within
   * the last period (a missed run, made up once), else the next slot. Nothing when off.
   */
  async start(): Promise<void> {
    const backup = this.deps.config.backup;
    if (!backup || this.stopped) return;
    const status = await this.deps.status.read();
    const now = this.now();
    const last = status.lastAttemptAt === null ? null : Date.parse(status.lastAttemptAt);
    const missed =
      last === null || Number.isNaN(last) || now.getTime() - last > backup.everySeconds * 1000;
    const at = missed
      ? new Date(now.getTime() + CATCH_UP_DELAY_MS)
      : nextRunAfter(now, backup.everySeconds, backup.atMinutes);
    this.deps.logger.info('scheduled backup armed', {
      next_run_at: at.toISOString(),
      every_seconds: backup.everySeconds,
      at: timeOfDay(backup.atMinutes),
      keep: backup.keep,
      made_up: missed,
    });
    this.arm(at);
  }

  /** Stops the timer and waits for a run in progress (the store closes after it). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.scheduledAt = null;
    if (this.running) await this.running.catch(() => undefined);
  }

  private arm(at: Date): void {
    if (this.stopped) return;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.scheduledAt = at;
    this.timer = this.timers.setTimeout(
      () => void this.tick(),
      Math.max(0, at.getTime() - this.now().getTime()),
    );
  }

  private async tick(): Promise<void> {
    this.timer = null;
    this.scheduledAt = null;
    const backup = this.deps.config.backup;
    if (!backup || this.stopped) return;
    if (this.running) {
      this.deps.logger.warn('scheduled backup skipped: the previous run is still going');
    } else {
      await this.runOnce();
    }
    this.arm(nextRunAfter(this.now(), backup.everySeconds, backup.atMinutes));
  }

  /**
   * One backup, now. A call while one runs gets that run's outcome: runs never overlap.
   * Never throws: the outcome is in the status it returns.
   */
  runOnce(): Promise<BackupStatus> {
    if (this.running) return this.running;
    const run = this.run().finally(() => {
      this.running = null;
    });
    this.running = run;
    return run;
  }

  private async run(): Promise<BackupStatus> {
    const backup = this.deps.config.backup;
    const previous = await this.deps.status.read();
    const startedAt = this.now();
    if (!backup) return previous;
    const storePath = this.deps.config.store.path;
    const dir = dirname(resolve(/* turbopackIgnore: true */ storePath));
    const stem = `.backup-${randomBytes(6).toString('hex')}`;
    const plain = join(/* turbopackIgnore: true */ dir, `${stem}.sqlite`);
    const encrypted = join(/* turbopackIgnore: true */ dir, `${stem}.vbk`);
    let stage: BackupStage = 'copy';
    try {
      if (this.deps.store.kind !== 'sqlite' || storePath === MEMORY_PATH) {
        throw new BackupFailure('copy', 'the store is in memory: there is no file to back up');
      }
      const copy = await writeStoreCopy({
        vacuumInto: (target) => this.deps.store.backupTo(target),
        target: plain,
        config: this.deps.config,
        encryptor: this.deps.encryptor,
        now: this.now,
      });
      if (copy.integrity !== 'ok') {
        throw new BackupFailure('copy', `integrity_check of the copy: ${copy.integrity}`);
      }

      stage = 'encrypt';
      const sealed = await encryptBackupFile(
        plain,
        encrypted,
        this.deps.config.encryption,
        copy.sealedKeyVersions,
      );
      rmSync(/* turbopackIgnore: true */ plain, { force: true });
      const sha256 = await sha256OfFile(encrypted);

      stage = 'self-check';
      const encryption = this.deps.config.encryption;
      await restoreStore({
        source: { kind: 'file', path: encrypted },
        sha256,
        maxBytes: Number.MAX_SAFE_INTEGER,
        storePath,
        encryptor: this.deps.encryptor,
        keyVersions: [encryption.keyVersion, ...encryption.previousKeys.keys()],
        masterKeys: encryption,
        dryRun: true,
      });

      stage = 'upload';
      const client = new S3Client(backup.s3, { fetch: this.deps.fetch, now: this.now });
      const objectKey = backupObjectKey(backup.s3.prefix, startedAt);
      await upload(client, encrypted, objectKey, sealed.bytes, sha256, this.deps.upload);

      const latest: BackupRecord = {
        at: startedAt.toISOString(),
        objectKey,
        bytes: sealed.bytes,
        storeBytes: sealed.storeBytes,
        sha256,
        keyVersion: sealed.header.keyVersion,
        sealedKeyVersions: copy.sealedKeyVersions,
        schemaVersion: copy.schemaVersion,
        selfCheck: 'passed',
      };
      const pruned = await this.prune(client, backup);
      const status: BackupStatus = {
        lastAttemptAt: startedAt.toISOString(),
        lastOutcome: 'ok',
        lastError: null,
        latest,
        pruneError: pruned.error,
      };
      await this.deps.status.write(status);
      const after = {
        object_key: objectKey,
        bytes: latest.bytes,
        store_bytes: latest.storeBytes,
        sha256,
        key_version: latest.keyVersion,
        sealed_key_versions: latest.sealedKeyVersions,
        schema_version: latest.schemaVersion,
        self_check: 'passed',
        pruned: pruned.deleted,
        prune_error: pruned.error,
        duration_ms: this.now().getTime() - startedAt.getTime(),
      };
      this.deps.logger.info('scheduled backup uploaded', after);
      await this.audit('backup-made', after);
      return status;
    } catch (err) {
      const failure = asFailure(err, stage);
      const status: BackupStatus = {
        ...previous,
        lastAttemptAt: startedAt.toISOString(),
        lastOutcome: 'failed',
        lastError: { stage: failure.stage, message: failure.message },
      };
      await this.deps.status.write(status).catch((writeErr: unknown) => {
        this.deps.logger.error('scheduled backup: the status could not be recorded', {
          err: writeErr,
        });
      });
      const after = { stage: failure.stage, message: failure.message, uploaded: false };
      this.deps.logger.error('scheduled backup failed: nothing was uploaded', after);
      await this.audit('backup-failed', after);
      this.deps.notifications?.backupFailed();
      return status;
    } finally {
      for (const file of [plain, encrypted]) {
        for (const leftover of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
          rmSync(/* turbopackIgnore: true */ leftover, { force: true });
        }
      }
    }
  }

  /** Deletes the backups beyond `keep`, newest kept; nothing else under the prefix. */
  private async prune(
    client: S3Client,
    backup: BackupConfig,
  ): Promise<{ deleted: number; error: string | null }> {
    if (backup.keep === 0) return { deleted: 0, error: null };
    const prefix = backup.s3.prefix;
    let deleted = 0;
    try {
      const objects = await client.listObjects(`${prefix}${OBJECT_NAME_START}`);
      const ours = objects
        .map((o) => o.key)
        .filter(
          (key) => key.startsWith(prefix) && BACKUP_OBJECT_NAME.test(key.slice(prefix.length)),
        )
        .sort()
        .reverse();
      for (const key of ours.slice(backup.keep)) {
        await client.deleteObject(key);
        deleted++;
      }
      return { deleted, error: null };
    } catch (err) {
      const message =
        err instanceof S3Error ? err.message : 'unexpected failure (details withheld)';
      this.deps.logger.warn('scheduled backup: old backups could not all be deleted', {
        deleted,
        message,
      });
      return { deleted, error: message };
    }
  }

  private async audit(act: Extract<AdminAct, 'backup-made' | 'backup-failed'>, after: unknown) {
    try {
      await this.deps.audit.write({
        kind: 'admin',
        ts: this.now().toISOString(),
        user_id: SCHEDULE_ACTOR_ID,
        act,
        object: { type: 'instance-config', id: 'backup' },
        before: null,
        after,
        delegated_client_id: null,
      });
    } catch (err) {
      this.deps.logger.error('scheduled backup: the activity entry could not be written', { err });
    }
  }
}

/** What a failure says: our own messages, an error code otherwise — never a URL or a secret. */
function asFailure(err: unknown, stage: BackupStage): BackupFailure {
  if (err instanceof BackupFailure) return err;
  if (err instanceof RestoreError) return new BackupFailure('self-check', err.message);
  if (err instanceof S3Error) return new BackupFailure('upload', err.message);
  if (err instanceof BackupCipherError) return new BackupFailure(stage, err.message);
  if (err instanceof CopyWriteError) return new BackupFailure('copy', err.message);
  const code = (err as { code?: unknown } | undefined)?.code;
  const named = typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code) ? ` (${code})` : '';
  return new BackupFailure(stage, `unexpected failure${named} (details withheld)`);
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(/* turbopackIgnore: true */ path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/** One PUT up to `SINGLE_PUT_MAX_BYTES`, a multipart upload above (aborted on failure). */
async function upload(
  client: S3Client,
  path: string,
  key: string,
  size: number,
  sha256: string,
  sizes = { singlePutMaxBytes: SINGLE_PUT_MAX_BYTES, partBytes: MULTIPART_PART_BYTES },
): Promise<void> {
  const metadata = { sha256 };
  const file = await open(/* turbopackIgnore: true */ path, 'r');
  try {
    if (size <= sizes.singlePutMaxBytes) {
      await client.putObject(key, await file.readFile(), metadata);
      return;
    }
    const uploadId = await client.createMultipartUpload(key, metadata);
    try {
      const parts = [];
      const buffer = Buffer.alloc(sizes.partBytes);
      for (let offset = 0, number = 1; offset < size; number++) {
        const { bytesRead } = await file.read(buffer, 0, sizes.partBytes, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
        parts.push(await client.uploadPart(key, uploadId, number, buffer.subarray(0, bytesRead)));
      }
      await client.completeMultipartUpload(key, uploadId, parts);
    } catch (err) {
      await client.abortMultipartUpload(key, uploadId).catch(() => undefined);
      throw err;
    }
  } finally {
    await file.close();
  }
}
