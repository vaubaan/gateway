/**
 * Migration 0018 — a mission may reach the whole connection (spec §3.1 "Resource
 * selection"; ADR mission-reaches-the-whole-connection-on-request).
 *
 * The rebuild of `mission_connections` and `mission_resources` keeps every row an
 * earlier image wrote, with its scope: nothing is widened by the migration. The new
 * value is accepted afterwards, an unknown one is still refused, and the foreign keys
 * between the two tables hold as before.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MEMORY_PATH, openDb } from '../../../src/server/store/db.ts';
import { loadMigrations, runMigrations } from '../../../src/server/store/migrate.ts';
import { openTestStore, type TestStore } from '../../support/store/testing.ts';

const AT = '2026-10-13T08:00:00.000Z';

describe('mission selections written before migration 0018', () => {
  let t: TestStore;

  beforeEach(() => {
    t = openTestStore();
  });
  afterEach(async () => {
    await t.store.close();
  });

  it('keep their scope and their resources; the whole-connection scope is accepted after it', () => {
    const db = openDb({ path: MEMORY_PATH });
    try {
      const shipped = loadMigrations();
      runMigrations(
        db,
        shipped.filter((m) => m.version < 18),
        t.clock,
      );
      db.prepare(
        "INSERT INTO users (id, subject, identity_key, email, status, created_at) VALUES ('ada', 's', 'k', 'ada@x', 'active', ?)",
      ).run(AT);
      const connection = db.prepare(
        `INSERT INTO connections (id, provider, owner_kind, owner_user_id, display_name, status, created_at, updated_at)
         VALUES (?, ?, 'user', 'ada', ?, 'active', ?, ?)`,
      );
      connection.run('gh', 'github', 'acme', AT, AT);
      connection.run('fly', 'fly', 'acme-org', AT, AT);
      db.prepare(
        `INSERT INTO connection_resources (id, connection_id, ref, display_name, discovered_at)
         VALUES ('res-app', 'gh', 'acme/app', 'app', ?)`,
      ).run(AT);
      const mission = db.prepare(
        `INSERT INTO missions (id, name, creator_user_id, status, period_anchor, created_at, updated_at)
         VALUES (?, ?, 'ada', 'active', ?, ?, ?)`,
      );
      mission.run('m', 'M', AT, AT, AT);
      db.prepare(
        "INSERT INTO mission_connections (mission_id, connection_id, resource_scope) VALUES ('m', 'gh', 'selected')",
      ).run();
      db.prepare(
        "INSERT INTO mission_connections (mission_id, connection_id, resource_scope) VALUES ('m', 'fly', 'all')",
      ).run();
      db.prepare(
        "INSERT INTO mission_resources (mission_id, connection_id, resource_id) VALUES ('m', 'gh', 'res-app')",
      ).run();

      runMigrations(db, shipped, t.clock);

      expect(
        db
          .prepare(
            'SELECT mission_id, connection_id, resource_scope FROM mission_connections ORDER BY connection_id',
          )
          .all(),
      ).toEqual([
        { mission_id: 'm', connection_id: 'fly', resource_scope: 'all' },
        { mission_id: 'm', connection_id: 'gh', resource_scope: 'selected' },
      ]);
      expect(
        db.prepare('SELECT mission_id, connection_id, resource_id FROM mission_resources').all(),
      ).toEqual([{ mission_id: 'm', connection_id: 'gh', resource_id: 'res-app' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);

      mission.run('m2', 'M2', AT, AT, AT);
      db.prepare(
        "INSERT INTO mission_connections (mission_id, connection_id, resource_scope) VALUES ('m2', 'fly', 'connection')",
      ).run();
      expect(() =>
        db
          .prepare(
            "INSERT INTO mission_connections (mission_id, connection_id, resource_scope) VALUES ('m2', 'gh', 'everything')",
          )
          .run(),
      ).toThrow(/CHECK/);
      // The child still names its parent: a resource row of an unknown selection is refused,
      // and deleting a mission still takes its selection with it.
      expect(() =>
        db
          .prepare(
            "INSERT INTO mission_resources (mission_id, connection_id, resource_id) VALUES ('m2', 'gh', 'res-app')",
          )
          .run(),
      ).toThrow(/FOREIGN KEY/);
      db.prepare("DELETE FROM missions WHERE id = 'm'").run();
      expect(db.prepare('SELECT COUNT(*) AS n FROM mission_resources').get()).toEqual({ n: 0 });
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM mission_connections WHERE mission_id = 'm'").get(),
      ).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});
