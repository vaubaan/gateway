/**
 * Database handle — opening, pragmas, transactions, backup.
 *
 * ADR: docs/decisions/embedded-store-sqlite-and-migrations.md. Driver: better-sqlite3
 * (synchronous). This module is the only place that knows the driver; repositories
 * receive a `StoreDb` and speak SQL through it.
 *
 * SQLite-specific spots live here on purpose (pragmas, `BEGIN IMMEDIATE`, `VACUUM INTO`)
 * so a future Postgres adapter replaces this file and keeps the repositories' SQL.
 */

import { existsSync, statSync } from 'node:fs';

import BetterSqlite3 from 'better-sqlite3';
import { StoreError } from './errors.ts';

export const MEMORY_PATH = ':memory:';

/** Oldest SQLite that understands `STRICT` tables. */
export const MIN_SQLITE_VERSION = [3, 37, 0] as const;
/** Milliseconds a writer waits on a locked database before `SQLITE_BUSY`. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export interface OpenDbOptions {
  /** File path, or `MEMORY_PATH` for an ephemeral in-memory database. */
  readonly path: string;
  /** Milliseconds a writer waits on a locked database before `SQLITE_BUSY`. */
  readonly busyTimeoutMs?: number;
}

export type StoreDb = BetterSqlite3.Database;

export function openDb(options: OpenDbOptions): StoreDb {
  const db = new BetterSqlite3(options.path, {
    timeout: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
  });
  assertSqliteVersion(db);
  // sqlite: pragmas. WAL lets readers proceed while the single writer commits;
  // synchronous=NORMAL in WAL mode survives a process crash and loses at most the last
  // transactions on a power loss, never consistency.
  if (options.path !== MEMORY_PATH) db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');
  return db;
}

/**
 * The store's size on disk, in bytes: its pages (`page_count × page_size`), plus the
 * write-ahead log beside the file when there is one. In memory: the pages alone.
 */
export function sizeOnDisk(db: StoreDb, path: string): number {
  const pages = Number(db.pragma('page_count', { simple: true }));
  const pageSize = Number(db.pragma('page_size', { simple: true }));
  let bytes = pages * pageSize;
  if (path !== MEMORY_PATH) {
    try {
      bytes += statSync(/* turbopackIgnore: true */ `${path}-wal`).size;
    } catch {
      // expected: no write-ahead log at this instant (checkpointed, or never written).
    }
  }
  return bytes;
}

function assertSqliteVersion(db: StoreDb): void {
  const row = db.prepare<[], { v: string }>('SELECT sqlite_version() AS v').get();
  const version = row?.v ?? '0.0.0';
  if (!isSqliteVersionAtLeast(version, MIN_SQLITE_VERSION)) {
    throw new StoreError(
      `SQLite ${version} is too old; ${MIN_SQLITE_VERSION.join('.')} or newer is required (STRICT tables)`,
    );
  }
}

/** `3.45.1` >= `[3, 37, 0]`; missing components count as 0, garbage as 0. */
export function isSqliteVersionAtLeast(
  version: string,
  minimum: readonly [number, number, number],
): boolean {
  const [maj = 0, min = 0, pat = 0] = version
    .split('.')
    .map((p) => Number.parseInt(p, 10))
    .map((n) => (Number.isNaN(n) ? 0 : n));
  const [rMaj, rMin, rPat] = minimum;
  return (
    maj > rMaj || (maj === rMaj && min > rMin) || (maj === rMaj && min === rMin && pat >= rPat)
  );
}

/**
 * Runs `fn` inside `BEGIN IMMEDIATE … COMMIT`: the write lock is taken up front, so two
 * writers serialize instead of one failing with `SQLITE_BUSY` at commit time. `fn` must
 * be synchronous; the transaction rolls back if it throws.
 *
 * sqlite: `BEGIN IMMEDIATE`. A Postgres adapter would use a plain transaction with
 * `SELECT … FOR UPDATE` on the rows it decides on.
 */
export function withImmediateTransaction<T>(db: StoreDb, fn: () => T): T {
  return db.transaction(fn).immediate();
}

/**
 * Writes a consistent single-file copy of the database to `destinationPath` with
 * `VACUUM INTO` (sqlite:). Works while the gateway is running; the copy has no WAL file
 * to pair with, which is what a volume snapshot of a WAL database would otherwise miss.
 */
export function backupTo(db: StoreDb, destinationPath: string): void {
  db.prepare('VACUUM INTO ?').run(destinationPath);
}

/**
 * Opens an existing database file read-only: no pragma written, no migration run. For
 * the operator's `backup` command and for checking the copy it made.
 */
export function openReadonlyDb(path: string): StoreDb {
  const db = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
  assertSqliteVersion(db);
  return db;
}

/**
 * Opens a store copy the `backup` command just made, to write into it: no
 * migration, no journal-mode change (the copy stays a single file, never WAL),
 * foreign keys on as everywhere.
 */
export function openCopyForWriting(path: string): StoreDb {
  const db = new BetterSqlite3(path, { fileMustExist: true });
  assertSqliteVersion(db);
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * Whether another connection holds the database file (the running gateway): opens it,
 * checkpoints its WAL, closes it. SQLite deletes the `-wal` file when the last
 * connection of a WAL database closes; when it survives our close, someone else has
 * the file open. Best-effort (sqlite:): the `restore --force` guard, never a lock.
 */
export function heldByAnotherConnection(path: string): boolean {
  const db = new BetterSqlite3(path, { fileMustExist: true, timeout: 0 });
  let busy: boolean;
  try {
    const row = db.pragma('wal_checkpoint(TRUNCATE)') as { busy?: number }[];
    busy = (row[0]?.busy ?? 0) !== 0;
  } catch (err) {
    // Locked is held; a file that is not a database (`SQLITE_NOTADB`) holds no connection.
    const code = (err as { code?: unknown }).code;
    busy = typeof code === 'string' && /^SQLITE_(BUSY|LOCKED)/.test(code);
  } finally {
    db.close();
  }
  return busy || existsSync(/* turbopackIgnore: true */ `${path}-wal`);
}

/** `PRAGMA integrity_check`: `'ok'`, or the first problem SQLite names (sqlite:). */
export function integrityOf(db: StoreDb): string {
  const row = db.prepare<[], { integrity_check: string }>('PRAGMA integrity_check').get();
  return row?.integrity_check ?? 'no answer';
}

/** The highest applied migration, or 0 (the runner's own table, read-only). */
export function schemaVersionOf(db: StoreDb): number {
  try {
    const row = db
      .prepare<[], { v: number | null }>('SELECT MAX(version) AS v FROM schema_migrations')
      .get();
    return row?.v ?? 0;
  } catch {
    // expected: before the first migration there is no schema_migrations table: version 0
    return 0;
  }
}

/** Current `journal_mode`, exposed for tests and diagnostics. */
export function journalMode(db: StoreDb): string {
  return String(db.pragma('journal_mode', { simple: true }));
}
