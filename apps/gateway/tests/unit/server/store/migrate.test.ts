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

  it('ships the twenty-seven migrations 0001 to 0027 in the default directory', () => {
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
      [18, 'mission_reaches_the_whole_connection'],
      [19, 'local_accounts'],
      [20, 'administrators'],
      [21, 'user_second_factors'],
      [22, 'audit_risk_sets'],
      [23, 'provider_apps_removed'],
      [24, 'created_resources_join_the_mission'],
      [25, 'mission_connection_crans'],
      [26, 'second_factor_lockout'],
      [27, 'mission_connection_trust_levels'],
    ]);
  });
});

describe('migration 0027: the trust levels under their English names', () => {
  const AT = '2026-10-30T08:00:00.000Z';
  const clock = new ManualClock();
  let db: StoreDb;

  beforeEach(() => {
    db = openDb({ path: MEMORY_PATH });
  });

  afterEach(() => {
    db.close();
  });

  /** Two missions recorded at version 26: one with levels, one without. */
  function seedAtVersion26(): void {
    const shipped = loadMigrations(DEFAULT_MIGRATIONS_DIR);
    runMigrations(
      db,
      shipped.filter((m) => m.version < 27),
      clock,
    );
    db.prepare(
      "INSERT INTO users (id, subject, identity_key, email, status, created_at) VALUES ('ada', 's', 'k', 'ada@x', 'active', ?)",
    ).run(AT);
    db.prepare(
      `INSERT INTO connections (id, provider, owner_kind, owner_user_id, display_name, status, created_at, updated_at)
       VALUES ('gh', 'github', 'user', 'ada', 'acme', 'active', ?, ?)`,
    ).run(AT, AT);
    const mission = db.prepare(
      `INSERT INTO missions (id, name, creator_user_id, status, period_anchor, created_at, updated_at)
       VALUES (?, ?, 'ada', 'active', ?, ?, ?)`,
    );
    mission.run('ticked', 'Ticked', AT, AT, AT);
    mission.run('by-hand', 'By hand', AT, AT, AT);
    const selection = db.prepare(
      "INSERT INTO mission_connections (mission_id, connection_id, resource_scope, crans_json) VALUES (?, 'gh', 'all', ?)",
    );
    selection.run(
      'ticked',
      JSON.stringify({ read: 'prudent', propose: 'confiant', ship: 'autonome' }),
    );
    selection.run('by-hand', null);
  }

  it('renames the column and keeps every mission, its levels rewritten to the new ids', () => {
    seedAtVersion26();

    runMigrations(db, loadMigrations(DEFAULT_MIGRATIONS_DIR), clock);

    expect(
      db
        .prepare(
          'SELECT mission_id, resource_scope, trust_levels_json FROM mission_connections ORDER BY mission_id',
        )
        .all(),
    ).toEqual([
      { mission_id: 'by-hand', resource_scope: 'all', trust_levels_json: null },
      {
        mission_id: 'ticked',
        resource_scope: 'all',
        trust_levels_json: JSON.stringify({
          read: 'careful',
          propose: 'trusting',
          ship: 'autonomous',
        }),
      },
    ]);
    const columns = db
      .prepare('SELECT name FROM pragma_table_info(?)')
      .all('mission_connections') as { name: string }[];
    expect(columns.map((c) => c.name)).not.toContain('crans_json');
  });
});
