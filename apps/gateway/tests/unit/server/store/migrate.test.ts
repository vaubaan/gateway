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

  it('ships the forty-three migrations 0001 to 0043 in the default directory', () => {
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
      [28, 'argon2id_tokens_revoked'],
      [29, 'resource_sets'],
      [30, 'notification_devices'],
      [31, 'notification_addresses'],
      [32, 'notification_mail'],
      [33, 'resource_set_future_and_env'],
      [34, 'resource_hidden_edited'],
      [35, 'platform_management_plugin'],
      [36, 'one_word_per_thing'],
      [37, 'provider_is_service'],
      [38, 'audit_call_bytes'],
      [39, 'mission_versions'],
      [40, 'one_vaubaan_account_per_person'],
      [41, 'plugin_versions'],
      [42, 'plugin_signers'],
      [43, 'mission_logs'],
    ]);
  });
});

describe('migration 0035: the management door retired, its missions kept', () => {
  const AT = '2026-11-14T08:00:00.000Z';
  const clock = new ManualClock();
  let db: StoreDb;

  beforeEach(() => {
    db = openDb({ path: MEMORY_PATH });
    runMigrations(
      db,
      loadMigrations(DEFAULT_MIGRATIONS_DIR).filter((m) => m.version < 35),
      clock,
    );
    db.prepare(
      "INSERT INTO users (id, subject, identity_key, email, status, created_at) VALUES ('ada', 's', 'k', 'ada@x', 'active', ?)",
    ).run(AT);
    db.prepare(
      "INSERT INTO oauth_clients (id, client_id, name, created_at) VALUES ('c1', 'vbn_client_x', 'Claude Code', ?)",
    ).run(AT);
    db.prepare(
      "INSERT INTO oauth_client_redirect_uris (client_id, uri) VALUES ('c1', 'http://127.0.0.1/cb')",
    ).run();
    db.prepare(
      "INSERT INTO delegations (id, user_id, client_id, scope, status, created_at) VALUES ('d1', 'ada', 'c1', 'mgmt', 'active', ?)",
    ).run(AT);
    const mission = db.prepare(
      `INSERT INTO missions (id, name, creator_user_id, status, period_anchor, delegation_id, created_at, updated_at)
       VALUES (?, ?, 'ada', 'active', ?, ?, ?, ?)`,
    );
    mission.run('by-app', 'Prepared by an app', AT, 'd1', AT, AT);
    mission.run('by-hand', 'Issued in the interface', AT, null, AT, AT);
  });

  afterEach(() => {
    db.close();
  });

  it('keeps every mission, names the app that prepared one, and drops the OAuth tables', () => {
    runMigrations(db, loadMigrations(DEFAULT_MIGRATIONS_DIR), clock);
    expect(
      db
        .prepare(
          'SELECT id, delegation_id, issued_by_mission_id, issued_via_client_name FROM missions ORDER BY id',
        )
        .all(),
    ).toEqual([
      {
        id: 'by-app',
        delegation_id: null,
        issued_by_mission_id: null,
        issued_via_client_name: 'Claude Code',
      },
      {
        id: 'by-hand',
        delegation_id: null,
        issued_by_mission_id: null,
        issued_via_client_name: null,
      },
    ]);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'oauth%'")
      .all();
    expect(tables).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM delegations').get()).toEqual({ n: 0 });
  });
});

describe('migration 0043: the mission log, never a session', () => {
  const AT = '2026-11-25T08:00:00.000Z';
  const clock = new ManualClock();
  let db: StoreDb;

  beforeEach(() => {
    db = openDb({ path: MEMORY_PATH });
    runMigrations(
      db,
      loadMigrations(DEFAULT_MIGRATIONS_DIR).filter((m) => m.version < 43),
      clock,
    );
    const run = (sql: string): void => {
      db.prepare(sql).run(AT);
    };
    run(
      "INSERT INTO users (id, subject, identity_key, email, status, created_at) VALUES ('ada', 's', 'k', 'ada@x', 'active', ?)",
    );
    db.prepare(
      `INSERT INTO missions (id, name, creator_user_id, status, period_anchor, created_at, updated_at)
       VALUES ('m', 'mission', 'ada', 'active', ?, ?, ?)`,
    ).run(AT, AT, AT);
    run("INSERT INTO sessions (id, mission_id, created_at) VALUES ('log', 'm', ?)");
    run(
      `INSERT INTO session_counters (session_id, resource_set_id, risk_id, period_start, consumed)
       VALUES ('log', 'set', 'github.code-read', ?, 3)`,
    );
    run(
      `INSERT INTO events (id, session_id, ts, kind, risk_id, details_json)
       VALUES ('e', 'log', ?, 'call-allowed', 'github.code-read', '{}')`,
    );
    db.prepare(
      `INSERT INTO requests (id, mission_id, session_id, kind, state, risk_id, created_at, expires_at)
       VALUES ('r', 'm', 'log', 'claim', 'open', 'github.code-read', ?, ?)`,
    ).run(AT, AT);
    run(
      `INSERT INTO audit (id, ts, kind, mission_id, session_id, tool, arguments_hash, decision)
       VALUES ('a', ?, 'call', 'm', 'log', 'github__read', 'h', 'allowed')`,
    );
  });

  afterEach(() => {
    db.close();
  });

  it('keeps every row under the new names, its foreign keys and indexes with it', () => {
    runMigrations(db, loadMigrations(DEFAULT_MIGRATIONS_DIR), clock);
    const one = (sql: string): unknown => db.prepare(sql).get();
    expect(one('SELECT id, mission_id FROM mission_logs')).toEqual({ id: 'log', mission_id: 'm' });
    expect(one('SELECT mission_log_id, consumed FROM mission_log_counters')).toEqual({
      mission_log_id: 'log',
      consumed: 3,
    });
    expect(one('SELECT mission_log_id FROM events')).toEqual({ mission_log_id: 'log' });
    expect(one('SELECT mission_log_id FROM requests')).toEqual({ mission_log_id: 'log' });
    expect(one('SELECT mission_log_id FROM audit')).toEqual({ mission_log_id: 'log' });
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name LIKE '%session%' AND tbl_name <> 'web_sessions' ORDER BY name",
        )
        .all(),
    ).toEqual([]);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events' ORDER BY name",
        )
        .all(),
    ).toEqual(
      expect.arrayContaining([
        { name: 'events_mission_log_holder_ts' },
        { name: 'events_mission_log_label_ts' },
        { name: 'events_mission_log_ts' },
      ]),
    );
    expect(db.pragma('foreign_key_check')).toEqual([]);
    // The cascade follows the rename: deleting the mission deletes its log, counters and events.
    db.prepare("DELETE FROM requests WHERE id = 'r'").run();
    db.prepare("DELETE FROM missions WHERE id = 'm'").run();
    expect(one('SELECT COUNT(*) AS n FROM mission_logs')).toEqual({ n: 0 });
    expect(one('SELECT COUNT(*) AS n FROM mission_log_counters')).toEqual({ n: 0 });
    expect(one('SELECT COUNT(*) AS n FROM events')).toEqual({ n: 0 });
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

    // Up to 0028: 0029 moves the levels to the resource sets (its own test below).
    runMigrations(
      db,
      loadMigrations(DEFAULT_MIGRATIONS_DIR).filter((m) => m.version < 29),
      clock,
    );

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

describe('migration 0029: a mission connection is partitioned into resource sets', () => {
  const AT = '2026-10-31T08:00:00.000Z';
  const PERIOD = '2026-10-31T00:00:00.000Z';
  const clock = new ManualClock();
  let db: StoreDb;

  beforeEach(() => {
    db = openDb({ path: MEMORY_PATH });
  });

  afterEach(() => {
    db.close();
  });

  /** A mission on two accounts recorded at version 28, with a session, requests and audit. */
  function seedAtVersion28(): void {
    runMigrations(
      db,
      loadMigrations(DEFAULT_MIGRATIONS_DIR).filter((m) => m.version < 29),
      clock,
    );
    const run = (sql: string, ...params: (string | number | null)[]) =>
      db.prepare(sql).run(...params);
    run(
      "INSERT INTO users (id, subject, identity_key, email, status, created_at) VALUES ('ada', 's', 'k', 'ada@x', 'active', ?)",
      AT,
    );
    const connection = `INSERT INTO connections (id, provider, owner_kind, owner_user_id, display_name, status, created_at, updated_at)
       VALUES (?, ?, 'user', 'ada', ?, 'active', ?, ?)`;
    run(connection, 'gh', 'github', 'acme', AT, AT);
    run(connection, 'sb', 'supabase', 'db', AT, AT);
    run(
      `INSERT INTO connection_resources (id, connection_id, ref, display_name, discovered_at)
       VALUES ('res-app', 'gh', 'acme/app', 'app', ?)`,
      AT,
    );
    run(
      `INSERT INTO missions (id, name, creator_user_id, status, period_anchor, period_seconds, created_at, updated_at)
       VALUES ('m', 'M', 'ada', 'active', ?, 86400, ?, ?)`,
      PERIOD,
      AT,
      AT,
    );
    run(
      `INSERT INTO mission_connections (mission_id, connection_id, resource_scope, trust_levels_json)
       VALUES ('m', 'gh', 'selected', ?)`,
      JSON.stringify({ read: 'trusting' }),
    );
    run(
      "INSERT INTO mission_connections (mission_id, connection_id, resource_scope) VALUES ('m', 'sb', 'connection')",
    );
    run(
      "INSERT INTO mission_resources (mission_id, connection_id, resource_id, source) VALUES ('m', 'gh', 'res-app', 'created')",
    );
    const line = `INSERT INTO mission_policy (mission_id, risk_id, quota, rate_limit, rate_window_seconds, gate)
       VALUES ('m', ?, ?, 5, 60, ?)`;
    run(line, 'github.code-read', 10, 'auto');
    run(line, 'github.merge-protected', 2, 'approval');
    run(line, 'supabase[staging].row-write', 3, 'auto');
    // A line of a service the mission holds no account of: no call could reach it.
    run(line, 'fly.app-read', 1, 'auto');
    run("INSERT INTO sessions (id, mission_id, created_at) VALUES ('s', 'm', ?)", AT);
    const counter = `INSERT INTO session_counters (session_id, risk_id, period_start, consumed)
       VALUES ('s', ?, ?, ?)`;
    run(counter, 'github.code-read', PERIOD, 4);
    run(counter, 'supabase[staging].row-write', PERIOD, 1);
    run(counter, 'fly.app-read', PERIOD, 1);
    run(
      `INSERT INTO events (id, session_id, ts, kind, risk_id, details_json)
       VALUES ('e1', 's', ?, 'gate-opened', 'github.merge-protected', '{}')`,
      AT,
    );
    run(
      "INSERT INTO events (id, session_id, ts, kind, risk_id, details_json) VALUES ('e2', 's', ?, 'rotation', NULL, '{}')",
      AT,
    );
    run(
      `INSERT INTO requests (id, mission_id, session_id, kind, state, risk_id, risk_ids_json, tool, fingerprint, created_at, expires_at)
       VALUES ('r1', 'm', 's', 'approval', 'open', 'github.merge-protected', ?, 'github__merge', 'fp', ?, ?)`,
      JSON.stringify(['github.merge-protected', 'github.code-read']),
      AT,
      '2026-11-01T08:00:00.000Z',
    );
    run(
      `INSERT INTO audit (id, ts, kind, mission_id, session_id, connection_id, tool, arguments_hash, slices_json, decision)
       VALUES ('a1', ?, 'call', 'm', 's', 'gh', 'github__get_file', 'h', '[]', 'allowed')`,
      AT,
    );
  }

  it('starts the trust-raise count of every stored trust level at the upgrade', () => {
    seedAtVersion28();
    const before = new Date().toISOString();
    runMigrations(db, loadMigrations(DEFAULT_MIGRATIONS_DIR), clock);
    const marks = db
      .prepare(
        'SELECT mission_id, resource_set_id, macro_action_id, level_changed_at, snoozed_at FROM mission_trust_marks',
      )
      .all() as { level_changed_at: string }[];
    // One mark per stored trust level (the `sb` set stored none), stamped at the upgrade:
    // approvals granted before it never lead to an offer.
    expect(marks).toEqual([
      {
        mission_id: 'm',
        resource_set_id: 'm:gh',
        macro_action_id: 'read',
        level_changed_at: expect.any(String) as string,
        snoozed_at: null,
      },
    ]);
    expect(marks[0]!.level_changed_at >= before.slice(0, 19)).toBe(true);
    expect(marks[0]!.level_changed_at > AT).toBe(true);
  });

  it('gives each existing connection one set holding its scope, resources, levels and lines', () => {
    seedAtVersion28();
    // Up to 0032: 0033 replaces the scope by `future` (its own test).
    runMigrations(
      db,
      loadMigrations(DEFAULT_MIGRATIONS_DIR).filter((m) => m.version < 33),
      clock,
    );

    expect(
      db
        .prepare(
          'SELECT id, connection_id, position, resource_scope, trust_levels_json FROM mission_resource_sets ORDER BY connection_id',
        )
        .all(),
    ).toEqual([
      {
        id: 'm:gh',
        connection_id: 'gh',
        position: 1,
        resource_scope: 'selected',
        trust_levels_json: JSON.stringify({ read: 'trusting' }),
      },
      {
        id: 'm:sb',
        connection_id: 'sb',
        position: 1,
        resource_scope: 'connection',
        trust_levels_json: null,
      },
    ]);
    expect(
      db.prepare('SELECT resource_id, resource_set_id, source FROM mission_resources').all(),
    ).toEqual([{ resource_id: 'res-app', resource_set_id: 'm:gh', source: 'created' }]);
    expect(
      db
        .prepare(
          'SELECT resource_set_id, risk_id, quota, gate FROM mission_policy ORDER BY risk_id',
        )
        .all(),
    ).toEqual([
      { resource_set_id: 'm:gh', risk_id: 'github.code-read', quota: 10, gate: 'auto' },
      { resource_set_id: 'm:gh', risk_id: 'github.merge-protected', quota: 2, gate: 'approval' },
      { resource_set_id: 'm:sb', risk_id: 'supabase[staging].row-write', quota: 3, gate: 'auto' },
    ]);
    expect(
      db
        .prepare('SELECT resource_set_id, risk_id, consumed FROM session_counters ORDER BY risk_id')
        .all(),
    ).toEqual([
      { resource_set_id: 'm:gh', risk_id: 'github.code-read', consumed: 4 },
      { resource_set_id: 'm:sb', risk_id: 'supabase[staging].row-write', consumed: 1 },
    ]);
    expect(db.prepare('SELECT id, resource_set_id FROM events ORDER BY id').all()).toEqual([
      { id: 'e1', resource_set_id: 'm:gh' },
      { id: 'e2', resource_set_id: null },
    ]);
    expect(
      db.prepare('SELECT request_id, resource_set_id, risk_id FROM request_lines').all(),
    ).toEqual([{ request_id: 'r1', resource_set_id: 'm:gh', risk_id: 'github.merge-protected' }]);
    expect(db.prepare('SELECT audit_id, resource_set_id FROM audit_resource_sets').all()).toEqual([
      { audit_id: 'a1', resource_set_id: 'm:gh' },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('refuses a second whole-connection set on one connection', () => {
    seedAtVersion28();
    // Up to 0032: 0033 replaces the scope by `future` (its own test).
    runMigrations(
      db,
      loadMigrations(DEFAULT_MIGRATIONS_DIR).filter((m) => m.version < 33),
      clock,
    );
    expect(() =>
      db
        .prepare(
          "INSERT INTO mission_resource_sets (id, mission_id, connection_id, position, resource_scope) VALUES ('x', 'm', 'sb', 2, 'connection')",
        )
        .run(),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db
        .prepare(
          "INSERT INTO mission_resource_sets (id, mission_id, connection_id, position, resource_scope) VALUES ('y', 'm', 'sb', 2, 'selected')",
        )
        .run(),
    ).not.toThrow();
  });
});
