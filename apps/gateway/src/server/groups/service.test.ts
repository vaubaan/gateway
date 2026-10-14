import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  authorityRig,
  READ,
  type AuthorityRig,
} from '../../../tests/integration/authority/support';
import { currentAuthority, resolveAdminRule } from '../auth';
import { findActiveUserByEmail } from '../authority';
import { GROUP_NAME_MAX_LENGTH } from './service';

const ADMIN_GROUP = 'gateway-admins';

describe('GroupService — local groups kept by the operator', () => {
  let rig: AuthorityRig;

  beforeEach(async () => {
    rig = await authorityRig({ env: { VAUBAAN_ADMIN_GROUP: ADMIN_GROUP } });
  });
  afterEach(async () => {
    await rig.close();
  });

  const groups = () => rig.root.groups.service;
  const op = () => rig.operator.id;

  describe('create', () => {
    it('creates a local group and audits it', async () => {
      const group = await groups().create(op(), '  platform ');
      expect(group).toMatchObject({ name: 'platform', source: 'local' });
      expect(await rig.adminEntries('group-created')).toMatchObject([
        {
          user_id: op(),
          object: { type: 'group', id: group.id },
          after: { name: 'platform', source: 'local' },
        },
      ]);
    });

    it.each([
      ['an empty name', '   '],
      ['a name that is too long', 'x'.repeat(GROUP_NAME_MAX_LENGTH + 1)],
      ['a control character', 'plat\nform'],
    ])('refuses %s', async (_case, name) => {
      await expect(groups().create(op(), name)).rejects.toMatchObject({ code: 'name-invalid' });
      expect(await rig.root.store.groups.list()).toEqual([]);
    });

    it('refuses a name already held, by a local group or by one the IdP claimed', async () => {
      await groups().create(op(), 'platform');
      await rig.root.store.groups.getOrCreate('from-idp', 'idp');
      await expect(groups().create(op(), 'platform')).rejects.toMatchObject({ code: 'name-taken' });
      await expect(groups().create(op(), 'from-idp')).rejects.toMatchObject({ code: 'name-taken' });
      // The IdP group was not turned local by the attempt.
      expect((await rig.root.store.groups.getByName('from-idp'))?.source).toBe('idp');
    });

    it('refuses the group of the admin rule: operators are named by the IdP, never by a local group', async () => {
      await expect(groups().create(op(), ADMIN_GROUP)).rejects.toMatchObject({
        code: 'name-reserved',
      });
      expect(await rig.root.store.groups.getByName(ADMIN_GROUP)).toBeNull();
    });

    it('never makes an operator of a member of a local group, whatever its name', async () => {
      const { store, config } = rig.root;
      // A local group that carries the admin rule's name (created before the rule named it).
      const local = await store.groups.getOrCreate(ADMIN_GROUP, 'local');
      await store.groups.addMember(local.id, rig.bob.id);
      const rule = resolveAdminRule(config.admin, ['idp']);
      expect(await currentAuthority(store, rig.bob, rule)).toMatchObject({
        isOperator: false,
        groups: [{ name: ADMIN_GROUP, source: 'local' }],
      });
      // The same name claimed by the IdP is what the rule means.
      store.db
        .prepare("UPDATE groups SET source = 'idp', provider = 'idp' WHERE id = ?")
        .run(local.id);
      expect((await currentAuthority(store, rig.bob, rule)).isOperator).toBe(true);
    });
  });

  describe('members', () => {
    it('adds a known user by email, idempotently, and lists the group with its members', async () => {
      const group = await groups().create(op(), 'platform');
      await groups().addMember(op(), group.id, 'Bob@example.com');
      await groups().addMember(op(), group.id, 'bob@example.com');
      await groups().addMember(op(), group.id, 'ada@example.com');
      const [view] = await groups().list();
      expect(view?.members.map((m) => m.email)).toEqual(['ada@example.com', 'bob@example.com']);
      expect(view?.ownedConnections).toBe(0);
      // One entry per change: the repeated addition of Bob wrote nothing.
      const added = await rig.adminEntries('group-member-added');
      expect(added).toHaveLength(2);
      expect(added[0]).toMatchObject({
        user_id: op(),
        object: { type: 'group', id: group.id },
        after: { user_id: rig.bob.id, email: 'bob@example.com' },
      });
      expect(added[1]).toMatchObject({ after: { user_id: rig.ada.id } });
    });

    it('settles a removal even when its own entry cannot be written: the emptied owner group leaves the connection unowned', async () => {
      const group = await groups().create(op(), 'depot-admins');
      await groups().addMember(op(), group.id, 'ada@example.com');
      await rig.root.connections.service.transfer(
        await rig.actor(rig.ada),
        rig.connection.id,
        group.id,
      );
      const mission = await rig.issueFor(rig.ada, [READ]);

      vi.spyOn(rig.root.store.auditWriter, 'write').mockRejectedValueOnce(new Error('audit down'));
      await expect(groups().removeMember(op(), group.id, rig.ada.id)).rejects.toThrow('audit down');

      // The membership is gone; what it held was settled all the same.
      expect(await rig.root.store.groups.listMembers(group.id)).toEqual([]);
      expect((await rig.root.store.connections.getById(rig.connection.id))?.status).toBe('unowned');
      expect(await rig.adminEntries('group-member-removed')).toEqual([]);
      expect(await rig.adminEntries('mission-orphaned')).toMatchObject([
        { user_id: op(), object: { id: mission.mission.id } },
      ]);
    });

    it('settles an addition even when its own entry cannot be written', async () => {
      const group = await groups().create(op(), 'platform');
      await rig.root.shares.service.share(await rig.actor(rig.ada), rig.connection.id, {
        target: { kind: 'group', groupId: group.id },
        riskIds: [READ],
      });
      await groups().addMember(op(), group.id, 'bob@example.com');
      const mission = await rig.issueFor(rig.bob, [READ]);
      await groups().removeMember(op(), group.id, rig.bob.id);
      expect(await rig.statusOf(mission)).toBe('orphaned');

      vi.spyOn(rig.root.store.auditWriter, 'write').mockRejectedValueOnce(new Error('audit down'));
      await expect(groups().addMember(op(), group.id, 'bob@example.com')).rejects.toThrow(
        'audit down',
      );
      expect(await rig.statusOf(mission)).toBe('active');
      expect(await rig.adminEntries('mission-restored')).toMatchObject([
        { user_id: op(), object: { id: mission.mission.id } },
      ]);
    });

    it('refuses an email nobody signed in with, and a group that does not exist', async () => {
      const group = await groups().create(op(), 'platform');
      await expect(groups().addMember(op(), group.id, 'ghost@example.com')).rejects.toMatchObject({
        code: 'user-unknown',
      });
      await expect(groups().addMember(op(), 'nope', 'bob@example.com')).rejects.toMatchObject({
        code: 'not-found',
      });
      await expect(groups().removeMember(op(), group.id, rig.bob.id)).rejects.toMatchObject({
        code: 'not-found',
      });
    });

    it('never edits a group that comes from the IdP', async () => {
      const idp = await rig.root.store.groups.getOrCreate('from-idp', 'idp');
      await rig.root.store.groups.addMember(idp.id, rig.bob.id);
      await expect(groups().addMember(op(), idp.id, 'ada@example.com')).rejects.toMatchObject({
        code: 'not-local',
      });
      await expect(groups().removeMember(op(), idp.id, rig.bob.id)).rejects.toMatchObject({
        code: 'not-local',
      });
      expect((await rig.root.store.groups.listMembers(idp.id)).map((m) => m.id)).toEqual([
        rig.bob.id,
      ]);
    });

    it('removes a member, audits it, and reports what the membership held', async () => {
      const group = await groups().create(op(), 'platform');
      await groups().addMember(op(), group.id, 'bob@example.com');
      await rig.root.shares.service.share(await rig.actor(rig.ada), rig.connection.id, {
        target: { kind: 'group', groupId: group.id },
        riskIds: [READ],
      });
      const mission = await rig.issueFor(rig.bob, [READ]);

      const removal = await groups().removeMember(op(), group.id, rig.bob.id);

      expect(removal).toMatchObject({
        group: { id: group.id },
        user: { id: rig.bob.id },
        unowned: 0,
        orphaned: 1,
      });
      expect(await rig.statusOf(mission)).toBe('orphaned');
      expect(await rig.adminEntries('group-member-removed')).toMatchObject([
        { user_id: op(), object: { type: 'group', id: group.id }, before: { user_id: rig.bob.id } },
      ]);
    });

    it('counts the connections a group owns', async () => {
      const group = await groups().create(op(), 'depot-admins');
      await groups().addMember(op(), group.id, 'ada@example.com');
      await rig.root.connections.service.transfer(
        await rig.actor(rig.ada),
        rig.connection.id,
        group.id,
      );
      expect((await groups().list())[0]?.ownedConnections).toBe(1);
    });
  });
});

describe('findActiveUserByEmail', () => {
  let rig: AuthorityRig;

  beforeEach(async () => {
    rig = await authorityRig();
  });
  afterEach(async () => {
    await rig.close();
  });

  it('designates exactly one active user, or nobody', async () => {
    const { users } = rig.root.store;
    expect(await findActiveUserByEmail(users, ' bob@example.com ')).toMatchObject({
      found: true,
      user: { id: rig.bob.id },
    });
    expect(await findActiveUserByEmail(users, 'BOB@EXAMPLE.COM')).toMatchObject({ found: true });
    expect(await findActiveUserByEmail(users, '')).toEqual({ found: false, reason: 'unknown' });
    expect(await findActiveUserByEmail(users, 'bob')).toEqual({ found: false, reason: 'unknown' });
    // A partial or a pattern never matches: the lookup is an equality.
    expect(await findActiveUserByEmail(users, '%@example.com')).toEqual({
      found: false,
      reason: 'unknown',
    });

    const twin = await users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'idp|bob-2',
      email: 'bob@example.com',
    });
    expect(await findActiveUserByEmail(users, 'bob@example.com')).toEqual({
      found: false,
      reason: 'ambiguous',
    });
    await users.markRemoved(twin.id);
    expect(await findActiveUserByEmail(users, 'bob@example.com')).toMatchObject({
      found: true,
      user: { id: rig.bob.id },
    });
  });
});
