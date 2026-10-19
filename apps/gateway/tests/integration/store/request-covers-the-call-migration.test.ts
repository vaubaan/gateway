/**
 * Migration 0013 — one approval request covers the call (spec §3.5; ADR
 * one-approval-request-covers-the-call).
 *
 * What an earlier image wrote keeps the meaning it had: a request, open or decided, and
 * an approval, used or not, each named one risk and now list that one risk. Nothing is
 * widened by the migration, nothing is closed by it, and a claim lists nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MEMORY_PATH, openDb } from '../../../src/server/store/db.ts';
import { loadMigrations, runMigrations } from '../../../src/server/store/migrate.ts';
import { openTestStore, type TestStore } from '../../../src/server/store/testing.ts';

const AT = '2026-10-13T08:00:00.000Z';
const LATER = '2026-10-14T08:00:00.000Z';
const MERGE = 'github.merge-protected';
const ENV_RISK = 'supabase[prod].bulk-row-write';

describe('requests and approvals written before migration 0013', () => {
  let t: TestStore;

  beforeEach(() => {
    t = openTestStore();
  });
  afterEach(async () => {
    await t.store.close();
  });

  it('keep the one risk they named, in every state, and claims list none', () => {
    const db = openDb({ path: MEMORY_PATH });
    try {
      const shipped = loadMigrations();
      runMigrations(
        db,
        shipped.filter((m) => m.version < 13),
        t.clock,
      );
      db.prepare(
        "INSERT INTO users (id, subject, identity_key, email, status, created_at) VALUES ('ada', 's', 'k', 'ada@x', 'active', ?)",
      ).run(AT);
      db.prepare(
        `INSERT INTO missions (id, name, creator_user_id, status, period_anchor, created_at, updated_at)
         VALUES ('m', 'M', 'ada', 'active', ?, ?, ?)`,
      ).run(AT, AT, AT);
      const request = db.prepare(
        `INSERT INTO requests (id, mission_id, kind, state, risk_id, tool, fingerprint, created_at, expires_at)
         VALUES (?, 'm', ?, ?, ?, ?, ?, ?, ?)`,
      );
      request.run('open-approval', 'approval', 'open', MERGE, 'github__merge', 'fp-1', AT, LATER);
      request.run(
        'granted-approval',
        'approval',
        'granted',
        ENV_RISK,
        'sb__migrate',
        'fp-2',
        AT,
        LATER,
      );
      request.run(
        'refused-approval',
        'approval',
        'refused',
        MERGE,
        'github__merge',
        'fp-3',
        AT,
        LATER,
      );
      request.run('open-claim', 'claim', 'open', MERGE, null, null, AT, LATER);
      db.prepare(
        `INSERT INTO approvals (id, mission_id, request_id, risk_id, tool, fingerprint, created_at, expires_at)
         VALUES ('usable', 'm', 'granted-approval', ?, 'sb__migrate', 'fp-2', ?, ?)`,
      ).run(ENV_RISK, AT, LATER);

      runMigrations(db, shipped, t.clock);

      expect(
        db.prepare('SELECT id, state, risk_id, risk_ids_json FROM requests ORDER BY id').all(),
      ).toEqual([
        {
          id: 'granted-approval',
          state: 'granted',
          risk_id: ENV_RISK,
          risk_ids_json: JSON.stringify([ENV_RISK]),
        },
        {
          id: 'open-approval',
          state: 'open',
          risk_id: MERGE,
          risk_ids_json: JSON.stringify([MERGE]),
        },
        { id: 'open-claim', state: 'open', risk_id: MERGE, risk_ids_json: null },
        {
          id: 'refused-approval',
          state: 'refused',
          risk_id: MERGE,
          risk_ids_json: JSON.stringify([MERGE]),
        },
      ]);
      expect(
        db.prepare('SELECT id, risk_id, risk_ids_json, consumed_at FROM approvals').all(),
      ).toEqual([
        {
          id: 'usable',
          risk_id: ENV_RISK,
          risk_ids_json: JSON.stringify([ENV_RISK]),
          consumed_at: null,
        },
      ]);
      // What the backfill wrote is JSON a reader parses back to the same risk: the
      // brackets of an environment-qualified id need no escaping.
      for (const row of db
        .prepare<[], { risk_id: string; risk_ids_json: string }>(
          'SELECT risk_id, risk_ids_json FROM requests WHERE risk_ids_json IS NOT NULL',
        )
        .all()) {
        expect(JSON.parse(row.risk_ids_json)).toEqual([row.risk_id]);
      }
      const index = db
        .prepare<[], { sql: string }>(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'approvals_lookup'",
        )
        .get();
      expect(index?.sql).toContain('(mission_id, tool, fingerprint)');
    } finally {
      db.close();
    }
  });
});
