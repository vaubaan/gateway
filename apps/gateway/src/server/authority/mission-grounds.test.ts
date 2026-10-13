import { MemoryAuditWriter } from '@vaubaan/gateway-core';
import { PluginRegistry } from '@vaubaan/plugin-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RegistryCatalogIndex } from '../compose/registry';
import { fakePlugin } from '../compose/testing';
import { API_KEY_SPEC, fixturePlugin } from '../connections/testing';
import { silentLogger } from '../logging';
import { openMemoryStore, type Store } from '../store';
import { ManualClock } from '../store/clock';
import { StubEncryptor } from '../store/testing';
import type { ConnectionRecord, MissionRecord, Principal, UserRecord } from '../store/types';
import { createAuthorityModule, partitionOf, type AuthorityModule } from './index';

const READ = 'acme.read-things';
const WRITE_STAGING = 'acme[staging].thing-write';
const WRITE_PROD = 'acme[prod].thing-write';
const OTHER_READ = 'other.read-things';

describe('MissionGrounds — the `orphaned` derivation', () => {
  let store: Store;
  let audit: MemoryAuditWriter;
  let authority: AuthorityModule;
  let ada: UserRecord;
  let bob: UserRecord;

  beforeEach(async () => {
    const registry = new PluginRegistry([
      fakePlugin(),
      fixturePlugin({ id: 'other', credential: API_KEY_SPEC }),
    ]);
    store = openMemoryStore({
      encryptor: new StubEncryptor(),
      catalog: new RegistryCatalogIndex(registry),
    });
    audit = new MemoryAuditWriter();
    authority = createAuthorityModule({
      store: { ...store, auditWriter: audit },
      registry,
      logger: silentLogger,
      clock: new ManualClock(),
    });
    ada = await store.users.upsertFromIdp({ subject: 'idp|ada', email: 'ada@example.com' });
    bob = await store.users.upsertFromIdp({ subject: 'idp|bob', email: 'bob@example.com' });
  });
  afterEach(async () => {
    await store.close();
  });

  const connect = (owner: Principal, provider = 'acme'): Promise<ConnectionRecord> =>
    store.connections.create({ provider, owner, displayName: provider, credential: null });

  const share = (connection: ConnectionRecord, target: Principal, restriction: string[]) =>
    store.shares.create({
      connectionId: connection.id,
      target,
      restriction,
      createdByUserId: ada.id,
    });

  const mission = (
    creator: UserRecord,
    connections: readonly ConnectionRecord[],
    riskIds: readonly string[],
  ): Promise<MissionRecord> =>
    store.missions.create({
      name: 'A mission',
      creatorUserId: creator.id,
      periodSeconds: 86_400,
      connections: connections.map((c) => ({
        connectionId: c.id,
        resourceScope: 'all',
        resourceIds: [],
      })),
      policy: riskIds.map((riskId) => ({
        riskId,
        quota: 10,
        rateLimit: 10,
        rateWindowSeconds: 60,
        gate: 'auto',
      })),
    });

  const reread = async (m: MissionRecord) => (await store.missions.getById(m.id))!;
  const user = (u: UserRecord): Principal => ({ kind: 'user', id: u.id });

  describe('check', () => {
    it('is grounded for the owner, whatever was accepted', async () => {
      const connection = await connect(user(ada));
      const m = await mission(ada, [connection], [READ, WRITE_PROD]);
      expect(await authority.grounds.check(m)).toEqual({ grounded: true });
    });

    it('is grounded for a beneficiary while the shares cover every accepted risk', async () => {
      const connection = await connect(user(ada));
      await share(connection, user(bob), [READ, WRITE_STAGING]);
      const m = await mission(bob, [connection], [WRITE_STAGING, READ]);
      expect(await authority.grounds.check(m)).toEqual({ grounded: true });
    });

    it('authority-lost: names the connection and the risks no longer covered', async () => {
      const connection = await connect(user(ada));
      const granted = await share(connection, user(bob), [READ, WRITE_STAGING]);
      const m = await mission(bob, [connection], [READ, WRITE_STAGING]);
      await store.shares.revoke(granted.id);
      await share(connection, user(bob), [READ]);
      expect(await authority.grounds.check(m)).toEqual({
        grounded: false,
        cause: 'authority-lost',
        connectionId: connection.id,
        uncovered: [WRITE_STAGING],
      });
    });

    it('authority-lost: the creator dropped from the owner group that grounded the mission', async () => {
      const group = await store.groups.getOrCreate('admins', 'local');
      await store.groups.addMember(group.id, bob.id);
      const connection = await connect({ kind: 'group', id: group.id });
      const m = await mission(bob, [connection], [READ]);
      expect(await authority.grounds.check(m)).toEqual({ grounded: true });
      await store.groups.removeMember(group.id, bob.id);
      expect(await authority.grounds.check(m)).toMatchObject({
        grounded: false,
        cause: 'authority-lost',
        uncovered: [READ],
      });
    });

    it('connection-revoked: even for the owner', async () => {
      const connection = await connect(user(ada));
      const m = await mission(ada, [connection], [READ]);
      await store.connections.revoke(connection.id);
      expect(await authority.grounds.check(m)).toEqual({
        grounded: false,
        cause: 'connection-revoked',
        connectionId: connection.id,
        uncovered: [],
      });
    });

    it('stays grounded on an expired or an unowned connection: neither removes an authority', async () => {
      const group = await store.groups.getOrCreate('admins', 'local');
      await store.groups.addMember(group.id, ada.id);
      const connection = await connect({ kind: 'group', id: group.id });
      await share(connection, user(bob), [READ]);
      const m = await mission(bob, [connection], [READ]);

      await store.groups.removeMember(group.id, ada.id);
      await store.connections.markOwnerlessUnowned();
      expect((await store.connections.getById(connection.id))?.status).toBe('unowned');
      expect(await authority.grounds.check(m)).toEqual({ grounded: true });

      await store.connections.markExpired(connection.id);
      expect(await authority.grounds.check(m)).toEqual({ grounded: true });
    });

    it('creator-removed: the creator vanished from the IdP', async () => {
      const connection = await connect(user(ada));
      const m = await mission(ada, [connection], [READ]);
      await store.users.markRemoved(ada.id);
      expect(await authority.grounds.check(m)).toEqual({
        grounded: false,
        cause: 'creator-removed',
        connectionId: null,
        uncovered: [],
      });
    });

    it('checks each connection against its own partition of the accepted risks', async () => {
      const acme = await connect(user(ada));
      const other = await connect(user(ada), 'other');
      await share(acme, user(bob), [READ]);
      await share(other, user(bob), [OTHER_READ]);
      const m = await mission(bob, [acme, other], [READ, OTHER_READ]);
      expect(partitionOf(m, 'acme')).toEqual([READ]);
      expect(partitionOf(m, 'other')).toEqual([OTHER_READ]);
      expect(await authority.grounds.check(m)).toEqual({ grounded: true });

      // A share of one connection never covers the risks of another.
      const [granted] = await store.shares.listForConnection(other.id);
      await store.shares.revoke(granted!.id);
      expect(await authority.grounds.check(m)).toEqual({
        grounded: false,
        cause: 'authority-lost',
        connectionId: other.id,
        uncovered: [OTHER_READ],
      });
    });
  });

  describe('settle — the execution door', () => {
    it('returns a grounded mission untouched', async () => {
      const connection = await connect(user(ada));
      const m = await mission(ada, [connection], [READ]);
      expect(await authority.grounds.settle(m)).toBe(m);
      expect((await reread(m)).status).toBe('active');
    });

    it('turns an ungrounded active mission orphaned, with no admin entry (no human behind it)', async () => {
      const connection = await connect(user(ada));
      const granted = await share(connection, user(bob), [READ]);
      const m = await mission(bob, [connection], [READ]);
      await store.shares.revoke(granted.id);

      const settled = await authority.grounds.settle(m);
      expect(settled.status).toBe('orphaned');
      expect(settled.closedAt).not.toBeNull();
      expect((await reread(m)).status).toBe('orphaned');
      expect(audit.admin).toEqual([]);
    });

    it('never touches a mission that is not active', async () => {
      const connection = await connect(user(ada));
      const m = await mission(ada, [connection], [READ]);
      const revoked = await store.missions.setStatus(m.id, 'revoked');
      await store.connections.revoke(connection.id);
      expect(await authority.grounds.settle(revoked)).toBe(revoked);
      expect((await reread(m)).status).toBe('revoked');
    });

    it('does not overwrite a mission revoked between the read and the write', async () => {
      const connection = await connect(user(ada));
      const stale = await mission(ada, [connection], [READ]);
      await store.connections.revoke(connection.id);
      await store.missions.setStatus(stale.id, 'revoked');
      // `stale` still says `active`: the conditional update must lose.
      expect((await authority.grounds.settle(stale)).status).toBe('revoked');
    });
  });

  describe('sweeps — right after the act that removed an authority', () => {
    it('sweepConnection orphans the ungrounded missions of that connection and names the actor', async () => {
      const connection = await connect(user(ada));
      const elsewhere = await connect(user(ada));
      const granted = await share(connection, user(bob), [READ]);
      await share(elsewhere, user(bob), [READ]);
      const lost = await mission(bob, [connection], [READ]);
      const owners = await mission(ada, [connection], [READ]);
      const untouched = await mission(bob, [elsewhere], [READ]);
      await store.shares.revoke(granted.id);

      const orphaned = await authority.grounds.sweepConnection(connection.id, ada.id);

      expect(orphaned.map((m) => m.id)).toEqual([lost.id]);
      expect((await reread(owners)).status).toBe('active');
      expect((await reread(untouched)).status).toBe('active');
      expect(audit.admin).toEqual([
        expect.objectContaining({
          user_id: ada.id,
          act: 'mission-orphaned',
          object: { type: 'mission', id: lost.id },
          before: { status: 'active' },
          after: {
            status: 'orphaned',
            cause: 'authority-lost',
            connection_id: connection.id,
            uncovered: [READ],
          },
        }),
      ]);
    });

    it('sweepCreator orphans the ungrounded missions of that user only, once', async () => {
      const group = await store.groups.getOrCreate('admins', 'local');
      await store.groups.addMember(group.id, bob.id);
      await store.groups.addMember(group.id, ada.id);
      const connection = await connect({ kind: 'group', id: group.id });
      const bobs = await mission(bob, [connection], [READ]);
      const adas = await mission(ada, [connection], [READ]);
      await store.groups.removeMember(group.id, bob.id);

      expect((await authority.grounds.sweepCreator(bob.id, 'operator')).map((m) => m.id)).toEqual([
        bobs.id,
      ]);
      expect((await reread(adas)).status).toBe('active');
      // A second sweep finds nothing left to orphan and writes nothing.
      expect(await authority.grounds.sweepCreator(bob.id, 'operator')).toEqual([]);
      expect(audit.admin).toHaveLength(1);
    });
  });

  describe('MembershipSettler.afterRemoval', () => {
    it('marks the connections whose owner group emptied unowned and orphans what the member lost', async () => {
      const group = await store.groups.getOrCreate('admins', 'local');
      await store.groups.addMember(group.id, bob.id);
      const owned = await connect({ kind: 'group', id: group.id });
      const adas = await connect(user(ada));
      const m = await mission(bob, [owned], [READ]);
      await store.groups.removeMember(group.id, bob.id);

      const settlement = await authority.membership.afterRemoval(bob.id, 'operator');

      expect(settlement.unowned.map((c) => c.id)).toEqual([owned.id]);
      expect(settlement.orphaned.map((x) => x.id)).toEqual([m.id]);
      expect((await store.connections.getById(owned.id))?.status).toBe('unowned');
      expect((await store.connections.getById(adas.id))?.status).toBe('active');
    });

    it('changes nothing while the group keeps another member', async () => {
      const group = await store.groups.getOrCreate('admins', 'local');
      await store.groups.addMember(group.id, bob.id);
      await store.groups.addMember(group.id, ada.id);
      const owned = await connect({ kind: 'group', id: group.id });
      await store.groups.removeMember(group.id, bob.id);
      const settlement = await authority.membership.afterRemoval(bob.id, 'operator');
      expect(settlement).toEqual({ unowned: [], orphaned: [] });
      expect((await store.connections.getById(owned.id))?.status).toBe('active');
    });
  });
});
