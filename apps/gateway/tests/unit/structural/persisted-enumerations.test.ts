/**
 * Structural test (spec §10): "every persisted restriction and
 * `accepted_risks` is an enumerated list, never a wildcard, never a preset
 * reference" — the part the schema itself holds, whatever the code above it
 * does.
 *
 *   - the two tables that persist an authority (`share_restrictions`, the
 *     restriction of a share; `mission_policy`, the accepted risks of a
 *     mission) store one row per risk, and their `risk_id` column refuses the
 *     empty string and any `*`;
 *   - no table of the store has a column that could hold a preset: a preset is
 *     expanded at issuance and leaves no trace but the rows it produced;
 *   - `missions.status` cannot hold `orphaned` (spec §2.3: derived, never
 *     stored): the two triggers of migration 0007 are there. That they refuse
 *     a real row is `tests/integration/store/ownership-and-orphans.test.ts`.
 *
 * The behaviour above the schema is tested where it lives: the catalog check
 * of every write (`tests/integration/store/connections-shares.test.ts`), the
 * issuance through a preset (`tests/integration/missions/mission-lifecycle.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Store } from '../../../src/server/store';
import { openTestStore } from '../../../src/server/store/testing';

interface ColumnRow {
  readonly table_name: string;
  readonly column_name: string;
}

describe('the schema persists authorities as explicit rows', () => {
  let store: Store;

  beforeEach(() => {
    store = openTestStore().store;
  });
  afterEach(() => store.close());

  const tableSql = (name: string): string =>
    store.db
      .prepare<
        [string],
        { sql: string }
      >("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name)?.sql ?? '';

  const columns = (): ColumnRow[] =>
    store.db
      .prepare<[], ColumnRow>(
        `SELECT m.name AS table_name, p.name AS column_name
         FROM sqlite_master m JOIN pragma_table_info(m.name) p
         WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'`,
      )
      .all();

  it.each(['share_restrictions', 'mission_policy'])(
    '%s: one row per risk, and the column refuses "" and any wildcard',
    (table) => {
      const sql = tableSql(table);
      expect(sql).toContain("risk_id <> ''");
      expect(sql).toContain("risk_id NOT LIKE '%*%'");
      // One risk per row: the id is part of the primary key, never a list in a cell.
      expect(sql).toMatch(/PRIMARY KEY \([^)]*risk_id[^)]*\)/);
    },
  );

  it.each([
    ['share_restrictions', '*'],
    ['share_restrictions', 'github.*'],
    ['share_restrictions', ''],
    ['mission_policy', '*'],
    ['mission_policy', 'github[*].read-code'],
    ['mission_policy', ''],
  ])('%s refuses the risk id %j at the database, behind every repository', (table, riskId) => {
    const insert =
      table === 'share_restrictions'
        ? () =>
            store.db
              .prepare('INSERT INTO share_restrictions (share_id, risk_id) VALUES (?, ?)')
              .run('no-such-share', riskId)
        : () =>
            store.db
              .prepare(
                `INSERT INTO mission_policy
                   (mission_id, risk_id, quota, rate_limit, rate_window_seconds, gate)
                 VALUES (?, ?, 1, 1, 60, 'auto')`,
              )
              .run('no-such-mission', riskId);
    expect(insert).toThrow(/CHECK constraint failed/);
  });

  it('no table has a column that could hold a preset', () => {
    const all = columns();
    expect(all.length).toBeGreaterThan(50);
    expect(
      all.filter(({ table_name, column_name }) => /preset/i.test(`${table_name}.${column_name}`)),
    ).toEqual([]);
  });

  it('`missions.status` cannot hold `orphaned`: the state is derived, never stored', () => {
    const triggers = store.db
      .prepare<[], { sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'missions'",
      )
      .all()
      .map((row) => row.sql)
      .join('\n');
    expect(triggers).toContain("'orphaned'");
    expect(triggers).toMatch(/BEFORE INSERT ON missions/i);
    expect(triggers).toMatch(/BEFORE UPDATE (?:OF status )?ON missions/i);
  });
});
