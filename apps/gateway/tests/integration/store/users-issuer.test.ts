/**
 * Migration 0011 — a user is `(issuer, subject)` (spec §0 "User"; ADR
 * oidc-relying-party-and-web-session, amendment of 2026-10-13).
 *
 *   - the same subject at two issuers is two people: neither sign-in reaches the
 *     other's account;
 *   - an account created by an earlier image has no issuer: it matches no sign-in
 *     until the first one after the upgrade binds every such account, at once, to
 *     its issuer;
 *   - nothing else of the row moves: id, email, status, the foreign keys onto it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MEMORY_PATH, openDb, type StoreDb } from '../../../src/server/store/db.ts';
import { loadMigrations, runMigrations } from '../../../src/server/store/migrate.ts';
import { identityKeyOf } from '../../../src/server/store/repositories/users.ts';
import { InvariantError } from '../../../src/server/store/errors.ts';
import { openTestStore, type TestStore } from '../../support/store/testing.ts';

const OLD_IDP = 'https://old-idp.example.com';
const NEW_IDP = 'https://new-idp.example.com';
const AT = '2026-10-13T08:00:00.000Z';

describe('users keyed by (issuer, subject)', () => {
  let t: TestStore;

  beforeEach(() => {
    t = openTestStore();
  });
  afterEach(async () => {
    await t.store.close();
  });

  it('the same subject at another issuer is another user', async () => {
    const { users } = t.store;
    const first = await users.upsertFromIdp({ issuer: OLD_IDP, subject: '1042', email: 'ada@x' });
    const second = await users.upsertFromIdp({ issuer: NEW_IDP, subject: '1042', email: 'eve@x' });

    expect(second.id).not.toBe(first.id);
    expect(await users.list()).toHaveLength(2);
    expect(await users.getByIdentity(OLD_IDP, '1042')).toMatchObject({
      id: first.id,
      issuer: OLD_IDP,
      subject: '1042',
      email: 'ada@x',
    });
    expect(await users.getByIdentity(NEW_IDP, '1042')).toMatchObject({
      id: second.id,
      issuer: NEW_IDP,
      email: 'eve@x',
    });
    // The first account was not refreshed by the second person's sign-in.
    expect((await users.getById(first.id))?.email).toBe('ada@x');
    expect(await users.getByIdentity('https://third.example.com', '1042')).toBeNull();
  });

  it('a deactivated account of one issuer says nothing about the same subject elsewhere', async () => {
    const { users } = t.store;
    const old = await users.upsertFromIdp({ issuer: OLD_IDP, subject: 's', email: 'a@x' });
    await users.markRemoved(old.id);
    const fresh = await users.upsertFromIdp({ issuer: NEW_IDP, subject: 's', email: 'b@x' });
    expect(fresh.status).toBe('active');
    expect((await users.getById(old.id))?.status).toBe('removed');
  });

  it('the key is injective: no two (issuer, subject) pairs share one', () => {
    // An issuer holds no space, so the first space splits the key.
    expect(identityKeyOf('https://a.example', 'b c')).not.toBe(
      identityKeyOf('https://a.example/b', 'c'),
    );
    expect(identityKeyOf('https://a.example', 'x')).toBe('https://a.example x');
  });

  it.each([
    ['empty', ''],
    ['with a space', 'https://a.example evil'],
    ['with a newline', 'https://a.example\nx'],
    ['without a scheme', 'unbound'],
    ['a bare host', 'idp.example.com'],
  ])('refuses an issuer %s', async (_what, issuer) => {
    const { users } = t.store;
    await expect(users.upsertFromIdp({ issuer, subject: 's', email: 'a@x' })).rejects.toThrow(
      InvariantError,
    );
    await expect(users.getByIdentity(issuer, 's')).rejects.toThrow(InvariantError);
    expect(await users.list()).toEqual([]);
  });

  it('refuses an empty subject', async () => {
    await expect(
      t.store.users.upsertFromIdp({ issuer: OLD_IDP, subject: '', email: 'a@x' }),
    ).rejects.toThrow(InvariantError);
  });
});

describe('accounts from before migration 0011', () => {
  let t: TestStore;
  let db: StoreDb;

  /** A database as the previous image left it: two users, one of them deactivated, one mission. */
  function previousImage(): StoreDb {
    const legacy = openDb({ path: MEMORY_PATH });
    const shipped = loadMigrations();
    runMigrations(
      legacy,
      shipped.filter((m) => m.version < 11),
      t.clock,
    );
    const user = legacy.prepare(
      'INSERT INTO users (id, subject, email, status, created_at, removed_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    user.run('ada', '1042', 'ada@x', 'active', AT, null);
    user.run('bob', 'bob with spaces', 'bob@x', 'removed', AT, AT);
    legacy
      .prepare(
        `INSERT INTO missions (id, name, creator_user_id, status, period_anchor, created_at, updated_at)
         VALUES ('m1', 'Ada''s', 'ada', 'active', ?, ?, ?)`,
      )
      .run(AT, AT, AT);
    runMigrations(legacy, shipped, t.clock);
    return legacy;
  }

  const rows = () =>
    db
      .prepare<
        [],
        { id: string; identity_key: string; issuer: string | null; subject: string; status: string }
      >('SELECT id, identity_key, issuer, subject, status FROM users ORDER BY id')
      .all();

  beforeEach(() => {
    t = openTestStore();
    db = previousImage();
  });
  afterEach(async () => {
    db.close();
    await t.store.close();
  });

  it('keeps every row, with its subject and no issuer; what referenced the user still does', () => {
    expect(rows()).toEqual([
      { id: 'ada', identity_key: 'unbound 1042', issuer: null, subject: '1042', status: 'active' },
      {
        id: 'bob',
        identity_key: 'unbound bob with spaces',
        issuer: null,
        subject: 'bob with spaces',
        status: 'removed',
      },
    ]);
    expect(
      db.prepare<[], { creator_user_id: string }>('SELECT creator_user_id FROM missions').get(),
    ).toEqual({ creator_user_id: 'ada' });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('an unbound account matches no sign-in: the same subject signs in as somebody new', () => {
    // What a lookup by (issuer, subject) reads: nothing for the legacy subject.
    const byKey = db.prepare<[string], { id: string }>(
      'SELECT id FROM users WHERE identity_key = ?',
    );
    expect(byKey.get(identityKeyOf(NEW_IDP, '1042'))).toBeUndefined();
    expect(byKey.get('1042')).toBeUndefined();
    // No issuer-qualified key can equal an unbound one: `unbound` is not an issuer.
    expect(() => identityKeyOf('unbound', '1042')).toThrow(InvariantError);
  });
});
