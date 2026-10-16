/**
 * Restore at first boot (ADR restore-verifies-before-it-replaces-and-runs-at-first-boot,
 * D5): called by `openEmbeddedStore` before the store is opened.
 *
 * - `restore.from` unset: nothing.
 * - the store file exists and is not empty: one `warn` line, nothing else — a
 *   restart after a successful restore is a normal boot.
 * - otherwise: the restore runs; a failure stops the boot (no store is left behind,
 *   so the next start tries again), a success is logged and the boot continues
 *   (migrations, the key probe).
 *
 * Neither the log lines nor the error name the source: a presigned URL is a secret.
 */
import { describeRestoreSource } from '../config/restore-source';
import type { InstanceConfig } from '../config';
import type { Encryptor } from '../crypto';
import type { Logger } from '../logging';
import { RestoreError, restoreStore, storeHasContent } from './restore';

export const RESTORE_SKIPPED_STORE_EXISTS =
  'restore.from is set but the store exists: no restore at this boot (remove VAUBAAN_RESTORE_FROM and VAUBAAN_RESTORE_SHA256 once the move is done)';

export interface FirstBootRestoreContext {
  readonly config: InstanceConfig;
  readonly logger: Logger;
  readonly encryptor: Encryptor;
  /** Tests: the network. */
  readonly fetch?: typeof fetch;
}

export async function restoreAtFirstBoot(ctx: FirstBootRestoreContext): Promise<void> {
  const { config, logger } = ctx;
  const { from, sha256, maxBytes } = config.restore;
  if (from === null) return;
  const storePath = config.store.path;
  if (storeHasContent(storePath)) {
    logger.warn(RESTORE_SKIPPED_STORE_EXISTS, { store_path: storePath });
    return;
  }
  logger.info('restoring the store before the first boot', {
    source: describeRestoreSource(from),
    store_path: storePath,
    max_bytes: maxBytes,
  });
  try {
    const report = await restoreStore({
      source: from,
      sha256,
      maxBytes,
      storePath,
      encryptor: ctx.encryptor,
      keyVersions: [config.encryption.keyVersion, ...config.encryption.previousKeys.keys()],
      fetch: ctx.fetch,
    });
    logger.info('store restored', {
      store_path: storePath,
      bytes: report.bytes,
      sha256: report.sha256,
      schema_version: report.schemaVersion,
      key_versions: report.keyVersions.map((k) => `${k.keyVersion}: ${k.blobs} blobs`),
      moved_aside: report.movedAside,
    });
  } catch (err) {
    if (err instanceof RestoreError) {
      throw new Error(
        `restore at first boot refused (${err.kind}): ${err.message}. No store was written; ` +
          'fix VAUBAAN_RESTORE_FROM / VAUBAAN_RESTORE_SHA256 or the master keys, and start again.',
      );
    }
    // Never the original message: it could quote the URL.
    throw new Error('restore at first boot failed: unexpected failure (details withheld)');
  }
}
