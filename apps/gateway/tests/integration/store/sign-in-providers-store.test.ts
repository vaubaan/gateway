/**
 * Migration 0014 and what it gives the store (spec §0 "Invitation"; see
 * docs/handbook/authentication.md): the invitation list, IdP groups
 * bound to the sign-in provider that claims them, and the end of the sessions of
 * a removed provider's users.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MEMORY_PATH, openDb } from '../../../src/server/store/db.ts';
import { loadMigrations, runMigrations } from '../../../src/server/store/migrate.ts';
import { openTestStore, type TestStore } from '../../support/store/testing.ts';

const AT = '2026-10-01T00:00:00.000Z';

describe('invitations', () => {
  let t: TestStore;
  beforeEach(() => {
    t = openTestStore();
  });
  afterEach(() => t.store.close());

  it('keeps one lower-cased entry per address, removes it, lists newest first', async () => {
    const first = await t.store.invitations.add('Ada@Example.com', 'ops');
    expect(first).toMatchObject({ email: 'ada@example.com', invitedBy: 'ops' });
    expect(await t.store.invitations.add('ada@example.com', 'other')).toBeNull();
    expect((await t.store.invitations.get('ADA@example.com'))?.invitedBy).toBe('ops');
    t.clock.advance(1000);
    await t.store.invitations.add('bob@example.com', 'bootstrap');
    expect((await t.store.invitations.list()).map((i) => i.email)).toEqual([
      'bob@example.com',
      'ada@example.com',
    ]);
    expect(await t.store.invitations.remove('ada@example.com')).toMatchObject({
      email: 'ada@example.com',
    });
    expect(await t.store.invitations.remove('ada@example.com')).toBeNull();
  });
});

describe('IdP groups belong to their sign-in provider', () => {
  let t: TestStore;
  beforeEach(() => {
    t = openTestStore();
  });
  afterEach(() => t.store.close());

  it('a name claimed by one provider is skipped for a user of another, never joined', async () => {
    const ada = await t.store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'ada',
      email: 'ada@x',
    });
    const eve = await t.store.users.upsertFromIdp({
      issuer: 'http://github.test',
      subject: '7',
      email: 'eve@x',
    });
    expect(await t.store.groups.syncIdpMemberships(ada.id, ['platform'], 'company')).toEqual({
      skipped: [],
    });
    expect(await t.store.groups.syncIdpMemberships(eve.id, ['platform'], 'github')).toEqual({
      skipped: ['platform'],
    });
    expect(await t.store.groups.groupsOf(eve.id)).toEqual([]);
    expect(await t.store.groups.groupsOf(ada.id)).toEqual([
      expect.objectContaining({ name: 'platform', source: 'idp', provider: 'company' }),
    ]);
    // A local group has no provider.
    expect(await t.store.groups.createLocal('reviewers')).toMatchObject({ provider: null });
  });

  it('ends the sessions of the users of one issuer, with or without a trailing slash', async () => {
    const ada = await t.store.users.upsertFromIdp({
      issuer: 'https://github.example.com',
      subject: '1',
      email: 'ada@x',
    });
    const bob = await t.store.users.upsertFromIdp({
      issuer: 'https://idp.example.com',
      subject: 'b',
      email: 'bob@x',
    });
    expect(await t.store.users.endSessionsOfIssuer('https://github.example.com/')).toBe(1);
    expect((await t.store.users.getById(ada.id))?.sessionsEndedAt).not.toBeNull();
    expect((await t.store.users.getById(ada.id))?.status).toBe('active');
    expect((await t.store.users.getById(bob.id))?.sessionsEndedAt).toBeNull();
  });
});

describe('migration 0014 over an earlier database', () => {
  it('binds every IdP group that exists to the provider idp and leaves local groups without one', () => {
    const clock = { now: () => new Date(AT) };
    const db = openDb({ path: MEMORY_PATH });
    const shipped = loadMigrations();
    runMigrations(
      db,
      shipped.filter((m) => m.version < 14),
      clock,
    );
    const insert = db.prepare(
      'INSERT INTO groups (id, name, source, created_at) VALUES (?, ?, ?, ?)',
    );
    insert.run('g1', 'platform', 'idp', AT);
    insert.run('g2', 'reviewers', 'local', AT);
    runMigrations(db, shipped, clock);
    expect(db.prepare('SELECT id, provider FROM groups ORDER BY id').all()).toEqual([
      { id: 'g1', provider: 'idp' },
      { id: 'g2', provider: null },
    ]);
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'invitations'")
        .get(),
    ).toEqual({ name: 'invitations' });
    db.close();
  });
});
