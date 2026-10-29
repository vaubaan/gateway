/**
 * The store copy every backup starts from, shared by the `backup` command and the
 * scheduled backup (ADR scheduled-encrypted-backup-to-object-storage, D3):
 *
 *   1. `VACUUM INTO` the target (the caller says through which handle: the command
 *      opens the store read-only, the running instance uses its own);
 *   2. into the copy, never into the live store: the sign-in providers the
 *      configuration sets, carried as store-held ones (see
 *      docs/handbook/authentication.md), and the removal of the instance's
 *      own backup record, so a restored instance does not report the source's backups;
 *   3. read back: `integrity_check`, schema version, the master-key versions its sealed
 *      secrets are under.
 *
 * A failure while writing into the copy removes the copy (`CopyWriteError`).
 */
import { rmSync, statSync } from 'node:fs';

import { IdpSettingsService } from '../auth/idp-settings';
import { SignInProvidersService, type CarriedSignIn } from '../auth/sign-in-providers';
import type { InstanceConfig } from '../config';
import type { Encryptor } from '../crypto';
import { openCopyConfig } from '../store';
import { integrityOf, openReadonlyDb, schemaVersionOf, type StoreDb } from '../store/db';
import { sealedVersionsOf } from '../store/repositories/sealed-blobs';
import { BACKUP_STATUS_KEY } from './status';

export class CopyWriteError extends Error {
  constructor() {
    super('the sign-in configuration could not be written into the copy');
    this.name = 'CopyWriteError';
  }
}

export interface StoreCopy {
  readonly path: string;
  readonly bytes: number;
  readonly integrity: string;
  readonly schemaVersion: number;
  /** The master-key versions the copy's sealed secrets are under, ascending. */
  readonly sealedKeyVersions: readonly number[];
  /** The sign-in provider ids carried into the copy. */
  readonly carried: readonly string[];
}

export interface StoreCopyOptions {
  /** Writes the `VACUUM INTO` copy at the given path (which must not exist). */
  readonly vacuumInto: (target: string) => void;
  readonly target: string;
  readonly config: InstanceConfig;
  readonly encryptor: Encryptor;
  readonly now?: () => Date;
}

export async function writeStoreCopy(options: StoreCopyOptions): Promise<StoreCopy> {
  const { target } = options;
  options.vacuumInto(target);
  let carried: CarriedSignIn;
  try {
    carried = await writeIntoCopy(options);
  } catch {
    rmSync(/* turbopackIgnore: true */ target, { force: true });
    throw new CopyWriteError();
  }
  let copy: StoreDb | null = null;
  try {
    copy = openReadonlyDb(target);
    return {
      path: target,
      bytes: statSync(/* turbopackIgnore: true */ target).size,
      integrity: integrityOf(copy),
      schemaVersion: schemaVersionOf(copy),
      sealedKeyVersions: [...new Set(sealedVersionsOf(copy).map((v) => v.keyVersion))].sort(
        (a, b) => a - b,
      ),
      carried: carried.providers,
    };
  } finally {
    copy?.close();
  }
}

async function writeIntoCopy(options: StoreCopyOptions): Promise<CarriedSignIn> {
  const { config } = options;
  const clock = { now: options.now ?? (() => new Date()) };
  const copy = openCopyConfig(options.target, options.encryptor, clock);
  try {
    const providers = new SignInProvidersService(
      config,
      async () => [],
      new IdpSettingsService(config.idp, copy.config),
      copy.config,
      clock,
    );
    const carried = await providers.carryIntoStore();
    await copy.config.delete(BACKUP_STATUS_KEY);
    return carried;
  } finally {
    copy.close();
  }
}
