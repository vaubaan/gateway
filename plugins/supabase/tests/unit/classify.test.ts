/**
 * Security suite of the Supabase classifier, `classifySupabase(tool, args, resources)`
 * ("a classification error is a security hole").
 *
 * Coverage : ~25 tests, 4 planes × ~6 tools. Verifies :
 *   - Slice path shape (entity chain matches the data-model).
 *   - Cardinality marker emission (`row[one]` vs `row[bulk]`, `user[one]`
 *     vs `user[bulk]`, `object[one]` vs `object[bulk]`).
 *   - `execute_sql` is strictly R-only (spec §7.2 #2).
 *   - `apply_migration` : one slice per write class the SQL was recognised
 *     to take, and every write class when a statement is not recognised
 *     (dynamic SQL, CTE, function body, unknown command…).
 *   - Strict-fail for unknown tools / unresolved project_ref, including a
 *     non-string `project_ref` and the retired `projectRef` alias.
 */

import { describe, expect, test } from 'vitest';

import { parseSlice, serializeSlice } from '@vaubaan/policy-engine';
import type { Resource } from '@vaubaan/plugin-sdk';

import { classifySupabase } from '../../src/classify.ts';

// ── fixtures ────────────────────────────────────────────────────────────

const STAGING_REF = 'tlqgxnezmthbpzhdwxgi';
const PROD_REF = 'prodxxxxxxxxxxxxxxxx';

function mkResource(ref: string, env: string): Resource {
  return { provider: 'supabase', ref, env, displayName: ref };
}

const staging = mkResource(STAGING_REF, 'staging');
const prod = mkResource(PROD_REF, 'prod');

/** Helper : run the classifier and return the serialized slice strings. */
function classifySerialized(
  tool: string,
  args: Record<string, unknown>,
  resources: readonly Resource[] = [staging],
): string[] | string {
  const r = classifySupabase(tool, args, resources);
  if ('denied' in r) return r.denied;
  return r.slices.map(serializeSlice);
}

// ────────────────────────────────────────────────────────────────────────
// Plane `db`
// ────────────────────────────────────────────────────────────────────────

describe('classifySupabase — plane db', () => {
  test('get_project → project-settings.R', () => {
    expect(classifySerialized('supabase__get_project', { project_ref: STAGING_REF })).toEqual([
      `supabase.project[${STAGING_REF}].project-settings.R`,
    ]);
  });

  test('list_tables → schema[any].table[any].R', () => {
    expect(classifySerialized('supabase__list_tables', { project_ref: STAGING_REF })).toEqual([
      `supabase.project[${STAGING_REF}].schema[any].table[any].R`,
    ]);
  });

  test('list_migrations → migration[any].R', () => {
    expect(classifySerialized('supabase__list_migrations', { project_ref: STAGING_REF })).toEqual([
      `supabase.project[${STAGING_REF}].migration[any].R`,
    ]);
  });

  test('execute_sql is strictly R-only (spec §7.2 #2)', () => {
    // even with a query that looks mutating, the classifier emits R
    expect(
      classifySerialized('supabase__execute_sql', {
        project_ref: STAGING_REF,
        query: "INSERT INTO users(name) VALUES ('a');",
      }),
    ).toEqual([`supabase.project[${STAGING_REF}].schema[any].row[bulk].R`]);

    // pure SELECT also produces the same R slice
    expect(
      classifySerialized('supabase__execute_sql', {
        project_ref: STAGING_REF,
        query: 'SELECT * FROM users;',
      }),
    ).toEqual([`supabase.project[${STAGING_REF}].schema[any].row[bulk].R`]);
  });

  test('apply_migration with pure DDL → schema/table.W only', () => {
    expect(
      classifySerialized('supabase__apply_migration', {
        project_ref: STAGING_REF,
        name: 'add_email',
        query: 'ALTER TABLE users ADD COLUMN email text;',
      }),
    ).toEqual([`supabase.project[${STAGING_REF}].schema[any].table[any].W`]);
  });

  test('apply_migration with embedded DML → emits row[bulk].W too', () => {
    expect(
      classifySerialized('supabase__apply_migration', {
        project_ref: STAGING_REF,
        name: 'backfill_email',
        query:
          "ALTER TABLE users ADD COLUMN email text; UPDATE users SET email = '' WHERE email IS NULL;",
      }),
    ).toEqual([
      `supabase.project[${STAGING_REF}].schema[any].table[any].W`,
      `supabase.project[${STAGING_REF}].schema[any].table[any].row[bulk].W`,
    ]);
  });

  test('apply_migration with CREATE POLICY → emits policy[any].W too', () => {
    expect(
      classifySerialized('supabase__apply_migration', {
        project_ref: STAGING_REF,
        name: 'enforce_rls',
        query:
          'CREATE POLICY tenant_isolation ON users FOR SELECT USING (org_id = current_user_org_id());',
      }),
    ).toEqual([
      `supabase.project[${STAGING_REF}].schema[any].table[any].W`,
      `supabase.project[${STAGING_REF}].policy[any].W`,
    ]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// apply_migration — the SQL reading fails closed
// ────────────────────────────────────────────────────────────────────────

describe('classifySupabase — apply_migration SQL reading', () => {
  const base = `supabase.project[${STAGING_REF}]`;
  const SCHEMA = `${base}.schema[any].table[any].W`;
  const BULK = `${base}.schema[any].table[any].row[bulk].W`;
  const POLICY = `${base}.policy[any].W`;
  const ROLE = `${base}.db-role[any].W`;
  const EXTENSION = `${base}.extension[any].W`;
  const EVERY_CLASS = [SCHEMA, BULK, POLICY, ROLE, EXTENSION];

  const migrate = (query: unknown) =>
    classifySerialized('supabase__apply_migration', { project_ref: STAGING_REF, name: 'm', query });

  test.each<[string, string]>([
    [
      'create table',
      'create table if not exists public.todo (id bigint primary key, done boolean default false);',
    ],
    [
      'foreign key actions are not DML',
      'CREATE TABLE profiles (id uuid references auth.users (id) on delete cascade on update cascade);',
    ],
    ['add column', 'ALTER TABLE users ADD COLUMN email text, ALTER COLUMN name SET NOT NULL;'],
    [
      'identity and generated columns',
      'create table public.t (id bigint generated by default as identity primary key, a int, b int generated always as (a * 2) stored, at timestamp with time zone default now());',
    ],
    [
      'a table with options',
      'create table app.events (id int, at date) partition by range (at) with (fillfactor = 70);',
    ],
    [
      'index',
      'create unique index concurrently if not exists ix on public.t using btree (a, lower(b)) where a is not null;',
    ],
    ['drop index, drop constraint', 'drop index if exists ix; alter table t drop constraint t_fk;'],
    [
      'comments and strings are not SQL',
      "-- delete from users\n/* grant all /* nested */ drop table x */\ncomment on table t is 'delete; grant; do it';",
    ],
    [
      'a quoted identifier is not a keyword',
      'alter table t add column "delete" int, add column "policy" text;',
    ],
    [
      'schema, sequence, enum, transaction markers',
      "begin; create schema if not exists app; create sequence app.s; create type app.mood as enum ('a', 'b'); commit;",
    ],
  ])('plain DDL stays on the schema write : %s', (_label, query) => {
    expect(migrate(query)).toEqual([SCHEMA]);
  });

  test.each<[string, string]>([
    [
      'update',
      "alter table users add column email text; UPDATE users SET email = '' WHERE email IS NULL;",
    ],
    ['insert … select', 'insert into public.t (a) select a from public.u;'],
    [
      'upsert',
      'insert into t (id, a) values (1, 2) on conflict (id) do update set a = excluded.a;',
    ],
    ['delete', 'delete from only public.t where id = 1;'],
    ['truncate', 'TRUNCATE TABLE public.t, public.u;'],
    ['drop table', 'drop table users cascade;'],
    ['drop column', 'alter table users drop column email;'],
    ['add and drop in one statement', 'alter table t add column a int default 0, drop b;'],
    ['update with a sub-select', 'UPDATE t SET a = 1 WHERE b IN (SELECT b FROM u FOR UPDATE);'],
    ['a comment between the keywords', 'delete/**/from/* x */public.t;'],
  ])('row-destroying or DML statements add the bulk row write : %s', (_label, query) => {
    expect(migrate(query)).toEqual([SCHEMA, BULK]);
  });

  test.each<[string, string]>([
    [
      'create policy',
      'CREATE POLICY tenant_isolation ON users FOR SELECT USING (org_id = current_user_org_id());',
    ],
    [
      'policy with a subquery, on a managed table',
      'create policy "members read" on storage.objects for select to authenticated using (exists (select 1 from public.members m where m.user_id = auth.uid()));',
    ],
    ['enable RLS', 'alter table public.t enable row level security;'],
    ['disable RLS on a managed table', 'ALTER TABLE auth.users DISABLE ROW LEVEL SECURITY;'],
    [
      'a comment between the keywords',
      'drop/**/policy if exists p on t; create--x\npolicy p on t using (true);',
    ],
  ])('RLS statements add the policy write : %s', (_label, query) => {
    expect(migrate(query)).toEqual([SCHEMA, POLICY]);
  });

  test.each<[string, string]>([
    ['grant', 'grant all on all tables in schema public to anon;'],
    ['revoke', 'REVOKE select ON t FROM authenticated;'],
    ['create role', "create role reporter with login password 'x';"],
    ['alter role', 'alter role anon set statement_timeout = 0;'],
    [
      'default privileges',
      'alter default privileges in schema public grant select on tables to anon;',
    ],
  ])('privilege statements add the role write : %s', (_label, query) => {
    expect(migrate(query)).toEqual([SCHEMA, ROLE]);
  });

  test('extension statements add the extension write', () => {
    expect(migrate('create extension if not exists pg_net with schema extensions;')).toEqual([
      SCHEMA,
      EXTENSION,
    ]);
  });

  test('the classes of every statement add up', () => {
    expect(
      migrate(
        'create table t (id int); alter table t enable row level security; create policy p on t using (true); grant select on t to anon; insert into t values (1);',
      ),
    ).toEqual([SCHEMA, BULK, POLICY, ROLE]);
  });

  test.each<[string, string]>([
    ['dynamic SQL in a DO block', "DO $$ BEGIN EXECUTE 'DEL' || 'ETE FROM auth.users'; END $$;"],
    [
      'a function body',
      "create function f() returns void language sql as 'delete from auth.users';",
    ],
    [
      'a dollar-quoted function body',
      'create or replace function f() returns trigger language plpgsql as $fn$ begin return new; end $fn$;',
    ],
    [
      'a data-modifying CTE',
      'with gone as (delete from auth.users returning *) select count(*) from gone;',
    ],
    [
      'a bare select calling a function',
      "select cron.schedule('x', '* * * * *', 'delete from public.t');",
    ],
    [
      'a DML nested inside an insert',
      'insert into public.t with gone as (delete from public.u returning *) select * from gone;',
    ],
    ['create table as', 'create table copy as select * from auth.users;'],
    ['DML on a managed schema', "update auth.users set email = 'a@b.c';"],
    ['a quoted managed schema', 'delete from "auth"."users";'],
    ['truncate reaching a managed schema', 'truncate public.t, storage.objects;'],
    ['DDL on a managed schema', 'alter table auth.users add column backdoor text;'],
    ['a view', 'create view public.v as select * from auth.users;'],
    ['a trigger', 'create trigger tg after insert on t for each row execute function f();'],
    ['a rule', 'create rule r as on delete to t do instead nothing;'],
    ['copy from program', "copy t from program 'curl evil';"],
    ['a session setting', 'set search_path = auth; delete from users;'],
    ['a prepared statement', 'prepare p as delete from t; execute p;'],
    ['an ownership change', 'alter table t owner to anon;'],
    ['an escape string', "comment on table t is E'a\\'; drop table x; --';"],
    ['a backslash in a plain string', "comment on table t is 'a\\'; delete from t; --';"],
    ['a unicode-escaped identifier', 'delete from U&"\\0061uth".users;'],
    ['an unterminated string', "comment on table t is 'oops;"],
    ['an unterminated comment', 'create table t (id int); /* drop table x;'],
    ['an unknown command', 'vacuum full;'],
    ['a merge', 'merge into t using s on t.id = s.id when matched then delete;'],
    ['a partition of another table', 'create table p partition of auth.audit default;'],
    ['a table created inside a managed schema', 'create table auth.shadow (id int);'],
    ['schema elements', 'create schema app create table t (id int) grant all on t to anon;'],
    ['a default with a sub-select', 'alter table t add column c int default (select 1);'],
    ['a trigger switch', 'alter table t disable trigger all;'],
    ['a no-break space between keywords', 'delete\u00a0from auth.users;'],
    ['a positional parameter', 'delete from t where id = $1;'],
    ['drop schema', 'drop schema app cascade;'],
    ['a NUL byte', 'create table t (id int);\u0000delete from t;'],
  ])('a statement that is not recognised requires every write class : %s', (_label, query) => {
    expect(migrate(query)).toEqual(EVERY_CLASS);
  });

  test('one unrecognised statement is enough, wherever it sits', () => {
    expect(migrate('create table t (id int); do $$ begin null; end $$;')).toEqual(EVERY_CLASS);
  });

  test('a comment-only migration is a schema write', () => {
    expect(migrate('-- nothing yet\n')).toEqual([SCHEMA]);
    expect(migrate('-- nothing yet')).toEqual([SCHEMA]);
    expect(migrate('-- nothing yet\r')).toEqual([SCHEMA]);
  });

  // PostgreSQL ends a `--` comment at a line feed OR a carriage return (scan.l:
  // `non_newline [^\n\r]`). A reader that waits for `\n` alone never sees what follows a
  // bare `\r`, and the server runs it.
  test.each<[string, string]>([
    ['a bare carriage return', '--\r'],
    ['text, then a carriage return', '-- harmless note\r'],
    ['CR LF', '--\r\n'],
    ['a line feed', '--\n'],
    ['a carriage return after a first full comment line', '-- a\n-- b\r'],
  ])('what follows a line comment ended by %s is read', (_label, comment) => {
    expect(
      migrate(
        `create table public.a (id int); ${comment}drop table public.orders; alter role anon superuser;`,
      ),
    ).toEqual([SCHEMA, BULK, ROLE]);
    expect(migrate(`create table public.a (id int); ${comment}do $$ begin null; end $$;`)).toEqual(
      EVERY_CLASS,
    );
  });

  test('a carriage return inside a block comment or a string hides nothing either', () => {
    expect(migrate('/* --\r */ delete from public.t;')).toEqual([SCHEMA, BULK]);
    expect(migrate("comment on table t is '--\r'; delete from public.t;")).toEqual([SCHEMA, BULK]);
  });

  // `ALTER COLUMN … TYPE … [USING expr]` rewrites the column in every row: with a
  // `USING` expression it overwrites the values, exactly what `DROP COLUMN` is priced for.
  test.each<[string, string]>([
    ['type … using a constant', "alter table public.users alter column email type text using 'x';"],
    ['type … using an expression', 'alter table t alter column n type int using n::int / 0;'],
    ['a plain type change', 'alter table t alter column n type bigint;'],
    ['set data type', 'alter table t alter n set data type text;'],
    ['among other actions', 'alter table t add column a int, alter column n type text using null;'],
    ['a quoted column', 'alter table t alter column "type" type text;'],
  ])('a column type change adds the bulk row write : %s', (_label, query) => {
    expect(migrate(query)).toEqual([SCHEMA, BULK]);
  });

  test.each<[string, string]>([
    ['a column named like the keyword, quoted', 'alter table t alter column "type" set not null;'],
    ['set default', 'alter table t alter column n set default 0;'],
    ['drop not null', 'alter table t alter column n drop not null;'],
    ['rename', 'alter table t rename column n to m;'],
    ['a new column of some type', 'alter table t add column kind text;'],
  ])('other column alterations stay on the schema write : %s', (_label, query) => {
    expect(migrate(query)).toEqual([SCHEMA]);
  });

  test.each<[string, unknown]>([
    ['absent', undefined],
    ['empty', '   '],
    ['an array', ['create table t (id int);']],
    ['an object', { toString: () => 'create table t (id int);' }],
    ['a number', 42],
  ])('a query that is %s is refused', (_label, query) => {
    expect(migrate(query)).toBe('query: missing or malformed.');
  });

  test('execute_sql refuses a non-string query too', () => {
    for (const query of [undefined, '', ['select 1'], 7]) {
      expect(classifySerialized('supabase__execute_sql', { project_ref: STAGING_REF, query })).toBe(
        'query: missing or malformed.',
      );
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// Plane `storage`
// ────────────────────────────────────────────────────────────────────────

describe('classifySupabase — plane storage', () => {
  test('list_buckets → bucket[any].R', () => {
    expect(classifySerialized('supabase__list_buckets', { project_ref: STAGING_REF })).toEqual([
      `supabase.project[${STAGING_REF}].bucket[any].R`,
    ]);
  });

  test('create_bucket emits bucket[<id>].W', () => {
    expect(
      classifySerialized('supabase__create_bucket', {
        project_ref: STAGING_REF,
        id: 'avatars',
        name: 'Avatars',
      }),
    ).toEqual([`supabase.project[${STAGING_REF}].bucket[avatars].W`]);
  });

  test('delete_bucket emits bucket.W + cascade object[bulk].W', () => {
    expect(
      classifySerialized('supabase__delete_bucket', {
        project_ref: STAGING_REF,
        id: 'uploads',
      }),
    ).toEqual([
      `supabase.project[${STAGING_REF}].bucket[uploads].W`,
      `supabase.project[${STAGING_REF}].bucket[uploads].object[bulk].W`,
    ]);
  });

  test('upload_object emits the object[one] cardinality marker alone', () => {
    expect(
      classifySerialized('supabase__upload_object', {
        project_ref: STAGING_REF,
        bucket: 'avatars',
        path: 'u/123.png',
        content_base64: 'AAAA',
      }),
    ).toEqual([`supabase.project[${STAGING_REF}].bucket[avatars].object[one].W`]);
  });

  test('delete_object emits the object[one] marker alone ; the path is validated, not a segment', () => {
    expect(
      classifySerialized('supabase__delete_object', {
        project_ref: STAGING_REF,
        bucket: 'avatars',
        path: 'bulk',
      }),
    ).toEqual([`supabase.project[${STAGING_REF}].bucket[avatars].object[one].W`]);
    expect(
      classifySerialized('supabase__delete_object', {
        project_ref: STAGING_REF,
        bucket: 'avatars',
        path: 'a b[*]',
      }),
    ).toBe('path: missing or malformed.');
  });

  test('create_signed_url emits object[<path>].signed-url[any].R', () => {
    expect(
      classifySerialized('supabase__create_signed_url', {
        project_ref: STAGING_REF,
        bucket: 'avatars',
        path: 'u/123.png',
      }),
    ).toEqual([
      `supabase.project[${STAGING_REF}].bucket[avatars].object[u/123.png].signed-url[any].R`,
    ]);
  });

  test('update_storage_config → storage-config.W', () => {
    expect(
      classifySerialized('supabase__update_storage_config', { project_ref: STAGING_REF }),
    ).toEqual([`supabase.project[${STAGING_REF}].storage-config.W`]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Plane `auth`
// ────────────────────────────────────────────────────────────────────────

describe('classifySupabase — plane auth', () => {
  test('list_users → user[any].R', () => {
    expect(classifySerialized('supabase__list_users', { project_ref: STAGING_REF })).toEqual([
      `supabase.project[${STAGING_REF}].user[any].R`,
    ]);
  });

  test('create_user emits the user[one] cardinality marker alone', () => {
    expect(
      classifySerialized('supabase__create_user', {
        project_ref: STAGING_REF,
        email: 'alice@example.com',
      }),
    ).toEqual([`supabase.project[${STAGING_REF}].user[one].W`]);
  });

  test('delete_user emits the user[one] marker alone (single-user op)', () => {
    expect(
      classifySerialized('supabase__delete_user', {
        project_ref: STAGING_REF,
        user_id: 'uuid-1',
      }),
    ).toEqual([`supabase.project[${STAGING_REF}].user[one].W`]);
  });

  test('a user id spelled like a cardinality marker stays a single-user write', () => {
    for (const user_id of ['bulk', 'any', 'one']) {
      expect(
        classifySerialized('supabase__update_user', { project_ref: STAGING_REF, user_id }),
      ).toEqual([`supabase.project[${STAGING_REF}].user[one].W`]);
    }
    expect(
      classifySerialized('supabase__update_user', { project_ref: STAGING_REF, user_id: ['u1'] }),
    ).toBe('user_id: missing or malformed.');
  });

  test('generate_link → user[<target>].link[<type>].W', () => {
    expect(
      classifySerialized('supabase__generate_link', {
        project_ref: STAGING_REF,
        email: 'bob@example.com',
        type: 'magiclink',
      }),
    ).toEqual([`supabase.project[${STAGING_REF}].user[*].link[magiclink].W`]);
  });

  // The slice grammar has no `@`, `+` or `:` : an identifier holding one is emitted as
  // "any identifier", so the slice the audit stores can be read back as itself.
  test.each<[string, string, Record<string, unknown>]>([
    [
      'an e-mail address',
      'supabase__generate_link',
      { email: 'bob+ci@example.com', type: 'magiclink' },
    ],
    ['a bucket id with `@` and `:`', 'supabase__delete_bucket', { id: 'team@acme:assets' }],
    ['a bucket id with `+`', 'supabase__list_objects', { bucket: 'a+b' }],
    [
      'a secret name with `:`',
      'supabase__delete_function_secrets',
      { names: ['STRIPE:KEY', 'OK_KEY'] },
    ],
    [
      'a secret name with `@`',
      'supabase__create_function_secrets',
      { secrets: [{ name: 'A@B', value: 'v' }] },
    ],
  ])(
    '%s is not written into the slice, and every slice reads back as itself',
    (_label, tool, args) => {
      const out = classifySupabase(tool, { project_ref: STAGING_REF, ...args }, [staging]);
      if (!('slices' in out)) throw new Error(`unexpected denial: ${out.denied}`);
      expect(out.slices.length).toBeGreaterThan(0);
      for (const slice of out.slices) {
        const text = serializeSlice(slice);
        expect(text).not.toMatch(/[@+:]/);
        expect(serializeSlice(parseSlice(text))).toBe(text);
      }
    },
  );

  test('an identifier the grammar can carry is still written as given', () => {
    expect(
      classifySerialized('supabase__delete_function_secrets', {
        project_ref: STAGING_REF,
        names: ['STRIPE:KEY', 'OK_KEY'],
      }),
    ).toEqual([
      `supabase.project[${STAGING_REF}].function-secret[*].W`,
      `supabase.project[${STAGING_REF}].function-secret[OK_KEY].W`,
    ]);
    expect(
      classifySerialized('supabase__delete_bucket', {
        project_ref: STAGING_REF,
        id: 'my.bucket-1',
      }),
    ).toContain(`supabase.project[${STAGING_REF}].bucket[my.bucket-1].W`);
  });

  test('update_auth_config → auth-config.W', () => {
    expect(
      classifySerialized('supabase__update_auth_config', {
        project_ref: STAGING_REF,
        config: { site_url: 'https://app.example.com' },
      }),
    ).toEqual([`supabase.project[${STAGING_REF}].auth-config.W`]);
  });

  test('create_sso_provider → sso-provider[<type>].W', () => {
    expect(
      classifySerialized('supabase__create_sso_provider', {
        project_ref: STAGING_REF,
        type: 'saml',
        metadata_url: 'https://idp.example.com/saml',
      }),
    ).toEqual([`supabase.project[${STAGING_REF}].sso-provider[saml].W`]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Plane `functions`
// ────────────────────────────────────────────────────────────────────────

describe('classifySupabase — plane functions', () => {
  test('list_functions → edge-function[any].R', () => {
    expect(classifySerialized('supabase__list_functions', { project_ref: STAGING_REF })).toEqual([
      `supabase.project[${STAGING_REF}].edge-function[any].R`,
    ]);
  });

  test('get_function_body → function-body.R + edge-function[*].R', () => {
    expect(
      classifySerialized('supabase__get_function_body', {
        project_ref: STAGING_REF,
        function_slug: 'webhook',
      }),
    ).toEqual([
      `supabase.project[${STAGING_REF}].edge-function[webhook].function-body.R`,
      `supabase.project[${STAGING_REF}].edge-function[webhook].R`,
    ]);
  });

  test('create_function → edge-function[<slug>].W', () => {
    expect(
      classifySerialized('supabase__create_function', {
        project_ref: STAGING_REF,
        slug: 'webhook',
        body: 'export default () => new Response("ok")',
      }),
    ).toEqual([`supabase.project[${STAGING_REF}].edge-function[webhook].W`]);
  });

  test('deploy_function with files → function-deployment.W + edge-function.W', () => {
    expect(
      classifySerialized('supabase__deploy_function', {
        project_ref: STAGING_REF,
        slug: 'webhook',
        entrypoint_path: 'index.ts',
        files: [{ name: 'index.ts', content: 'export default () => 1' }],
      }),
    ).toEqual([
      `supabase.project[${STAGING_REF}].edge-function[webhook].function-deployment[any].W`,
      `supabase.project[${STAGING_REF}].edge-function[webhook].W`,
    ]);
  });

  test('deploy_function without files is still a body write : it changes what runs and how it is exposed', () => {
    const both = [
      `supabase.project[${STAGING_REF}].edge-function[webhook].function-deployment[any].W`,
      `supabase.project[${STAGING_REF}].edge-function[webhook].W`,
    ];
    for (const extra of [
      { files: [] },
      {},
      { verify_jwt: false },
      { entrypoint_path: 'other.ts', import_map_path: 'map.json' },
    ]) {
      expect(
        classifySerialized('supabase__deploy_function', {
          project_ref: STAGING_REF,
          slug: 'webhook',
          entrypoint_path: 'index.ts',
          ...extra,
        }),
        JSON.stringify(extra),
      ).toEqual(both);
    }
  });

  test('deploy_function refuses `files` in another shape, and an argument its schema does not declare', () => {
    const deploy = (extra: Record<string, unknown>) =>
      classifySerialized('supabase__deploy_function', {
        project_ref: STAGING_REF,
        slug: 'webhook',
        ...extra,
      });
    expect(deploy({ files: { 0: { name: 'index.ts', content: 'x' } } })).toBe(
      'files: missing or malformed.',
    );
    expect(deploy({ files: 'index.ts' })).toBe('files: missing or malformed.');
    expect(deploy({ bundle: [{ name: 'index.ts', content: 'x' }] })).toBe(
      "bundle: not an argument of 'supabase__deploy_function' — nothing classifies it, so it is not sent.",
    );
  });

  test('create_function_secrets → function-secret[<name>].W per secret', () => {
    expect(
      classifySerialized('supabase__create_function_secrets', {
        project_ref: STAGING_REF,
        secrets: [
          { name: 'STRIPE_KEY', value: 'sk_…' },
          { name: 'OPENAI_KEY', value: 'sk-…' },
        ],
      }),
    ).toEqual([
      `supabase.project[${STAGING_REF}].function-secret[STRIPE_KEY].W`,
      `supabase.project[${STAGING_REF}].function-secret[OPENAI_KEY].W`,
    ]);
  });

  test('delete_function_secrets → function-secret[<name>].W per name', () => {
    expect(
      classifySerialized('supabase__delete_function_secrets', {
        project_ref: STAGING_REF,
        names: ['OBSOLETE_KEY'],
      }),
    ).toEqual([`supabase.project[${STAGING_REF}].function-secret[OBSOLETE_KEY].W`]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Strict-fail behavior
// ────────────────────────────────────────────────────────────────────────

describe('classifySupabase — strict-fail', () => {
  test('unknown tool → denied', () => {
    const r = classifySupabase('supabase__nope_not_a_tool', { project_ref: STAGING_REF }, [
      staging,
    ]);
    expect(r).toEqual({ denied: "unknown supabase tool 'supabase__nope_not_a_tool'." });
  });

  test('project_ref outside the mission resources → denied', () => {
    const r = classifySupabase('supabase__get_project', { project_ref: 'rogue-ref' }, [staging]);
    expect(r).toEqual({
      denied: "supabase project 'rogue-ref' is not a resource of this mission.",
    });
  });

  test('several resources without explicit project_ref → denied', () => {
    const r = classifySupabase('supabase__get_project', {}, [staging, prod]);
    expect(r).toEqual({ denied: 'ambiguous supabase target: specify project_ref.' });
  });

  test('single resource without project_ref → resolves from the resource', () => {
    expect(classifySerialized('supabase__get_project', {}, [staging])).toEqual([
      `supabase.project[${STAGING_REF}].project-settings.R`,
    ]);
  });

  test('a non-string project_ref is refused, whatever else the call carries', () => {
    const denied = { denied: 'project_ref: missing or malformed.' };
    for (const project_ref of [['victimprojectref'], { ref: 'victim' }, 42, null, true, '']) {
      expect(
        classifySupabase(
          'supabase__apply_migration',
          { project_ref, name: 'm', query: 'create table t (id int);' },
          [staging],
        ),
      ).toEqual(denied);
      expect(
        classifySupabase('supabase__delete_user', { project_ref, user_id: 'u1' }, [staging]),
      ).toEqual(denied);
    }
  });

  test('the projectRef alias is refused : the project is named by project_ref only', () => {
    const denied = { denied: 'projectRef: unknown argument, name the project with project_ref.' };
    expect(
      classifySupabase('supabase__get_project', { projectRef: STAGING_REF }, [staging]),
    ).toEqual(denied);
    expect(
      classifySupabase(
        'supabase__get_project',
        { project_ref: STAGING_REF, projectRef: PROD_REF },
        [staging, prod],
      ),
    ).toEqual(denied);
    // The audit's probe : a non-string project_ref next to the alias.
    const probe = classifySupabase(
      'supabase__apply_migration',
      {
        project_ref: ['victimprojectref'],
        projectRef: STAGING_REF,
        name: 'm',
        query: 'create table t (id int);',
      },
      [staging],
    );
    expect('denied' in probe).toBe(true);
  });

  test('a path-unsafe project ref is refused, even when a mission resource carries it', () => {
    const denied = { denied: 'project_ref: missing or malformed.' };
    for (const ref of [
      'evil.example/x',
      '../other',
      'a/b',
      'ref?x=1',
      'ref#frag',
      'ref@host',
      'a:b',
    ]) {
      const resource = mkResource(ref, 'staging');
      expect(classifySupabase('supabase__get_project', { project_ref: ref }, [resource])).toEqual(
        denied,
      );
      expect(classifySupabase('supabase__get_project', {}, [resource])).toEqual(denied);
    }
  });
});
