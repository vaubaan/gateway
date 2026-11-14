/**
 * Migration 0034 — who decided a resource is hidden (ADR
 * connect-driver-and-resource-curation, amendment 2026-11-14).
 *
 * Before it only the owner wrote `hidden`: a hidden row becomes the owner's choice
 * (`hidden_edited` 1), a visible one stays open to the plugin's hint.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MEMORY_PATH, openDb, type StoreDb } from '../../../src/server/store/db.ts';
import { loadMigrations, runMigrations } from '../../../src/server/store/migrate.ts';
import { ManualClock } from '../../../src/server/store/clock.ts';

const AT = '2026-11-14T08:00:00.000Z';

describe('resources hidden before migration 0034', () => {
  const clock = new ManualClock();
  let db: StoreDb;

  beforeEach(() => {
    db = openDb({ path: MEMORY_PATH });
  });
  afterEach(() => {
    db.close();
  });

  it('marks a hidden row as the owner’s choice and leaves a visible one to the hint', () => {
    const shipped = loadMigrations();
    runMigrations(
      db,
      shipped.filter((m) => m.version < 34),
      clock,
    );
    const run = (sql: string, ...params: (string | number | null)[]) =>
      db.prepare(sql).run(...params);
    run(
      "INSERT INTO users (id, subject, identity_key, email, status, created_at) VALUES ('ada', 's', 'k', 'ada@x', 'active', ?)",
      AT,
    );
    run(
      `INSERT INTO connections (id, provider, owner_kind, owner_user_id, display_name, status, created_at, updated_at)
       VALUES ('gh', 'github', 'user', 'ada', 'acme', 'active', ?, ?)`,
      AT,
      AT,
    );
    const resource = `INSERT INTO connection_resources (id, connection_id, ref, display_name, discovered_at, hidden)
       VALUES (?, 'gh', ?, ?, ?, ?)`;
    run(resource, 'r-app', 'acme/app', 'app', AT, 0);
    run(resource, 'r-old', 'acme/old', 'old', AT, 1);

    // Up to the last migration before the rename of 0036, whose names this test reads.
    runMigrations(
      db,
      shipped.filter((m) => m.version < 36),
      clock,
    );

    const rows = db
      .prepare('SELECT id, hidden, hidden_edited FROM connection_resources ORDER BY id')
      .all();
    expect(rows).toEqual([
      { id: 'r-app', hidden: 0, hidden_edited: 0 },
      { id: 'r-old', hidden: 1, hidden_edited: 1 },
    ]);
  });
});
