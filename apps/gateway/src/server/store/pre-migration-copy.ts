/**
 * The copy a start leaves beside the store before it migrates it (ADR
 * store-copied-before-a-migration): migrations go forward only and an older image refuses a
 * newer store, so the way back after a bad release is this copy, restored with the former
 * image (`restore.mjs <copy> --force`).
 *
 * Only a file store that already records migrations and has some pending is copied: a new
 * store has nothing to lose, a current one changes no schema. The copy is `VACUUM INTO`
 * `<store dir>/pre-migration/<store name>.<time>.<from>-to-<to>.sqlite`; the time comes first
 * so that the names sort in the order the copies were made, and the three most recent are
 * kept. A copy that cannot be written stops the start before any migration runs.
 */
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { Clock } from './clock.ts';
import { backupTo, MEMORY_PATH, type StoreDb } from './db.ts';
import { MigrationError } from './errors.ts';
import { compareWithShipped, listApplied, type Migration } from './migrate.ts';

export const PRE_MIGRATION_DIR = 'pre-migration';
export const PRE_MIGRATION_KEPT = 3;

export interface PreMigrationCopy {
  readonly path: string;
  /** The schema version the copy holds. */
  readonly from: number;
  /** The schema version this start migrates to. */
  readonly to: number;
}

/** `20261128T101500Z`: sortable, and a valid file name everywhere. */
function stampOf(clock: Clock): string {
  return clock
    .now()
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');
}

const version = (n: number): string => String(n).padStart(4, '0');

/**
 * Copies the store when this start is about to migrate it, then keeps the most recent
 * copies; answers the copy, or `null` when nothing was to be copied.
 */
export function copyBeforeMigrating(
  db: StoreDb,
  storePath: string,
  migrations: readonly Migration[],
  clock: Clock,
): PreMigrationCopy | null {
  if (storePath === MEMORY_PATH) return null;
  if (!compareWithShipped(db, migrations).hasMigrationsTable) return null;
  const applied = new Set(listApplied(db).map((m) => m.version));
  if (applied.size === 0) return null;
  const pending = migrations.filter((m) => !applied.has(m.version));
  if (pending.length === 0) return null;

  const from = Math.max(...applied);
  const to = Math.max(...pending.map((m) => m.version));
  const dir = join(dirname(storePath), PRE_MIGRATION_DIR);
  const prefix = `${basename(storePath)}.`;
  const path = join(dir, `${prefix}${stampOf(clock)}.${version(from)}-to-${version(to)}.sqlite`);
  try {
    mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true, mode: 0o700 });
    backupTo(db, path);
  } catch (err) {
    removeHalfWritten(path);
    const pendingText =
      pending.length === 1
        ? `migration ${version(to)} is pending`
        : `migrations ${version(from + 1)} to ${version(to)} are pending`;
    throw new MigrationError(
      `${pendingText}, and the copy of the store made before migrating could not be written in ` +
        `${dir} (free space? write access?); no migration ran`,
      { cause: err },
    );
  }
  pruneCopies(dir, prefix);
  return { path, from, to };
}

/** Removes what a failed `VACUUM INTO` left, if anything. */
function removeHalfWritten(path: string): void {
  try {
    rmSync(/* turbopackIgnore: true */ path, { force: true });
  } catch {
    // expected: the folder itself could not be made, so there is no file to remove.
  }
}

/** Keeps the `PRE_MIGRATION_KEPT` most recent copies of this store, by name. */
function pruneCopies(dir: string, prefix: string): void {
  const copies = readdirSync(/* turbopackIgnore: true */ dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.sqlite'))
    .sort();
  for (const name of copies.slice(0, Math.max(0, copies.length - PRE_MIGRATION_KEPT))) {
    rmSync(/* turbopackIgnore: true */ join(dir, name), { force: true });
  }
}
