/**
 * `readQuerySql` — the reader of `supabase__execute_sql`.
 *
 * It answers one question : does the query touch
 * `supabase.read-managed-schemas` ? It is an allow-list, so the adversarial
 * table matters more than the friendly one : every way of reading `auth`
 * without spelling `auth.` must land on `unread`.
 */
import { describe, expect, test } from 'vitest';

import {
  SUPABASE_MANAGED_SCHEMAS,
  SUPABASE_SENSITIVE_CATALOG_RELATIONS,
  isManagedSchema,
  isSensitiveSchema,
} from '../../src/data-model.ts';
import { readQuerySql } from '../../src/query-sql.ts';

describe('readQuerySql — plain application reads', () => {
  test.each([
    'select 1',
    'SELECT * FROM users;',
    'select id, title from public.todo where done order by id limit 10',
    'select t.id, count(*) from public.todo t join public.owner o on (o.id = t.owner_id) group by t.id',
    "select lower(email), date_trunc('day', created_at) from app.customers where name ilike 'a%'",
    'with recent as (select * from orders where created_at > now()) select count(*) from recent',
    'with recent as materialized (select 1) select * from recent',
    "select coalesce(a, 'x'), nullif(b, 0), cast(c as text), extract(year from d) from t",
    'select pg_catalog.lower(name) from t',
    'select x from t where id in (select id from u) and not exists (select 1 from v)',
    'select row_number() over (partition by a order by b) from t',
    "select data->>'k', jsonb_array_length(data) from t",
    'select * from generate_series(1, 10)',
    'values (1), (2)',
    'table public.todo',
    'explain (analyze, buffers) select * from t',
    'show server_version',
    'select table_name from information_schema.tables',
    'select c.relname from pg_catalog.pg_class c',
    'select pg_class.relname from pg_class',
    'select * from extensions.something',
    'select 1; select 2;',
    "select 'auth.users' as label, 'select * from vault.secrets' as text from t",
    'select auth, storage, vault from t',
    'select 1 -- from auth.users',
    'select 1 /* auth.users */',
    'select "Name" from "My Table"',
  ])('%s', (query) => {
    expect(readQuerySql(query)).toEqual({ managed: false, reason: null });
  });
});

describe('readQuerySql — a managed schema is named', () => {
  test.each([
    'select * from auth.users',
    'SELECT email FROM AUTH.USERS',
    'select * from "auth"."users"',
    'select * from "AUTH".users',
    'select * from auth . users',
    'select * from auth/* x */.users',
    'select * from auth--\n.users',
    'select * from postgres.auth.users',
    'select * from auth.sessions s join auth.refresh_tokens r on (r.session_id = s.id)',
    'select * from vault.secrets',
    'select * from vault.decrypted_secrets',
    'select name from storage.objects',
    'select * from pgsodium.key',
    'select * from pgsodium_masks.x',
    'select * from net._http_response',
    'select * from cron.job',
    'select * from realtime.messages',
    'select * from pgbouncer.get_auth',
    'select * from supabase_functions.hooks',
    'select statements from supabase_migrations.schema_migrations',
    'select * from _realtime.tenants',
    'select * from pg_toast.pg_toast_16385',
    'select * from pg_temp_3.t',
    'table auth.users',
    'explain select * from auth.users',
    'with u as (select * from auth.users) select count(*) from u',
    'select (select count(*) from auth.users) from t',
    'select * from t where id in (select user_id from auth.identities)',
    'select 1; select * from auth.users',
    'select auth.uid()',
    // catalog relations that hold secrets or other sessions' queries
    'select rolname, rolpassword from pg_authid',
    'select * from pg_catalog.pg_shadow',
    'select query from pg_stat_activity',
    'select query from extensions.pg_stat_statements',
    'select * from pg_stats',
    'select * from "pg_settings"',
    'select * from pg_user_mappings',
    'select * from pg_largeobject',
  ])('%s', (query) => {
    expect(readQuerySql(query)).toEqual({ managed: true, reason: 'names-managed-schema' });
  });
});

describe('readQuerySql — unread : the managed risk is required (fail closed)', () => {
  test.each([
    // nothing to read
    ['', 'empty'],
    ['-- only a comment', 'comment only'],
    [';;', 'no statement'],
    // names resolved another way
    ['set search_path to x; select * from users', 'SET changes how names resolve'],
    ["select set_config('search_path', 'x', false)", 'set_config'],
    ["select current_setting('app.secret')", 'current_setting'],
    ['reset all', 'RESET'],
    // SQL held in a string
    ["select query_to_xml('select * from a' || 'uth.users', true, true, '')", 'query_to_xml'],
    ["select table_to_xml(('a' || 'uth.users')::regclass, true, true, '')", 'table_to_xml'],
    ["select * from dblink('dbname=postgres', 'select 1') as t(a int)", 'dblink'],
    ["select ts_stat('select 1')", 'ts_stat'],
    ["select * from crosstab('select 1')", 'an extension function'],
    ["do $$ begin execute 'select 1'; end $$", 'DO block'],
    ['prepare p as select 1; execute p', 'PREPARE'],
    ['call something()', 'CALL'],
    // functions the reader does not know
    ['select public.my_report()', 'a function of the application'],
    ['select my_report()', 'an unqualified unknown function'],
    ['select extensions.lower(name) from t', 'a known name under another schema'],
    ['select "lower"(name) from t', 'a quoted function name'],
    ['select x.lower(name) from t', 'a qualified function'],
    ["select pg_read_file('/etc/passwd')", 'server file'],
    ['select lo_get(1)', 'large object'],
    ['select pg_sleep(10)', 'pg_sleep'],
    ["select nextval('s')", 'nextval'],
    ["select pg_get_functiondef('f'::regproc)", 'definition readers'],
    // shapes the reader does not tell from a call
    ['with c (a, b) as (select 1, 2) select * from c', 'CTE column list'],
    ['select * from t as x (a, b)', 'alias column list'],
    // not a query
    ['insert into t values (1)', 'INSERT'],
    ['update t set a = 1', 'UPDATE'],
    ['delete from t', 'DELETE'],
    ['copy t to stdout', 'COPY'],
    ["copy (select 1) to program 'sh'", 'COPY … TO PROGRAM'],
    ['create temp table x as select 1', 'CREATE'],
    ['begin; select 1; commit', 'transaction control'],
    ['listen x', 'LISTEN'],
    ['(select 1)', 'a parenthesised statement'],
    // text the tokeniser refuses
    ['select $$auth.users$$', 'dollar quoting'],
    ['select $1', 'positional parameter'],
    ["select E'a\\\\b'", 'escape string'],
    ['select U&"\\0061uth".users', 'unicode-escaped identifier'],
    ["select U&'x'", 'unicode-escaped string'],
    ["select 'a\\'", 'backslash in a string'],
    ["select 'unterminated", 'unterminated string'],
    ['select "unterminated', 'unterminated identifier'],
    ['select 1 /* unterminated', 'unterminated comment'],
    ['select 1\u0000', 'control character'],
  ])('%s  (%s)', (query) => {
    expect(readQuerySql(query)).toEqual({ managed: true, reason: 'unread' });
  });

  test('a comment that ends at a carriage return does not hide what follows', () => {
    expect(readQuerySql('select 1 --\r from auth.users')).toEqual({
      managed: true,
      reason: 'names-managed-schema',
    });
  });

  test('a managed name wins over an unread statement beside it', () => {
    expect(readQuerySql('set search_path to x; select * from auth.users').reason).toBe(
      'names-managed-schema',
    );
  });

  test('never throws, whatever the text', () => {
    for (const text of ['\ud800', '((((', '....', "'", '"', '/*', '\\', 'select'.repeat(5000)]) {
      expect(() => readQuerySql(text)).not.toThrow();
    }
  });
});

describe('managed schemas — one list in the data model', () => {
  test('every listed schema is managed ; its kind says whether reading it is sensitive', () => {
    for (const schema of SUPABASE_MANAGED_SCHEMAS) {
      expect(isManagedSchema(schema.name), schema.name).toBe(true);
      expect(isSensitiveSchema(schema.name), schema.name).toBe(schema.kind === 'sensitive');
    }
  });

  test('auth, vault and storage are sensitive ; the catalogs are not', () => {
    for (const name of ['auth', 'vault', 'storage', 'pgsodium', 'net', 'cron']) {
      expect(isSensitiveSchema(name), name).toBe(true);
    }
    for (const name of ['information_schema', 'pg_catalog', 'extensions', 'graphql_public']) {
      expect(isSensitiveSchema(name), name).toBe(false);
    }
  });

  test('reserved prefixes : managed, and sensitive except a bare catalog name used as a qualifier', () => {
    for (const name of ['supabase_functions', 'supabase_migrations', '_realtime', 'pg_toast']) {
      expect(isManagedSchema(name), name).toBe(true);
      expect(isSensitiveSchema(name), name).toBe(true);
    }
    expect(isManagedSchema('pg_class')).toBe(true);
    expect(isSensitiveSchema('pg_class')).toBe(false);
    for (const name of ['public', 'app', 'analytics']) {
      expect(isManagedSchema(name), name).toBe(false);
      expect(isSensitiveSchema(name), name).toBe(false);
    }
  });

  test('the sensitive catalog relations are lowercase bare names', () => {
    for (const name of SUPABASE_SENSITIVE_CATALOG_RELATIONS) {
      expect(name).toMatch(/^pg_[a-z_]+$/);
    }
  });
});
