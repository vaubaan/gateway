/**
 * Every sealed column of the store, in one place, and the re-seal that moves them to the
 * current master key (ADR master-key-rotation-reseals-every-blob).
 *
 * Three columns hold AEAD blobs, each bound to its row by associated data:
 *
 *   connections.credential_blob   the connection id
 *   instance_config.secret_blob   `instance_config:<key>`
 *   requests.args_blob            `request:<id>`
 *
 * A blob opens only with the key of its `key_version`. After a rotation the instance
 * keeps the previous key until every blob is sealed again under the current one;
 * `reseal` does that, and `versions` tells the operator when the previous key may go.
 *
 * Concurrency: the running gateway writes the same tables while the command runs. Each
 * blob is opened and sealed outside the transaction (the encryptor is asynchronous, the
 * driver is not), then every blob of a table is written in one `BEGIN IMMEDIATE`
 * transaction with a compare-and-swap on the exact blob and version read: a row the
 * gateway changed in the meantime is left as the gateway wrote it and counted as
 * `changed`. Run again to pick it up. The SQL is portable.
 */

import { withImmediateTransaction, type StoreDb } from '../db.ts';
import type { Encryptor } from '../encryptor.ts';
import { secretAd } from './config.ts';
import type { RepoContext } from './context.ts';
import { requestAd } from './requests.ts';

export const SEALED_COLUMNS = [
  {
    table: 'connections',
    idColumn: 'id',
    blobColumn: 'credential_blob',
    associatedData: (id: string): string => id,
  },
  {
    table: 'instance_config',
    idColumn: 'key',
    blobColumn: 'secret_blob',
    associatedData: secretAd,
  },
  {
    table: 'requests',
    idColumn: 'id',
    blobColumn: 'args_blob',
    associatedData: requestAd,
  },
] as const;

export type SealedTable = (typeof SEALED_COLUMNS)[number]['table'];

/** How many blobs one table holds under one master-key version. */
export interface SealedVersionCount {
  readonly table: SealedTable;
  readonly keyVersion: number;
  readonly count: number;
}

/** What `reseal` did (or, in a dry run, would do) to one table. */
export interface ResealTableReport {
  readonly table: SealedTable;
  /** Blobs already under the current key version when the run started: left alone. */
  readonly current: number;
  /**
   * Of those, the ones the current key does not open: the current key is not the one
   * that sealed them (a key pasted without raising its version, say). Never written.
   */
  readonly currentUnreadable: number;
  /** Blobs under another version that opened and were (or would be) sealed again. */
  readonly resealed: number;
  /** Blobs that did not open: no key for their version, or a key that does not fit. */
  readonly unreadable: number;
  /** Rows the running gateway rewrote or erased between the read and the write. */
  readonly changed: number;
}

export interface ResealReport {
  readonly apply: boolean;
  readonly currentKeyVersion: number;
  readonly tables: readonly ResealTableReport[];
}

export interface SealedBlobsRepo {
  /** Blob counts per table and key version (no blob is opened). */
  versions(): Promise<SealedVersionCount[]>;
  /**
   * Opens every blob sealed under another key version and seals it under the current
   * one. With `apply: false` nothing is written: every blob is still opened, so the
   * report says whether the configured keys open them all.
   */
  reseal(options: { readonly apply: boolean }): Promise<ResealReport>;
  /**
   * One blob per table and key version, opened and dropped: whether the configured keys
   * open what the store holds. Cheap enough for every boot (re-check M-1).
   */
  probe(): Promise<SealedProbe[]>;
}

/** What `probe` found for one table and key version. */
export interface SealedProbe {
  readonly table: SealedTable;
  readonly keyVersion: number;
  readonly count: number;
  /** Whether the sampled blob opened with the key configured for its version. */
  readonly opens: boolean;
}

interface SealedRow {
  readonly id: string;
  readonly blob: Buffer;
  readonly key_version: number;
}

interface Resealed {
  readonly id: string;
  readonly oldBlob: Buffer;
  readonly oldVersion: number;
  readonly blob: Buffer;
  readonly keyVersion: number;
}

/**
 * Blob counts per table and key version of any database handle (the `backup` command
 * reads its copy with it, read-only). No blob is opened.
 */
export function sealedVersionsOf(db: StoreDb): SealedVersionCount[] {
  return SEALED_COLUMNS.flatMap((column) =>
    db
      .prepare<[], { key_version: number; count: number }>(
        `SELECT key_version, COUNT(*) AS count FROM ${column.table}
         WHERE ${column.blobColumn} IS NOT NULL GROUP BY key_version ORDER BY key_version`,
      )
      .all()
      .map((row) => ({ table: column.table, keyVersion: row.key_version, count: row.count })),
  );
}

/** What opening every blob of one table and key version found. */
export interface SealedOpenCount {
  readonly table: SealedTable;
  readonly keyVersion: number;
  readonly count: number;
  /** Blobs that did not open with the key configured for their version (or had none). */
  readonly unreadable: number;
}

/**
 * Opens every blob of any database handle with the given encryptor and drops each
 * plaintext at once: whether these keys open everything a store copy holds (the
 * `restore` command, on its read-only candidate). Nothing is written.
 */
export async function openEverySealedBlobOf(
  db: StoreDb,
  encryptor: Encryptor,
): Promise<SealedOpenCount[]> {
  const out: SealedOpenCount[] = [];
  for (const column of SEALED_COLUMNS) {
    const rows = db
      .prepare<[], SealedRow>(
        `SELECT ${column.idColumn} AS id, ${column.blobColumn} AS blob, key_version
         FROM ${column.table} WHERE ${column.blobColumn} IS NOT NULL
         ORDER BY key_version, ${column.idColumn}`,
      )
      .all();
    const byVersion = new Map<number, { count: number; unreadable: number }>();
    for (const row of rows) {
      const entry = byVersion.get(row.key_version) ?? { count: 0, unreadable: 0 };
      entry.count += 1;
      if (!(await opens(encryptor, column.associatedData(row.id), row))) entry.unreadable += 1;
      byVersion.set(row.key_version, entry);
    }
    for (const [keyVersion, entry] of byVersion) {
      out.push({ table: column.table, keyVersion, ...entry });
    }
  }
  return out;
}

export function createSealedBlobsRepo(ctx: RepoContext): SealedBlobsRepo {
  const { db, encryptor } = ctx;

  // Table and column names come from the constant above, never from input.
  const statements = SEALED_COLUMNS.map((column) => ({
    column,
    versions: db.prepare<[], { key_version: number; count: number }>(
      `SELECT key_version, COUNT(*) AS count FROM ${column.table}
       WHERE ${column.blobColumn} IS NOT NULL GROUP BY key_version ORDER BY key_version`,
    ),
    current: db.prepare<[number], SealedRow>(
      `SELECT ${column.idColumn} AS id, ${column.blobColumn} AS blob, key_version
       FROM ${column.table}
       WHERE ${column.blobColumn} IS NOT NULL AND key_version = ?`,
    ),
    stale: db.prepare<[number], SealedRow>(
      `SELECT ${column.idColumn} AS id, ${column.blobColumn} AS blob, key_version
       FROM ${column.table}
       WHERE ${column.blobColumn} IS NOT NULL AND key_version <> ?
       ORDER BY ${column.idColumn}`,
    ),
    sample: db.prepare<[number], SealedRow>(
      `SELECT ${column.idColumn} AS id, ${column.blobColumn} AS blob, key_version
       FROM ${column.table}
       WHERE ${column.blobColumn} IS NOT NULL AND key_version = ?
       ORDER BY ${column.idColumn} LIMIT 1`,
    ),
    swap: db.prepare<[Buffer, number, string, number, Buffer]>(
      `UPDATE ${column.table} SET ${column.blobColumn} = ?, key_version = ?
       WHERE ${column.idColumn} = ? AND key_version = ? AND ${column.blobColumn} = ?`,
    ),
  }));

  return {
    async versions() {
      return statements.flatMap(({ column, versions }) =>
        versions.all().map((row) => ({
          table: column.table,
          keyVersion: row.key_version,
          count: row.count,
        })),
      );
    },

    async probe() {
      const out: SealedProbe[] = [];
      for (const { column, versions, sample } of statements) {
        for (const { key_version: keyVersion, count } of versions.all()) {
          const row = sample.get(keyVersion);
          const ok =
            row !== undefined && (await opens(encryptor, column.associatedData(row.id), row));
          out.push({ table: column.table, keyVersion, count, opens: ok });
        }
      }
      return out;
    },

    async reseal({ apply }) {
      const target = encryptor.currentKeyVersion;
      const tables: ResealTableReport[] = [];
      for (const { column, current, stale, swap } of statements) {
        // Every blob is opened, the current ones too: a wrong current key must not
        // read as "nothing to do" (re-check M-1). They are only read, never written.
        const currentRows = current.all(target);
        let currentUnreadable = 0;
        for (const row of currentRows) {
          if (!(await opens(encryptor, column.associatedData(row.id), row))) currentUnreadable += 1;
        }
        const ready: Resealed[] = [];
        let unreadable = 0;
        for (const row of stale.all(target)) {
          const sealed = await resealOne(encryptor, column.associatedData(row.id), row);
          if (sealed === null) unreadable += 1;
          else
            ready.push({ id: row.id, oldBlob: row.blob, oldVersion: row.key_version, ...sealed });
        }
        let resealed = ready.length;
        let changed = 0;
        if (apply && ready.length > 0) {
          resealed = withImmediateTransaction(db, () => {
            let written = 0;
            for (const r of ready) {
              written += swap.run(r.blob, r.keyVersion, r.id, r.oldVersion, r.oldBlob).changes;
            }
            return written;
          });
          changed = ready.length - resealed;
        }
        tables.push({
          table: column.table,
          current: currentRows.length,
          currentUnreadable,
          resealed,
          unreadable,
          changed,
        });
      }
      return { apply, currentKeyVersion: target, tables };
    },
  };
}

/** Whether the blob opens with the key of its version (the plaintext is dropped at once). */
async function opens(
  encryptor: Encryptor,
  associatedData: string,
  row: SealedRow,
): Promise<boolean> {
  try {
    await encryptor.decrypt(associatedData, { keyVersion: row.key_version, blob: row.blob });
    return true;
  } catch {
    return false;
  }
}

/** The blob opened with its own version's key and sealed with the current one; `null` if it does not open. */
async function resealOne(
  encryptor: Encryptor,
  associatedData: string,
  row: SealedRow,
): Promise<{ blob: Buffer; keyVersion: number } | null> {
  let plain: string;
  try {
    plain = await encryptor.decrypt(associatedData, {
      keyVersion: row.key_version,
      blob: row.blob,
    });
  } catch {
    // Never the message: it says nothing useful about a blob and must quote nothing.
    return null;
  }
  const sealed = await encryptor.encrypt(associatedData, plain);
  return { blob: Buffer.from(sealed.blob), keyVersion: sealed.keyVersion };
}
