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

import BetterSqlite3 from 'better-sqlite3';
import { StoreError } from './errors.ts';

export const MEMORY_PATH = ':memory:';

/** Oldest SQLite that understands `STRICT` tables. */
const MIN_SQLITE_VERSION = [3, 37, 0] as const;

export interface OpenDbOptions {
  /** File path, or `MEMORY_PATH` for an ephemeral in-memory database. */
  readonly path: string;
  /** Milliseconds a writer waits on a locked database before `SQLITE_BUSY`. */
  readonly busyTimeoutMs?: number;
}

export type SqlValue = string | number | bigint | Buffer | null;

export type StoreDb = BetterSqlite3.Database;

export function openDb(options: OpenDbOptions): StoreDb {
  const db = new BetterSqlite3(options.path, { timeout: options.busyTimeoutMs ?? 5000 });
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

function assertSqliteVersion(db: StoreDb): void {
  const row = db.prepare<[], { v: string }>('SELECT sqlite_version() AS v').get();
  const version = row?.v ?? '0.0.0';
  const parts = version.split('.').map((p) => Number.parseInt(p, 10));
  const [maj = 0, min = 0, pat = 0] = parts;
  const [rMaj, rMin, rPat] = MIN_SQLITE_VERSION;
  const ok =
    maj > rMaj || (maj === rMaj && min > rMin) || (maj === rMaj && min === rMin && pat >= rPat);
  if (!ok) {
    throw new StoreError(
      `SQLite ${version} is too old; ${MIN_SQLITE_VERSION.join('.')} or newer is required (STRICT tables)`,
    );
  }
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

/** Current `journal_mode`, exposed for tests and diagnostics. */
export function journalMode(db: StoreDb): string {
  return String(db.pragma('journal_mode', { simple: true }));
}
