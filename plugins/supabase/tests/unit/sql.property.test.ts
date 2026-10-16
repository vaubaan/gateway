/**
 * Property-based tests of the SQL readers of the `supabase` plugin: the text
 * of a query or a migration comes from the agent, so the tokeniser and both
 * readers are fed generated SQL-shaped text (quotes, comments, dollar signs,
 * semicolons, managed schema names) as well as arbitrary strings.
 *
 * Properties: they never throw, and they fail closed — what follows a
 * statement boundary is never lost, so appending a statement that touches a
 * managed schema, or creates a role, can only make the reading stricter.
 * Seeded and replayable (`propertyRuns`, FC_SEED / FC_RUNS).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { propertyRuns } from '@vaubaan/plugin-sdk/testing';

import { readMigrationSql } from '../../src/migration-sql.ts';
import { readQuerySql } from '../../src/query-sql.ts';
import { tokenise } from '../../src/sql-tokens.ts';

/** Fragments that exercise every lexical state of the tokeniser. */
const FRAGMENTS = [
  'select',
  ' ',
  '\n',
  '\r',
  '\t',
  '*',
  ',',
  ';',
  '(',
  ')',
  '.',
  'from',
  'public.users',
  'auth.users',
  'vault.secrets',
  'pg_authid',
  "'",
  "''",
  '"',
  '""',
  '--',
  '/*',
  '*/',
  '$',
  '$$',
  '$tag$',
  'E',
  '\\',
  '::text',
  'now()',
  'query_to_xml(',
  'set',
  'create',
  'role',
  'policy',
  'update',
  'where',
  '1',
  'x',
  'é',
  '\u0000',
] as const;

const sqlish = fc.array(fc.constantFrom(...FRAGMENTS), { maxLength: 40 }).map((p) => p.join(''));
const anyText = fc.oneof(
  sqlish,
  fc.string({ maxLength: 200 }),
  fc.string({ unit: 'binary', maxLength: 80 }),
);

describe('SQL readers — properties', () => {
  it('the tokeniser and both readers never throw', () => {
    fc.assert(
      fc.property(anyText, (sql) => {
        tokenise(sql);
        const query = readQuerySql(sql);
        expect(typeof query.managed).toBe('boolean');
        const migration = readMigrationSql(sql);
        if (!migration.recognised) expect(migration.classes.length).toBe(4);
      }),
      propertyRuns(),
    );
  });

  it('a query followed by a read of a managed schema is never an application read', () => {
    fc.assert(
      fc.property(anyText, (prefix) => {
        // The newline ends a `--` comment, as it does for Postgres.
        const reading = readQuerySql(`${prefix}\n; select * from auth.users`);
        expect(reading.managed).toBe(true);
      }),
      propertyRuns(),
    );
  });

  it('a migration followed by CREATE ROLE always takes the role class', () => {
    fc.assert(
      fc.property(anyText, (prefix) => {
        const reading = readMigrationSql(`${prefix}\n;\ncreate role intruder`);
        expect(reading.classes).toContain('db-role');
      }),
      propertyRuns(),
    );
  });
});
