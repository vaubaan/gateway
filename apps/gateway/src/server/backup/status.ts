/**
 * The record of the scheduled backup (ADR scheduled-encrypted-backup-to-object-storage,
 * D8): the latest attempt and the latest success, kept in the store
 * (`instance_config`, key `backup.status`, JSON) so a restart keeps them and the
 * catch-up rule reads them. Never a secret: no endpoint, bucket, credential or URL.
 */
import type { ConfigRepo } from '../store/repositories/config';

export const BACKUP_STATUS_KEY = 'backup.status';

/** Where a run stopped. */
export const BACKUP_STAGES = ['copy', 'encrypt', 'self-check', 'upload'] as const;
export type BackupStage = (typeof BACKUP_STAGES)[number];

/** One backup that was uploaded. */
export interface BackupRecord {
  /** When the run started (ISO 8601, UTC). */
  readonly at: string;
  readonly objectKey: string;
  /** Size of the uploaded (compressed, encrypted) object. */
  readonly bytes: number;
  /**
   * Size of the store copy it holds, before compression. Absent from a record written
   * before the format v2 (2026-10-23).
   */
  readonly storeBytes?: number;
  /** SHA-256 of the uploaded (encrypted) object: what a restore is given. */
  readonly sha256: string;
  /** The master key version the object is encrypted under. */
  readonly keyVersion: number;
  /** The versions its sealed secrets are under. */
  readonly sealedKeyVersions: readonly number[];
  readonly schemaVersion: number;
  /** The self-check ran on these bytes before upload and passed. */
  readonly selfCheck: 'passed';
}

export interface BackupStatus {
  readonly lastAttemptAt: string | null;
  readonly lastOutcome: 'ok' | 'failed' | null;
  /** The stage and the reason of the latest failure; `null` after a success. */
  readonly lastError: { readonly stage: BackupStage; readonly message: string } | null;
  /** The latest backup uploaded, whatever happened since. */
  readonly latest: BackupRecord | null;
  /** The retention's latest failure, retried at the next run; `null` when it worked. */
  readonly pruneError: string | null;
}

export const EMPTY_BACKUP_STATUS: BackupStatus = {
  lastAttemptAt: null,
  lastOutcome: null,
  lastError: null,
  latest: null,
  pruneError: null,
};

export interface BackupStatusStore {
  read(): Promise<BackupStatus>;
  write(status: BackupStatus): Promise<void>;
}

export function backupStatusStore(config: Pick<ConfigRepo, 'get' | 'set'>): BackupStatusStore {
  return {
    async read() {
      const raw = await config.get(BACKUP_STATUS_KEY);
      if (raw === null) return EMPTY_BACKUP_STATUS;
      try {
        return { ...EMPTY_BACKUP_STATUS, ...(JSON.parse(raw) as Partial<BackupStatus>) };
      } catch {
        // expected: a record that does not parse is no record: the next run writes a good one.
        return EMPTY_BACKUP_STATUS;
      }
    },
    async write(status) {
      await config.set(BACKUP_STATUS_KEY, JSON.stringify(status));
    },
  };
}
