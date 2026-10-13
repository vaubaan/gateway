import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/server/store/index.ts';
import { openTestStore, type TestStore } from '../../../src/server/store/testing.ts';

describe('users repository', () => {
  let t: TestStore;
  let store: Store;

  beforeEach(() => {
    t = openTestStore();
    store = t.store;
  });
  afterEach(() => store.close());

  it('creates a user on first login and refreshes it afterwards', async () => {
    const created = await store.users.upsertFromIdp({
      subject: 'idp|1',
      email: 'ada@example.test',
      displayName: 'Ada',
    });
    expect(created).toMatchObject({
      subject: 'idp|1',
      email: 'ada@example.test',
      displayName: 'Ada',
      status: 'active',
      lastLoginAt: '2026-10-13T09:00:00.000Z',
    });

    t.clock.advance(60_000);
    const again = await store.users.upsertFromIdp({ subject: 'idp|1', email: 'ada@new.test' });
    expect(again.id).toBe(created.id);
    expect(again.email).toBe('ada@new.test');
    expect(again.lastLoginAt).toBe('2026-10-13T09:01:00.000Z');
    expect(await store.users.list()).toHaveLength(1);
  });

  it('looks users up by id, subject and email', async () => {
    const u = await store.users.upsertFromIdp({ subject: 's', email: 'e@x' });
    expect(await store.users.getById(u.id)).toEqual(u);
    expect(await store.users.getBySubject('s')).toEqual(u);
    expect(await store.users.findByEmail('e@x')).toEqual([u]);
    expect(await store.users.getById('missing')).toBeNull();
  });

  it('marks a user removed; a later login does not bring them back, `reactivate` does', async () => {
    const u = await store.users.upsertFromIdp({ subject: 's', email: 'e@x' });
    expect(u.sessionsEndedAt).toBeNull();
    const removed = await store.users.markRemoved(u.id);
    expect(removed.status).toBe('removed');
    expect(removed.removedAt).toBe('2026-10-13T09:00:00.000Z');
    expect(removed.sessionsEndedAt).toBe('2026-10-13T09:00:00.000Z');

    // The identity provider still knows them: the row is refreshed, the status is not.
    t.clock.advance(60_000);
    const still = await store.users.upsertFromIdp({ subject: 's', email: 'e@new' });
    expect(still).toMatchObject({ id: u.id, email: 'e@new', status: 'removed' });
    expect(still.removedAt).toBe(removed.removedAt);

    const back = await store.users.reactivate(u.id);
    expect(back).toMatchObject({ status: 'active', removedAt: null });
    // What was open before the deactivation stays closed.
    expect(back?.sessionsEndedAt).toBe(removed.sessionsEndedAt);
    // Only a removed user is reactivated; nothing is written otherwise.
    expect(await store.users.reactivate(u.id)).toBeNull();
    expect(await store.users.reactivate('missing')).toBeNull();
    await expect(store.users.markRemoved('missing')).rejects.toThrow(/not found/);
  });
});

describe('groups repository', () => {
  let store: Store;
  let alice: string;
  let bob: string;

  beforeEach(async () => {
    store = openTestStore().store;
    alice = (await store.users.upsertFromIdp({ subject: 'a', email: 'a@x' })).id;
    bob = (await store.users.upsertFromIdp({ subject: 'b', email: 'b@x' })).id;
  });
  afterEach(() => store.close());

  it('getOrCreate is idempotent on the name', async () => {
    const g1 = await store.groups.getOrCreate('github-admins', 'idp');
    const g2 = await store.groups.getOrCreate('github-admins', 'local');
    expect(g2).toEqual(g1);
    expect(g1.source).toBe('idp');
    expect(await store.groups.getByName('github-admins')).toEqual(g1);
    expect(await store.groups.list()).toHaveLength(1);
  });

  it('replaces membership atomically and reports groups of a user', async () => {
    const g = await store.groups.getOrCreate('ops', 'idp');
    await store.groups.setMembers(g.id, [alice, bob]);
    expect((await store.groups.listMembers(g.id)).map((u) => u.id)).toEqual([alice, bob]);
    await store.groups.setMembers(g.id, [bob]);
    expect((await store.groups.listMembers(g.id)).map((u) => u.id)).toEqual([bob]);
    expect(await store.groups.groupsOf(alice)).toEqual([]);
    expect((await store.groups.groupsOf(bob)).map((x) => x.id)).toEqual([g.id]);
    await store.groups.setMembers(g.id, []);
    expect(await store.groups.memberCount(g.id)).toBe(0);
  });

  it('removes a user from every group at once, local and IdP-sourced, and says which', async () => {
    const local = await store.groups.getOrCreate('reviewers', 'local');
    await store.groups.addMember(local.id, alice);
    await store.groups.addMember(local.id, bob);
    await store.groups.syncIdpMemberships(alice, ['dev']);
    const left = await store.groups.removeAllMemberships(alice);
    expect(left.map((g) => [g.name, g.source])).toEqual([
      ['dev', 'idp'],
      ['reviewers', 'local'],
    ]);
    expect(await store.groups.groupsOf(alice)).toEqual([]);
    expect((await store.groups.listMembers(local.id)).map((u) => u.id)).toEqual([bob]);
    expect(await store.groups.removeAllMemberships(alice)).toEqual([]);
  });

  it('adds and removes single members', async () => {
    const g = await store.groups.getOrCreate('ops', 'local');
    await store.groups.addMember(g.id, alice);
    await store.groups.addMember(g.id, alice); // idempotent
    expect(await store.groups.memberCount(g.id)).toBe(1);
    expect(await store.groups.removeMember(g.id, alice)).toBe(true);
    expect(await store.groups.removeMember(g.id, alice)).toBe(false);
    await expect(store.groups.addMember('missing', alice)).rejects.toThrow(/not found/);
  });

  it('syncIdpMemberships replaces the IdP memberships of a user and leaves local groups alone', async () => {
    const local = await store.groups.getOrCreate('reviewers', 'local');
    await store.groups.addMember(local.id, alice);
    expect(await store.groups.syncIdpMemberships(alice, ['dev', 'ops'])).toEqual({ skipped: [] });
    expect((await store.groups.groupsOf(alice)).map((g) => [g.name, g.source])).toEqual([
      ['dev', 'idp'],
      ['ops', 'idp'],
      ['reviewers', 'local'],
    ]);
    await store.groups.syncIdpMemberships(alice, ['ops']);
    expect((await store.groups.groupsOf(alice)).map((g) => g.name)).toEqual(['ops', 'reviewers']);
    await store.groups.syncIdpMemberships(alice, []);
    expect((await store.groups.groupsOf(alice)).map((g) => g.name)).toEqual(['reviewers']);
  });

  it('syncIdpMemberships skips a name held by a local group and reports it', async () => {
    await store.groups.getOrCreate('finance', 'local');
    expect(await store.groups.syncIdpMemberships(bob, ['finance', 'dev'])).toEqual({
      skipped: ['finance'],
    });
    expect((await store.groups.groupsOf(bob)).map((g) => g.name)).toEqual(['dev']);
  });

  it('syncIdpMemberships is one transaction: a failure keeps the previous memberships and creates no group', async () => {
    await store.groups.syncIdpMemberships(alice, ['dev']);
    store.db.exec(
      `CREATE TRIGGER refuse_marked_group BEFORE INSERT ON group_members
       WHEN NEW.group_id IN (SELECT id FROM groups WHERE name = 'refused')
       BEGIN SELECT RAISE(ABORT, 'refused group'); END`,
    );
    await expect(store.groups.syncIdpMemberships(alice, ['ops', 'refused'])).rejects.toThrow(
      /refused group/,
    );
    expect((await store.groups.groupsOf(alice)).map((g) => g.name)).toEqual(['dev']);
    expect((await store.groups.list()).map((g) => g.name)).toEqual(['dev']);
  });

  it('refuses a member that is not a user (foreign key)', async () => {
    const g = await store.groups.getOrCreate('ops', 'local');
    await expect(store.groups.addMember(g.id, 'ghost')).rejects.toThrow(/FOREIGN KEY/);
  });
});
