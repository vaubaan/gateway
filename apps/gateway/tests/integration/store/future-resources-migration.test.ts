/**
 * Migration 0033 — a resource set is one environment, an explicit list, and optionally
 * the resources that appear there later (ADR
 * resource-set-is-one-environment-with-optional-future-resources).
 *
 * A whole-connection set becomes the explicit list of what it reached (hidden ones
 * excepted) with `future` on; every set gets the environment of its resources, or
 * `mixed_env` when they span several (or a whole-connection set had none yet). Nothing
 * is narrowed, the scope column and its index are gone, and `future` is a row source.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MEMORY_PATH, openDb, type StoreDb } from '../../../src/server/store/db.ts';
import { loadMigrations, runMigrations } from '../../../src/server/store/migrate.ts';
import { ManualClock } from '../../../src/server/store/clock.ts';

const AT = '2026-11-03T08:00:00.000Z';

describe('mission resource sets written before migration 0033', () => {
  const clock = new ManualClock();
  let db: StoreDb;

  beforeEach(() => {
    db = openDb({ path: MEMORY_PATH });
  });
  afterEach(() => {
    db.close();
  });

  function seedAtVersion32(): void {
    const shipped = loadMigrations();
    runMigrations(
      db,
      shipped.filter((m) => m.version < 33),
      clock,
    );
    const run = (sql: string, ...params: (string | number | null)[]) =>
      db.prepare(sql).run(...params);
    run(
      "INSERT INTO users (id, subject, identity_key, email, status, created_at) VALUES ('ada', 's', 'k', 'ada@x', 'active', ?)",
      AT,
    );
    const connection = `INSERT INTO connections (id, provider, owner_kind, owner_user_id, display_name, status, created_at, updated_at, default_env)
       VALUES (?, ?, 'user', 'ada', ?, 'active', ?, ?, ?)`;
    run(connection, 'gh', 'github', 'acme', AT, AT, null);
    run(connection, 'sb', 'supabase', 'db', AT, AT, 'staging');
    run(connection, 'fly', 'fly', 'empty', AT, AT, null);
    const resource = `INSERT INTO connection_resources (id, connection_id, ref, display_name, discovered_at, env, hidden, stale_since)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    run(resource, 'r-app', 'gh', 'acme/app', 'app', AT, null, 0, null);
    run(resource, 'r-web', 'gh', 'acme/web', 'web', AT, 'prod', 0, null);
    run(resource, 'r-old', 'gh', 'acme/old', 'old', AT, 'prod', 0, AT);
    run(resource, 'r-hidden', 'gh', 'acme/hidden', 'hidden', AT, null, 1, null);
    run(resource, 'r-db1', 'sb', 'db1', 'db1', AT, null, 0, null);
    run(resource, 'r-db2', 'sb', 'db2', 'db2', AT, 'staging', 0, null);
    const mission = `INSERT INTO missions (id, name, creator_user_id, status, period_anchor, created_at, updated_at)
       VALUES (?, ?, 'ada', 'active', ?, ?, ?)`;
    const missionConnection =
      'INSERT INTO mission_connections (mission_id, connection_id) VALUES (?, ?)';
    const set = `INSERT INTO mission_resource_sets (id, mission_id, connection_id, position, resource_scope)
       VALUES (?, ?, ?, ?, ?)`;
    const selected = `INSERT INTO mission_resources (mission_id, connection_id, resource_id, resource_set_id, source)
       VALUES (?, ?, ?, ?, ?)`;
    // m: the whole of gh (two environments), a list of sb (one environment by default).
    run(mission, 'm', 'M', AT, AT, AT);
    run(missionConnection, 'm', 'gh');
    run(missionConnection, 'm', 'sb');
    run(set, 'm:gh', 'm', 'gh', 1, 'connection');
    run(set, 'm:sb', 'm', 'sb', 1, 'selected');
    run(selected, 'm', 'sb', 'r-db1', 'm:sb', 'issuance');
    run(selected, 'm', 'sb', 'r-db2', 'm:sb', 'created');
    // m2: the whole of a connection with no resource yet; a set of gh with one resource.
    run(mission, 'm2', 'M2', AT, AT, AT);
    run(missionConnection, 'm2', 'fly');
    run(missionConnection, 'm2', 'gh');
    run(set, 'm2:fly', 'm2', 'fly', 1, 'connection');
    run(set, 'm2:gh', 'm2', 'gh', 1, 'selected');
    run(selected, 'm2', 'gh', 'r-web', 'm2:gh', 'issuance');
    // m3: a list mixing environments, and the whole of gh in a second set.
    run(mission, 'm3', 'M3', AT, AT, AT);
    run(missionConnection, 'm3', 'gh');
    run(set, 'm3:list', 'm3', 'gh', 1, 'selected');
    run(set, 'm3:rest', 'm3', 'gh', 2, 'connection');
    run(selected, 'm3', 'gh', 'r-app', 'm3:list', 'issuance');
    run(selected, 'm3', 'gh', 'r-web', 'm3:list', 'edit');
  }

  it('writes the whole connection out as its list with future on, and gives every set its environment', () => {
    seedAtVersion32();
    runMigrations(db, loadMigrations(), clock);

    expect(
      db
        .prepare(
          'SELECT id, future, env, mixed_env FROM mission_resource_sets ORDER BY mission_id, connection_id, position',
        )
        .all(),
    ).toEqual([
      { id: 'm:gh', future: 1, env: null, mixed_env: 1 },
      { id: 'm:sb', future: 0, env: 'staging', mixed_env: 0 },
      { id: 'm2:fly', future: 1, env: null, mixed_env: 1 },
      { id: 'm2:gh', future: 0, env: 'prod', mixed_env: 0 },
      { id: 'm3:list', future: 0, env: null, mixed_env: 1 },
      { id: 'm3:rest', future: 1, env: 'prod', mixed_env: 0 },
    ]);
    expect(
      db
        .prepare(
          'SELECT mission_id, resource_set_id, resource_id, source FROM mission_resources ORDER BY mission_id, resource_set_id, resource_id',
        )
        .all(),
    ).toEqual([
      // What the whole connection reached: hidden excepted, a stale one kept (unreached until it comes back).
      { mission_id: 'm', resource_set_id: 'm:gh', resource_id: 'r-app', source: 'issuance' },
      { mission_id: 'm', resource_set_id: 'm:gh', resource_id: 'r-old', source: 'issuance' },
      { mission_id: 'm', resource_set_id: 'm:gh', resource_id: 'r-web', source: 'issuance' },
      { mission_id: 'm', resource_set_id: 'm:sb', resource_id: 'r-db1', source: 'issuance' },
      { mission_id: 'm', resource_set_id: 'm:sb', resource_id: 'r-db2', source: 'created' },
      { mission_id: 'm2', resource_set_id: 'm2:gh', resource_id: 'r-web', source: 'issuance' },
      { mission_id: 'm3', resource_set_id: 'm3:list', resource_id: 'r-app', source: 'issuance' },
      { mission_id: 'm3', resource_set_id: 'm3:list', resource_id: 'r-web', source: 'edit' },
      // The rest of m3: what its first set did not hold, one environment.
      { mission_id: 'm3', resource_set_id: 'm3:rest', resource_id: 'r-old', source: 'issuance' },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('drops the scope and its index; `future` is a source, another value is refused', () => {
    seedAtVersion32();
    runMigrations(db, loadMigrations(), clock);
    const columns = db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('mission_resource_sets')")
      .all()
      .map((c) => c.name);
    expect(columns).not.toContain('resource_scope');
    expect(columns).toEqual(expect.arrayContaining(['future', 'env', 'mixed_env']));
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'mission_resource_sets_one_whole'",
        )
        .all(),
    ).toEqual([]);
    // Two sets of one connection may both take future resources (of two environments).
    db.prepare(
      "INSERT INTO mission_resource_sets (id, mission_id, connection_id, position, future, env) VALUES ('m:gh2', 'm', 'gh', 2, 1, 'prod')",
    ).run();
    const insert = (source: string) =>
      db
        .prepare(
          "INSERT INTO mission_resources (mission_id, connection_id, resource_id, resource_set_id, source) VALUES ('m2', 'gh', 'r-app', 'm2:gh', ?)",
        )
        .run(source);
    expect(() => insert('elsewhere')).toThrow(/CHECK/);
    expect(() => insert('future')).not.toThrow();
    // Deleting a mission still takes its lists with it.
    db.prepare("DELETE FROM missions WHERE id = 'm'").run();
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM mission_resources WHERE mission_id = 'm'").get(),
    ).toEqual({ n: 0 });
  });
});
