import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ManualClock } from './clock';
import { MEMORY_PATH, openDb, openReadonlyDb, schemaVersionOf, type StoreDb } from './db';
import { MigrationError } from './errors';
import { checksumOf, listApplied, runMigrations, type Migration } from './migrate';
import { copyBeforeMigrating, PRE_MIGRATION_DIR, PRE_MIGRATION_KEPT } from './pre-migration-copy';

function migration(version: number): Migration {
  const sql = `CREATE TABLE t${version} (id INTEGER PRIMARY KEY) STRICT;`;
  return { version, name: `t${version}`, sql, checksum: checksumOf(sql) };
}
const upTo = (n: number): Migration[] => Array.from({ length: n }, (_, i) => migration(i + 1));

function storeAt(versions: number): { db: StoreDb; path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pre-migration-'));
  const path = join(dir, 'gateway.sqlite');
  const db = openDb({ path });
  if (versions > 0) runMigrations(db, upTo(versions), new ManualClock());
  return { db, path, dir };
}

const copiesIn = (dir: string): string[] =>
  readdirSync(join(dir, PRE_MIGRATION_DIR))
    .filter((name) => name.endsWith('.sqlite'))
    .sort();

describe('the copy a start leaves before it migrates the store', () => {
  it('copies a store that records migrations and has some pending, as it was', () => {
    const { db, path, dir } = storeAt(2);
    db.exec('INSERT INTO t2 (id) VALUES (7)');
    const clock = new ManualClock('2026-11-28T10:15:00.000Z');

    const copy = copyBeforeMigrating(db, path, upTo(4), clock);
    runMigrations(db, upTo(4), clock);

    expect(copy).toEqual({
      path: join(dir, PRE_MIGRATION_DIR, 'gateway.sqlite.20261128T101500Z.0002-to-0004.sqlite'),
      from: 2,
      to: 4,
    });
    const copied = openReadonlyDb(copy!.path);
    try {
      expect(schemaVersionOf(copied)).toBe(2);
      expect(copied.prepare('SELECT id FROM t2').all()).toEqual([{ id: 7 }]);
    } finally {
      copied.close();
      db.close();
    }
  });

  it('copies nothing for a new store, a current one or :memory:', () => {
    const fresh = storeAt(0);
    expect(copyBeforeMigrating(fresh.db, fresh.path, upTo(3), new ManualClock())).toBeNull();
    const current = storeAt(3);
    expect(copyBeforeMigrating(current.db, current.path, upTo(3), new ManualClock())).toBeNull();
    const memory = openDb({ path: MEMORY_PATH });
    runMigrations(memory, upTo(1), new ManualClock());
    expect(copyBeforeMigrating(memory, MEMORY_PATH, upTo(2), new ManualClock())).toBeNull();
    for (const { dir } of [fresh, current]) {
      expect(readdirSync(dir)).not.toContain(PRE_MIGRATION_DIR);
    }
    fresh.db.close();
    current.db.close();
    memory.close();
  });

  it(`keeps the ${PRE_MIGRATION_KEPT} most recent copies of the store, and no other file is touched`, () => {
    const { db, path, dir } = storeAt(1);
    const clock = new ManualClock('2026-11-28T08:00:00.000Z');
    for (let to = 2; to <= 6; to++) {
      copyBeforeMigrating(db, path, upTo(to), clock);
      runMigrations(db, upTo(to), clock);
      if (to === 3) writeFileSync(join(dir, PRE_MIGRATION_DIR, 'notes.txt'), 'kept');
      clock.advance(60_000);
    }
    expect(copiesIn(dir)).toEqual([
      'gateway.sqlite.20261128T080200Z.0003-to-0004.sqlite',
      'gateway.sqlite.20261128T080300Z.0004-to-0005.sqlite',
      'gateway.sqlite.20261128T080400Z.0005-to-0006.sqlite',
    ]);
    expect(readdirSync(join(dir, PRE_MIGRATION_DIR))).toContain('notes.txt');
    db.close();
  });

  it('stops the start before any migration when the copy cannot be written', () => {
    const { db, path, dir } = storeAt(1);
    // A file where the copies' folder goes: the folder cannot be made.
    writeFileSync(join(dir, PRE_MIGRATION_DIR), 'not a folder');

    expect(() => copyBeforeMigrating(db, path, upTo(2), new ManualClock())).toThrow(MigrationError);
    expect(() => copyBeforeMigrating(db, path, upTo(2), new ManualClock())).toThrow(
      /migration 0002 is pending, .*no migration ran/,
    );
    expect(listApplied(db).map((m) => m.version)).toEqual([1]);
    db.close();
  });
});
