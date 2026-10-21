/**
 * Backups: the store copy shared with the `backup` command, the encrypted file format,
 * the S3 client and the scheduled backup (ADR scheduled-encrypted-backup-to-object-storage).
 * `cli.ts` / `main.ts` (the command) are bundled apart and not re-exported.
 */
import type { AuditWriter } from '@vaubaan/gateway-core';

import type { InstanceConfig } from '../config/types';
import type { Encryptor } from '../crypto';
import type { Logger } from '../logging';
import type { Store } from '../store';
import { BackupService, type BackupTimers } from './scheduled';
import { backupStatusStore } from './status';

export {
  BACKUP_OBJECT_NAME,
  BackupService,
  backupObjectKey,
  nextRunAfter,
  timeOfDay,
  type BackupHealth,
  type BackupTimers,
  type BackupView,
} from './scheduled';
export {
  BACKUP_STATUS_KEY,
  type BackupRecord,
  type BackupStage,
  type BackupStatus,
} from './status';

export interface BackupModuleDeps {
  readonly config: InstanceConfig;
  readonly store: Store;
  readonly encryptor: Encryptor;
  readonly logger: Logger;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly timers?: BackupTimers;
}

/** The scheduled backup over the instance's store; `start()` arms it when configured. */
export function createBackupModule(deps: BackupModuleDeps): BackupService {
  const audit: AuditWriter = deps.store.auditWriter;
  return new BackupService({
    config: deps.config,
    store: deps.store,
    encryptor: deps.encryptor,
    status: backupStatusStore(deps.store.config),
    audit,
    logger: deps.logger.child({ component: 'backup' }),
    fetch: deps.fetch,
    now: deps.now,
    timers: deps.timers,
  });
}
