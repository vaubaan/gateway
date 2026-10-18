import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../../../../src/server/store/clock.ts';
import { MEMORY_PATH, openDb, type StoreDb } from '../../../../src/server/store/db.ts';
import { MigrationError } from '../../../../src/server/store/errors.ts';
import {
  DEFAULT_MIGRATIONS_DIR,
  listApplied,
  loadMigrations,
  runMigrations,
} from '../../../../src/server/store/migrate.ts';

describe('migration runner', () => {
  let dir: string;
  let db: StoreDb;
  const clock = new ManualClock();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vbn-migrations-'));
    db = openDb({ path: MEMORY_PATH });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, sql: string): void {
    writeFileSync(join(dir, name), sql);
  }

  it('loads numbered files in order with a checksum', () => {
    write('0002_second.sql', 'CREATE TABLE b (id TEXT NOT NULL PRIMARY KEY) STRICT;');
    write('0001_first.sql', 'CREATE TABLE a (id TEXT NOT NULL PRIMARY KEY) STRICT;');
    write('README.md', 'ignored');
    const migrations = loadMigrations(dir);
    expect(migrations.map((m) => [m.version, m.name])).toEqual([
      [1, 'first'],
      [2, 'second'],
    ]);
    expect(migrations[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a .sql file that does not follow NNNN_name.sql', () => {
    write('schema.sql', 'SELECT 1;');
    expect(() => loadMigrations(dir)).toThrow(MigrationError);
  });

  it('rejects duplicate versions', () => {
    write('0001_a.sql', 'SELECT 1;');
    write('0001_b.sql', 'SELECT 1;');
    expect(() => loadMigrations(dir)).toThrow(/duplicate migration version 0001/);
  });

  it('applies pending migrations once and is idempotent on re-run', () => {
    write('0001_first.sql', 'CREATE TABLE a (id TEXT NOT NULL PRIMARY KEY) STRICT;');
    const first = runMigrations(db, loadMigrations(dir), clock);
    expect(first.applied.map((m) => m.version)).toEqual([1]);
    expect(first.currentVersion).toBe(1);

    const second = runMigrations(db, loadMigrations(dir), clock);
    expect(second.applied).toEqual([]);
    expect(second.currentVersion).toBe(1);
    expect(listApplied(db).map((m) => m.version)).toEqual([1]);
  });

  it('applies only the new files when the directory grows', () => {
    write('0001_first.sql', 'CREATE TABLE a (id TEXT NOT NULL PRIMARY KEY) STRICT;');
    runMigrations(db, loadMigrations(dir), clock);
    write('0002_second.sql', 'ALTER TABLE a ADD COLUMN label TEXT;');
    const result = runMigrations(db, loadMigrations(dir), clock);
    expect(result.applied.map((m) => m.version)).toEqual([2]);
    expect(db.prepare('INSERT INTO a (id, label) VALUES (?, ?)').run('x', 'y').changes).toBe(1);
  });

  it('refuses to boot when an applied migration was edited', () => {
    write('0001_first.sql', 'CREATE TABLE a (id TEXT NOT NULL PRIMARY KEY) STRICT;');
    runMigrations(db, loadMigrations(dir), clock);
    write('0001_first.sql', 'CREATE TABLE a (id TEXT NOT NULL PRIMARY KEY, extra TEXT) STRICT;');
    expect(() => runMigrations(db, loadMigrations(dir), clock)).toThrow(/immutable/);
  });

  it('rolls a failing migration back entirely and records nothing', () => {
    write(
      '0001_broken.sql',
      'CREATE TABLE a (id TEXT NOT NULL PRIMARY KEY) STRICT; CREATE TABLE a (id TEXT) STRICT;',
    );
    expect(() => runMigrations(db, loadMigrations(dir), clock)).toThrow();
    expect(listApplied(db)).toEqual([]);
    const tables = db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((t) => t.name);
    expect(tables).not.toContain('a');
  });

  it('refuses to boot a database that carries a migration this image does not ship', () => {
    write('0001_first.sql', 'CREATE TABLE a (id TEXT NOT NULL PRIMARY KEY) STRICT;');
    write('0002_second.sql', 'ALTER TABLE a ADD COLUMN label TEXT;');
    runMigrations(db, loadMigrations(dir), clock);
    rmSync(join(dir, '0002_second.sql'));
    expect(() => runMigrations(db, loadMigrations(dir), clock)).toThrow(
      /does not know: 0002_second/,
    );
  });

  it('ships the seventeen migrations 0001 to 0017 in the default directory', () => {
    const shipped = loadMigrations(DEFAULT_MIGRATIONS_DIR);
    expect(shipped.map((m) => [m.version, m.name])).toEqual([
      [1, 'schema'],
      [2, 'audit_risks_purge_guard'],
      [3, 'web_sessions'],
      [4, 'connection_resource_curation'],
      [5, 'approval_bound_to_tool'],
      [6, 'oauth_client_decisions'],
      [7, 'orphaned_not_stored'],
      [8, 'events_agent_label'],
      [9, 'user_sessions_ended_at'],
      [10, 'mission_members_and_token_holders'],
      [11, 'users_keyed_by_issuer_and_subject'],
      [12, 'connection_provider_grant'],
      [13, 'request_covers_the_call'],
      [14, 'sign_in_providers_and_invitations'],
      [15, 'git_pending_refs'],
      [16, 'permission_requests'],
      [17, 'connection_default_env'],
    ]);
  });
});
