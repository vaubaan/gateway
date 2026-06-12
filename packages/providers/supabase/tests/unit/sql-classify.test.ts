import { describe, expect, test } from 'vitest';
import { classifySql } from '../../src/sql-classify.ts';

describe('classifySql — read paths', () => {
  test('SELECT → rows:read', () => {
    expect(classifySql('select 1;')).toEqual({ level: 'rows', action: 'read' });
  });
  test('WITH … SELECT → rows:read', () => {
    expect(classifySql('with t as (select 1) select * from t;')).toEqual({
      level: 'rows',
      action: 'read',
    });
  });
  test('EXPLAIN → rows:read', () => {
    expect(classifySql('explain select * from users;')).toEqual({
      level: 'rows',
      action: 'read',
    });
  });
  test('SHOW → rows:read', () => {
    expect(classifySql('show search_path;')).toEqual({ level: 'rows', action: 'read' });
  });
  test('VALUES → rows:read', () => {
    expect(classifySql('values (1), (2);')).toEqual({ level: 'rows', action: 'read' });
  });
  test('empty / whitespace / comments → rows:read', () => {
    expect(classifySql('')).toEqual({ level: 'rows', action: 'read' });
    expect(classifySql('   ;  ')).toEqual({ level: 'rows', action: 'read' });
    expect(classifySql('-- a comment\n/* block */')).toEqual({ level: 'rows', action: 'read' });
  });
});

describe('classifySql — rows writes', () => {
  test('INSERT → rows:write', () => {
    expect(classifySql("insert into t(x) values('a');")).toEqual({
      level: 'rows',
      action: 'write',
    });
  });
  test('UPDATE → rows:write', () => {
    expect(classifySql('update t set x=1 where id=2;')).toEqual({
      level: 'rows',
      action: 'write',
    });
  });
  test('DELETE → rows:write', () => {
    expect(classifySql('delete from t where id=2;')).toEqual({
      level: 'rows',
      action: 'write',
    });
  });
  test('TRUNCATE → rows:write', () => {
    expect(classifySql('truncate table users;')).toEqual({
      level: 'rows',
      action: 'write',
    });
  });
  test('MERGE → rows:write', () => {
    expect(
      classifySql('merge into t using s on t.id=s.id when matched then update set x=1;'),
    ).toEqual({
      level: 'rows',
      action: 'write',
    });
  });
  test('COPY → rows:write', () => {
    expect(classifySql("copy users from '/tmp/u.csv' csv;")).toEqual({
      level: 'rows',
      action: 'write',
    });
  });
});

describe('classifySql — tables writes (DDL)', () => {
  test('CREATE TABLE → tables:write', () => {
    expect(classifySql('create table foo(id int);')).toEqual({
      level: 'tables',
      action: 'write',
    });
  });
  test('DROP TABLE → tables:write', () => {
    expect(classifySql('drop table if exists foo;')).toEqual({
      level: 'tables',
      action: 'write',
    });
  });
  test('ALTER TABLE … ADD COLUMN → tables:write', () => {
    expect(classifySql('alter table foo add column bar text;')).toEqual({
      level: 'tables',
      action: 'write',
    });
  });
  test('CREATE INDEX → tables:write', () => {
    expect(classifySql('create index ix_foo on foo(bar);')).toEqual({
      level: 'tables',
      action: 'write',
    });
  });
  test('CREATE UNIQUE INDEX → tables:write (deeper t2 match)', () => {
    expect(classifySql('create unique index ix on t(x);')).toEqual({
      level: 'tables',
      action: 'write',
    });
  });
  test('CREATE OR REPLACE FUNCTION → tables:write', () => {
    expect(
      classifySql('create or replace function fn() returns int as $$ select 1 $$ language sql;'),
    ).toEqual({
      level: 'tables',
      action: 'write',
    });
  });
  test('REFRESH MATERIALIZED VIEW → tables:write', () => {
    expect(classifySql('refresh materialized view mv;')).toEqual({
      level: 'tables',
      action: 'write',
    });
  });
});

describe('classifySql — rls writes (policies, roles, grants)', () => {
  test('CREATE POLICY → rls:write', () => {
    expect(classifySql('create policy p on t for select using (true);')).toEqual({
      level: 'rls',
      action: 'write',
    });
  });
  test('DROP POLICY → rls:write', () => {
    expect(classifySql('drop policy p on t;')).toEqual({ level: 'rls', action: 'write' });
  });
  test('ALTER POLICY → rls:write', () => {
    expect(classifySql('alter policy p on t to authenticated;')).toEqual({
      level: 'rls',
      action: 'write',
    });
  });
  test('CREATE ROLE → rls:write', () => {
    expect(classifySql('create role app_user;')).toEqual({ level: 'rls', action: 'write' });
  });
  test('GRANT → rls:write', () => {
    expect(classifySql('grant select on table t to app_user;')).toEqual({
      level: 'rls',
      action: 'write',
    });
  });
  test('REVOKE → rls:write', () => {
    expect(classifySql('revoke select on table t from app_user;')).toEqual({
      level: 'rls',
      action: 'write',
    });
  });
  test('ALTER TABLE … ENABLE ROW LEVEL SECURITY → rls:write (not tables:write)', () => {
    expect(classifySql('alter table users enable row level security;')).toEqual({
      level: 'rls',
      action: 'write',
    });
  });
  test('ALTER TABLE … FORCE ROW LEVEL SECURITY → rls:write', () => {
    expect(classifySql('alter table users force row level security;')).toEqual({
      level: 'rls',
      action: 'write',
    });
  });
});

describe('classifySql — project writes', () => {
  test('CREATE EXTENSION → project:write', () => {
    expect(classifySql('create extension pgcrypto;')).toEqual({
      level: 'project',
      action: 'write',
    });
  });
  test('ALTER SYSTEM → project:write', () => {
    expect(classifySql('alter system set max_connections = 200;')).toEqual({
      level: 'project',
      action: 'write',
    });
  });
  test('VACUUM → project:write', () => {
    expect(classifySql('vacuum analyze users;')).toEqual({
      level: 'project',
      action: 'write',
    });
  });
  test('SET → project:write', () => {
    expect(classifySql('set search_path = public, extensions;')).toEqual({
      level: 'project',
      action: 'write',
    });
  });
  test('CREATE SCHEMA → project:write', () => {
    expect(classifySql('create schema if not exists app;')).toEqual({
      level: 'project',
      action: 'write',
    });
  });
});

describe('classifySql — multi-statement: strictest wins', () => {
  test('SELECT + INSERT → rows:write', () => {
    expect(classifySql('select 1; insert into t(x) values(1);')).toEqual({
      level: 'rows',
      action: 'write',
    });
  });
  test('SELECT + CREATE TABLE → tables:write', () => {
    expect(classifySql('select 1; create table t(id int);')).toEqual({
      level: 'tables',
      action: 'write',
    });
  });
  test('INSERT + GRANT → rls:write (rank dominates over rows:write)', () => {
    expect(classifySql('insert into t(x) values(1); grant select on t to anon;')).toEqual({
      level: 'rls',
      action: 'write',
    });
  });
  test('GRANT + ALTER SYSTEM → project:write', () => {
    expect(classifySql('grant all on t to anon; alter system set x = 1;')).toEqual({
      level: 'project',
      action: 'write',
    });
  });
});

describe('classifySql — literals do not confuse split / detection', () => {
  test("semicolon inside string literal doesn't split", () => {
    expect(classifySql("select 'a; drop table users';")).toEqual({
      level: 'rows',
      action: 'read',
    });
  });
  test("keyword inside string literal doesn't trigger", () => {
    expect(classifySql("select 'DROP TABLE x' as msg;")).toEqual({
      level: 'rows',
      action: 'read',
    });
  });
  test('keyword inside line comment does not trigger', () => {
    expect(classifySql('select 1; -- drop table users\n')).toEqual({
      level: 'rows',
      action: 'read',
    });
  });
  test('dollar-quoted body does not trigger', () => {
    expect(
      classifySql(
        'create or replace function f() returns void as $$ drop table users $$ language sql;',
      ),
    ).toEqual({ level: 'tables', action: 'write' });
  });
});

describe('classifySql — unknown / paranoid default', () => {
  test('unknown leading verb → project:write (forces human gate)', () => {
    expect(classifySql('foobar baz;')).toEqual({ level: 'project', action: 'write' });
  });
  test('CALL → rows:write (procedures mutate by default)', () => {
    expect(classifySql('call my_proc(1, 2);')).toEqual({ level: 'rows', action: 'write' });
  });
});
