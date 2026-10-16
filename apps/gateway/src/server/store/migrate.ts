/**
 * Forward-only migration runner over numbered `.sql` files.
 *
 * ADR: docs/decisions/embedded-store-sqlite-and-migrations.md. The schema is owned by
 * the application: at boot, every file in `apps/gateway/migrations/` named
 * `NNNN_name.sql` that is not yet recorded in `schema_migrations` runs inside one
 * transaction and is recorded with its checksum. Re-running is a no-op. A file whose
 * checksum no longer matches its recorded one aborts the boot: applied migrations are
 * immutable, fixes are new files. A database that records a migration this image does
 * not ship (an older image started on a newer volume) aborts the boot too, naming it.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Clock } from './clock.ts';
import { toIso } from './clock.ts';
import { type StoreDb, withImmediateTransaction } from './db.ts';
import { MigrationError } from './errors.ts';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export interface MigrationResult {
  /** Migrations applied by this run, in order. Empty when the schema was current. */
  readonly applied: readonly Migration[];
  /** Highest version recorded after the run. */
  readonly currentVersion: number;
}

const FILE_RE = /^(\d{4})_([a-z0-9][a-z0-9_-]*)\.sql$/;

/**
 * `apps/gateway/migrations`, resolved relative to this module. Written with
 * `path.resolve` rather than `new URL('../…/', import.meta.url)` on purpose:
 * webpack treats the latter as an asset import and refuses to build the
 * Next server bundle (the files are traced into the standalone output by
 * `outputFileTracingIncludes` in `next.config.ts`).
 */
export const DEFAULT_MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../migrations/',
);

export function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Migration[] {
  const migrations: Migration[] = [];
  // turbopackIgnore: without it the bundler sees a dynamic directory read and
  // traces the whole project into the standalone output. The SQL files reach
  // the output through `outputFileTracingIncludes` in next.config.ts.
  for (const file of readdirSync(/* turbopackIgnore: true */ dir).sort()) {
    const match = FILE_RE.exec(file);
    if (!match) {
      if (file.endsWith('.sql')) {
        throw new MigrationError(`migration file name does not match NNNN_name.sql: ${file}`);
      }
      continue;
    }
    const version = Number.parseInt(match[1] ?? '', 10);
    const sql = readFileSync(/* turbopackIgnore: true */ join(dir, file), 'utf8');
    migrations.push({ version, name: match[2] ?? '', sql, checksum: checksumOf(sql) });
  }
  for (let i = 1; i < migrations.length; i++) {
    const prev = migrations[i - 1];
    const cur = migrations[i];
    if (prev && cur && cur.version <= prev.version) {
      throw new MigrationError(
        `duplicate migration version ${String(cur.version).padStart(4, '0')}`,
      );
    }
  }
  return migrations;
}

export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER NOT NULL PRIMARY KEY,
  name        TEXT    NOT NULL,
  checksum    TEXT    NOT NULL,
  applied_at  TEXT    NOT NULL
) STRICT`; // sqlite: STRICT

/** Creates `schema_migrations` when the database is new. Idempotent. */
export function ensureMigrationsTable(db: StoreDb): void {
  db.exec(BOOTSTRAP_SQL);
}

/** Applied migrations in version order (creates the table on a new database). */
export function listApplied(db: StoreDb): AppliedMigration[] {
  ensureMigrationsTable(db);
  return db
    .prepare<[], { version: number; name: string; checksum: string; applied_at: string }>(
      'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version',
    )
    .all()
    .map((r) => ({
      version: r.version,
      name: r.name,
      checksum: r.checksum,
      appliedAt: r.applied_at,
    }));
}

export function runMigrations(
  db: StoreDb,
  migrations: readonly Migration[],
  clock: Clock,
): MigrationResult {
  const applied = new Map(listApplied(db).map((m) => [m.version, m]));
  assertNoUnknownMigration(applied, migrations);
  const ran: Migration[] = [];
  const record = db.prepare<[number, string, string, string]>(
    'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
  );

  for (const migration of migrations) {
    const existing = applied.get(migration.version);
    if (existing) {
      if (existing.checksum !== migration.checksum) {
        throw new MigrationError(
          `migration ${migration.version} (${migration.name}) was applied with a different content; applied migrations are immutable`,
        );
      }
      continue;
    }
    withImmediateTransaction(db, () => {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, migration.checksum, toIso(clock.now()));
    });
    ran.push(migration);
  }

  const versions = [...applied.keys(), ...ran.map((m) => m.version)];
  return { applied: ran, currentVersion: versions.length ? Math.max(...versions) : 0 };
}

/** Downgrade protection: every recorded migration must have a file in this image. */
function assertNoUnknownMigration(
  applied: ReadonlyMap<number, AppliedMigration>,
  migrations: readonly Migration[],
): void {
  const shipped = new Set(migrations.map((m) => m.version));
  const unknown = [...applied.values()].filter((m) => !shipped.has(m.version));
  if (unknown.length === 0) return;
  const names = unknown.map((m) => `${String(m.version).padStart(4, '0')}_${m.name}`);
  throw new MigrationError(
    `database carries migrations this image does not know: ${names.join(', ')}; ` +
      'start an image at least as new as the one that wrote the database',
  );
}
