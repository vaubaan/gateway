import type { AdminAuditEntry } from '@vaubaan/gateway-core';
import { PluginRegistry } from '@vaubaan/plugin-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RegistryCatalogIndex } from '../compose/registry';
import { fakePlugin } from '../../../tests/support/compose/testing';
import { API_KEY_SPEC, fixturePlugin } from '../../../tests/support/connections/testing';
import { silentLogger } from '../logging';
import { openMemoryStore, type Store } from '../store';
import { ManualClock } from '../store/clock';
import { StubEncryptor } from '../../../tests/support/store/testing';
import type { ConnectionRecord, MissionRecord, Principal, UserRecord } from '../store/types';
import { createAuthorityModule, MissionGrounds, partitionOf, type AuthorityModule } from './index';

const READ = 'acme.read-things';
const WRITE_STAGING = 'acme[staging].thing-write';
const WRITE_PROD = 'acme[prod].thing-write';
const OTHER_READ = 'other.read-things';

describe('MissionGrounds — the `orphaned` derivation', () => {
  let store: Store;
  let clock: ManualClock;
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
    clock = new ManualClock();
    authority = createAuthorityModule({ store, registry, logger: silentLogger, clock });
    ada = await store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'idp|ada',
      email: 'ada@example.com',
    });
    bob = await store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'idp|bob',
      email: 'bob@example.com',
    });
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

  /** The administrative entries of the trail, oldest first. */
  const adminTrail = async (): Promise<AdminAuditEntry[]> =>
    (await store.audit.list({ kind: 'admin' })).filter(
      (entry): entry is Extract<typeof entry, { kind: 'admin' }> => entry.kind === 'admin',
    );

  const reread = async (m: MissionRecord) => (await store.missions.getById(m.id))!;
  const user = (u: UserRecord): Principal => ({ kind: 'user', id: u.id });

  describe('check', () => {
    it('is grounded for the owner, whatever was accepted', async () => {
      const connection = await connect(user(ada));
      const m = await mission(ada, [connection], [READ, WRITE_PROD]);
      expect(await authority.grounds.check(m)).toEqual({ grounded: true, lost: [] });
    });

    it('is grounded for a beneficiary while the shares cover every accepted risk', async () => {
      const connection = await connect(user(ada));
      await share(connection, user(bob), [READ, WRITE_STAGING]);
      const m = await mission(bob, [connection], [WRITE_STAGING, READ]);
      expect(await authority.grounds.check(m)).toEqual({ grounded: true, lost: [] });
    });

    it('authority-lost: names the connection and the risks no longer covered', async () => {
      const connection = await connect(user(ada));
      const granted = await share(connection, user(bob), [READ, WRITE_STAGING]);
      const m = await mission(bob, [connection], [READ, WRITE_STAGING]);
      await store.shares.revoke({ connectionId: granted.connectionId, shareId: granted.id });
      await share(connection, user(bob), [READ]);
      expect(await authority.grounds.check(m)).toEqual({
        grounded: false,
        cause: 'authority-lost',
        connectionId: connection.id,
        uncovered: [WRITE_STAGING],
        lost: [],
      });
    });

    it('authority-lost: the creator dropped from the owner group that grounded the mission', async () => {
      const group = await store.groups.getOrCreate('admins', 'local', null);
      await store.groups.addMember(group.id, bob.id);
      const connection = await connect({ kind: 'group', id: group.id });
      const m = await mission(bob, [connection], [READ]);
      expect(await authority.grounds.check(m)).toEqual({ grounded: true, lost: [] });
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
        lost: [{ connectionId: connection.id, cause: 'connection-revoked', uncovered: [READ] }],
      });
    });

    it('stays grounded on an expired or an unowned connection: neither removes an authority', async () => {
      const group = await store.groups.getOrCreate('admins', 'local', null);
      await store.groups.addMember(group.id, ada.id);
      const connection = await connect({ kind: 'group', id: group.id });
      await share(connection, user(bob), [READ]);
      const m = await mission(bob, [connection], [READ]);

      await store.groups.removeMember(group.id, ada.id);
      await store.connections.markOwnerlessUnowned();
      expect((await store.connections.getById(connection.id))?.status).toBe('unowned');
      expect(await authority.grounds.check(m)).toEqual({ grounded: true, lost: [] });

      await store.connections.markExpired(connection.id);
      expect(await authority.grounds.check(m)).toEqual({ grounded: true, lost: [] });
    });

    it('connection-missing: a connection of the mission is no longer in the store', async () => {
      const connection = await connect(user(ada));
      const m = await mission(ada, [connection], [READ]);
      const grounds = new MissionGrounds({
        authority: authority.service,
        missions: store.missions,
        connections: { getById: async () => null },
        audit: store.audit,
        clock,
        logger: silentLogger,
      });
      expect(await grounds.check(m)).toEqual({
        grounded: false,
        cause: 'connection-missing',
        connectionId: connection.id,
        uncovered: [],
        lost: [{ connectionId: connection.id, cause: 'connection-missing', uncovered: [] }],
      });
      expect((await grounds.inspect(m)).orphan?.cause).toBe('connection-missing');
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
        lost: [],
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
      expect(await authority.grounds.check(m)).toEqual({ grounded: true, lost: [] });

      // A share of one connection never covers the risks of another: its revocation
      // takes that connection's part, and the other part still serves.
      const [granted] = await store.shares.listForConnection(other.id);
      await store.shares.revoke({ connectionId: granted!.connectionId, shareId: granted!.id });
      expect(await authority.grounds.check(m)).toEqual({
        grounded: true,
        lost: [{ connectionId: other.id, cause: 'access-withdrawn', uncovered: [OTHER_READ] }],
      });
    });
  });

  describe('a lost connection takes its part only (amendment 2026-10-21)', () => {
    it('a revoked connection of a multi-connection mission is lost; the mission still serves', async () => {
      const acme = await connect(user(ada));
      const other = await connect(user(ada), 'other');
      const m = await mission(ada, [acme, other], [READ, OTHER_READ]);
      await store.connections.revoke(acme.id);

      expect(await authority.grounds.check(m)).toEqual({
        grounded: true,
        lost: [{ connectionId: acme.id, cause: 'connection-revoked', uncovered: [READ] }],
      });
      const inspected = await authority.grounds.inspect(m);
      expect(inspected.mission.status).toBe('active');
      expect(inspected.orphan).toBeNull();
      expect(inspected.lost.map((p) => p.connectionId)).toEqual([acme.id]);
    });

    it('a mission whose every connection is revoked is orphaned, for good', async () => {
      const acme = await connect(user(ada));
      const other = await connect(user(ada), 'other');
      const m = await mission(ada, [acme, other], [READ, OTHER_READ]);
      await store.connections.revoke(acme.id);
      await store.connections.revoke(other.id);
      expect(await authority.grounds.check(m)).toMatchObject({
        grounded: false,
        cause: 'connection-revoked',
        connectionId: acme.id,
      });
    });

    it('a mission whose last part is a withdrawn access is orphaned, and may come back', async () => {
      const acme = await connect(user(ada));
      const other = await connect(user(ada), 'other');
      await share(acme, user(bob), [READ]);
      const granted = await share(other, user(bob), [OTHER_READ]);
      const m = await mission(bob, [acme, other], [READ, OTHER_READ]);
      await store.connections.revoke(acme.id);
      await store.shares.revoke({ connectionId: granted.connectionId, shareId: granted.id });
      expect(await authority.grounds.check(m)).toMatchObject({
        grounded: false,
        cause: 'authority-lost',
        connectionId: other.id,
        uncovered: [OTHER_READ],
      });
    });

    it('a share narrowed under one connection still orphans the whole mission', async () => {
      const acme = await connect(user(ada));
      const other = await connect(user(ada), 'other');
      const granted = await share(acme, user(bob), [READ, WRITE_STAGING]);
      await share(other, user(bob), [OTHER_READ]);
      const m = await mission(bob, [acme, other], [READ, WRITE_STAGING, OTHER_READ]);
      await store.shares.revoke({ connectionId: granted.connectionId, shareId: granted.id });
      await share(acme, user(bob), [READ]);
      expect(await authority.grounds.check(m)).toEqual({
        grounded: false,
        cause: 'authority-lost',
        connectionId: acme.id,
        uncovered: [WRITE_STAGING],
        lost: [],
      });
    });

    it('a removed creator orphans the whole mission, whatever still serves', async () => {
      const acme = await connect(user(ada));
      const other = await connect(user(ada), 'other');
      const m = await mission(ada, [acme, other], [READ, OTHER_READ]);
      await store.connections.revoke(acme.id);
      await store.users.markRemoved(ada.id);
      expect(await authority.grounds.check(m)).toMatchObject({
        grounded: false,
        cause: 'creator-removed',
        lost: [{ connectionId: acme.id, cause: 'connection-revoked' }],
      });
    });

    it('the revocation is audited as the connection the mission lost, naming the owner who revoked', async () => {
      const acme = await connect(user(ada));
      const other = await connect(user(ada), 'other');
      const m = await mission(ada, [acme, other], [READ, OTHER_READ]);

      const watch = await authority.grounds.watchConnection(acme.id);
      await store.connections.revoke(acme.id);
      const shift = await watch.settle(ada.id);

      expect(shift).toEqual({
        orphaned: [],
        restored: [],
        partsLost: [expect.objectContaining({ id: m.id })],
        partsRestored: [],
      });
      expect(await adminTrail()).toEqual([
        expect.objectContaining({
          user_id: ada.id,
          act: 'mission-connection-lost',
          object: { type: 'mission', id: m.id },
          before: { status: 'active', lost: [] },
          after: {
            status: 'active',
            lost: [{ connection_id: acme.id, cause: 'connection-revoked' }],
            newly_lost: [{ connection_id: acme.id, cause: 'connection-revoked' }],
          },
        }),
      ]);
    });

    it('a withdrawn access comes back with a new share; a later revocation is a new loss', async () => {
      const acme = await connect(user(ada));
      const other = await connect(user(ada), 'other');
      await share(acme, user(bob), [READ]);
      const granted = await share(other, user(bob), [OTHER_READ]);
      const m = await mission(bob, [acme, other], [READ, OTHER_READ]);

      const revoking = await authority.grounds.watchConnection(other.id);
      await store.shares.revoke({ connectionId: granted.connectionId, shareId: granted.id });
      expect((await revoking.settle(ada.id)).partsLost.map((x) => x.id)).toEqual([m.id]);

      const supposed = { connectionId: other.id, target: user(bob), restriction: [OTHER_READ] };
      expect((await authority.grounds.forecastShare(supposed)).map((x) => x.id)).toEqual([m.id]);

      const sharing = await authority.grounds.watchConnection(other.id);
      await share(other, user(bob), [OTHER_READ]);
      expect((await sharing.settle(ada.id)).partsRestored.map((x) => x.id)).toEqual([m.id]);
      expect(await authority.grounds.check(m)).toEqual({ grounded: true, lost: [] });

      const disconnecting = await authority.grounds.watchConnection(other.id);
      await store.connections.revoke(other.id);
      expect((await disconnecting.settle(ada.id)).partsLost.map((x) => x.id)).toEqual([m.id]);

      expect((await adminTrail()).map((e) => [e.act, e.user_id])).toEqual([
        ['mission-connection-lost', ada.id],
        ['mission-connection-restored', ada.id],
        ['mission-connection-lost', ada.id],
      ]);
    });
  });

  describe('inspect / derive — what every reader sees', () => {
    it('returns a grounded mission untouched, with no reason', async () => {
      const connection = await connect(user(ada));
      const m = await mission(ada, [connection], [READ]);
      expect(await authority.grounds.inspect(m)).toEqual({ mission: m, orphan: null, lost: [] });
      expect(await authority.grounds.derive(m)).toBe(m);
    });

    it('reads an ungrounded mission orphaned with the reason, and writes nothing: no status, no admin entry', async () => {
      const connection = await connect(user(ada));
      const granted = await share(connection, user(bob), [READ]);
      const m = await mission(bob, [connection], [READ]);
      await store.shares.revoke({ connectionId: granted.connectionId, shareId: granted.id });

      const inspected = await authority.grounds.inspect(m);
      expect(inspected.mission).toEqual({ ...m, status: 'orphaned' });
      expect(inspected.orphan).toEqual({
        cause: 'authority-lost',
        connectionId: connection.id,
        uncovered: [READ],
      });
      // No human is behind a read: the store still holds `active`, untouched.
      expect(await reread(m)).toEqual(m);
      expect(await adminTrail()).toEqual([]);
    });

    it('is reversible: the same mission reads active again once the authority is back', async () => {
      const connection = await connect(user(ada));
      const granted = await share(connection, user(bob), [READ]);
      const m = await mission(bob, [connection], [READ]);
      await store.shares.revoke({ connectionId: granted.connectionId, shareId: granted.id });
      expect((await authority.grounds.derive(m)).status).toBe('orphaned');

      await share(connection, user(bob), [READ]);
      expect(await authority.grounds.derive(await reread(m))).toEqual(m);
      expect(await adminTrail()).toEqual([]);
    });

    it('stays orphaned on a revoked connection whatever is shared afterwards', async () => {
      const connection = await connect(user(ada));
      await share(connection, user(bob), [READ]);
      const m = await mission(bob, [connection], [READ]);
      await store.connections.revoke(connection.id);
      await share(connection, user(bob), [READ, WRITE_STAGING]);
      expect((await authority.grounds.inspect(m)).orphan?.cause).toBe('connection-revoked');
    });

    it('never checks a mission the store does not hold as active', async () => {
      const connection = await connect(user(ada));
      const m = await mission(ada, [connection], [READ]);
      const revoked = await store.missions.setStatus(m.id, 'revoked');
      await store.connections.revoke(connection.id);
      expect(await authority.grounds.inspect(revoked)).toEqual({
        mission: revoked,
        orphan: null,
        lost: [],
      });
      const expired = await store.missions.setStatus(m.id, 'expired');
      expect(await authority.grounds.derive(expired)).toBe(expired);
    });
  });

  describe('watches — around the human act that removed or returned an authority', () => {
    it('watchConnection audits the missions the act orphaned, naming the actor, and stores nothing', async () => {
      const connection = await connect(user(ada));
      const elsewhere = await connect(user(ada));
      const granted = await share(connection, user(bob), [READ]);
      await share(elsewhere, user(bob), [READ]);
      const lost = await mission(bob, [connection], [READ]);
      const owners = await mission(ada, [connection], [READ]);
      await mission(bob, [elsewhere], [READ]);

      const watch = await authority.grounds.watchConnection(connection.id);
      await store.shares.revoke({ connectionId: granted.connectionId, shareId: granted.id });
      const shift = await watch.settle(ada.id);

      expect(shift.orphaned.map((m) => m.id)).toEqual([lost.id]);
      expect(shift.orphaned[0]?.status).toBe('orphaned');
      expect(shift.restored).toEqual([]);
      expect((await reread(lost)).status).toBe('active');
      expect((await authority.grounds.derive(await reread(owners))).status).toBe('active');
      expect(await adminTrail()).toEqual([
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
            lost: [{ connection_id: connection.id, cause: 'access-withdrawn' }],
          },
        }),
      ]);
    });

    it('watchConnection audits the missions the act restored, with the cause they were orphaned for', async () => {
      const connection = await connect(user(ada));
      const granted = await share(connection, user(bob), [READ]);
      const m = await mission(bob, [connection], [READ]);
      await store.shares.revoke({ connectionId: granted.connectionId, shareId: granted.id });

      const watch = await authority.grounds.watchConnection(connection.id);
      await share(connection, user(bob), [READ]);
      const shift = await watch.settle(ada.id);

      expect(shift.orphaned).toEqual([]);
      expect(shift.restored.map((x) => x.id)).toEqual([m.id]);
      expect(shift.restored[0]?.status).toBe('active');
      expect(await adminTrail()).toEqual([
        expect.objectContaining({
          user_id: ada.id,
          act: 'mission-restored',
          object: { type: 'mission', id: m.id },
          before: {
            status: 'orphaned',
            cause: 'authority-lost',
            connection_id: connection.id,
            uncovered: [READ],
            lost: [{ connection_id: connection.id, cause: 'access-withdrawn' }],
          },
          after: { status: 'active' },
        }),
      ]);
    });

    it('writes nothing when the act changed no verdict, or changed it back', async () => {
      const connection = await connect(user(ada));
      const granted = await share(connection, user(bob), [READ]);
      await mission(bob, [connection], [READ]);

      const idle = await authority.grounds.watchConnection(connection.id);
      expect(await idle.settle(ada.id)).toEqual({
        orphaned: [],
        restored: [],
        partsLost: [],
        partsRestored: [],
      });

      const replaced = await authority.grounds.watchConnection(connection.id);
      await store.shares.revoke({ connectionId: granted.connectionId, shareId: granted.id });
      await share(connection, user(bob), [READ, WRITE_STAGING]);
      expect(await replaced.settle(ada.id)).toEqual({
        orphaned: [],
        restored: [],
        partsLost: [],
        partsRestored: [],
      });
      expect(await adminTrail()).toEqual([]);
    });

    it('leaves out a mission revoked during the act, and one that was not active before it', async () => {
      const connection = await connect(user(ada));
      const granted = await share(connection, user(bob), [READ]);
      const revokedMeanwhile = await mission(bob, [connection], [READ]);
      const alreadyRevoked = await mission(bob, [connection], [READ]);
      await store.missions.setStatus(alreadyRevoked.id, 'revoked');

      const watch = await authority.grounds.watchConnection(connection.id);
      await store.shares.revoke({ connectionId: granted.connectionId, shareId: granted.id });
      await store.missions.setStatus(revokedMeanwhile.id, 'revoked');
      expect(await watch.settle(ada.id)).toEqual({
        orphaned: [],
        restored: [],
        partsLost: [],
        partsRestored: [],
      });
      expect(await adminTrail()).toEqual([]);
    });

    it('watchCreator follows the missions of that user only, in both directions', async () => {
      const group = await store.groups.getOrCreate('admins', 'local', null);
      await store.groups.addMember(group.id, bob.id);
      await store.groups.addMember(group.id, ada.id);
      const connection = await connect({ kind: 'group', id: group.id });
      const bobs = await mission(bob, [connection], [READ]);
      await mission(ada, [connection], [READ]);

      const leaving = await authority.grounds.watchCreator(bob.id);
      await store.groups.removeMember(group.id, bob.id);
      expect((await leaving.settle('operator')).orphaned.map((m) => m.id)).toEqual([bobs.id]);

      const returning = await authority.grounds.watchCreator(bob.id);
      await store.groups.addMember(group.id, bob.id);
      expect((await returning.settle('operator')).restored.map((m) => m.id)).toEqual([bobs.id]);

      expect(
        (await adminTrail()).map((entry) => [entry.act, entry.user_id, entry.object.id]),
      ).toEqual([
        ['mission-orphaned', 'operator', bobs.id],
        ['mission-restored', 'operator', bobs.id],
      ]);
    });
  });

  describe('two acts under way at once — one change, one entry', () => {
    it('two watches taken before two acts record one mission-orphaned, naming the act that settled first', async () => {
      const connection = await connect(user(ada));
      const granted = await share(connection, user(bob), [READ]);
      const m = await mission(bob, [connection], [READ]);

      // Both watches see the mission grounded: the owner's revocation and Bob's sign-in.
      const revocation = await authority.grounds.watchConnection(connection.id);
      const signIn = await authority.grounds.watchCreator(bob.id);
      clock.advance(1_000);
      await store.shares.revoke({ connectionId: granted.connectionId, shareId: granted.id });
      const first = await revocation.settle(ada.id);
      clock.advance(1_000);
      // The sign-in changed nothing that mattered; it settles second.
      const second = await signIn.settle(bob.id);

      expect(first.orphaned.map((x) => x.id)).toEqual([m.id]);
      expect(second).toEqual({ orphaned: [], restored: [], partsLost: [], partsRestored: [] });
      expect((await adminTrail()).map((e) => [e.act, e.user_id, e.object.id])).toEqual([
        ['mission-orphaned', ada.id, m.id],
      ]);
    });

    it('two watches taken before two acts record one mission-restored', async () => {
      const group = await store.groups.getOrCreate('admins', 'local', null);
      const connection = await connect({ kind: 'group', id: group.id });
      await store.groups.addMember(group.id, ada.id);
      const m = await mission(bob, [connection], [READ]);

      const sharing = await authority.grounds.watchConnection(connection.id);
      const joining = await authority.grounds.watchCreator(bob.id);
      await share(connection, user(bob), [READ]);
      await store.groups.addMember(group.id, bob.id);
      const first = await sharing.settle(ada.id);
      const second = await joining.settle('operator');

      expect(first.restored.map((x) => x.id)).toEqual([m.id]);
      expect(second).toEqual({ orphaned: [], restored: [], partsLost: [], partsRestored: [] });
      expect((await adminTrail()).map((e) => [e.act, e.user_id])).toEqual([
        ['mission-restored', ada.id],
      ]);
    });

    it('an equal entry older than the watch does not hold a new change back', async () => {
      const connection = await connect(user(ada));
      const granted = await share(connection, user(bob), [READ]);
      const m = await mission(bob, [connection], [READ]);

      const revoking = await authority.grounds.watchConnection(connection.id);
      await store.shares.revoke({ connectionId: granted.connectionId, shareId: granted.id });
      await revoking.settle(ada.id);
      // The authority comes back by a path nothing watched: no `mission-restored`.
      clock.advance(60_000);
      const again = await share(connection, user(bob), [READ]);
      clock.advance(60_000);

      const second = await authority.grounds.watchConnection(connection.id);
      await store.shares.revoke({ connectionId: again.connectionId, shareId: again.id });
      expect((await second.settle(ada.id)).orphaned.map((x) => x.id)).toEqual([m.id]);
      expect((await adminTrail()).map((e) => e.act)).toEqual([
        'mission-orphaned',
        'mission-orphaned',
      ]);
    });

    it('the mirror case writes nothing: a change undone before the settlement leaves no entry of this act', async () => {
      const connection = await connect(user(ada));
      const granted = await share(connection, user(bob), [READ]);
      await mission(bob, [connection], [READ]);

      const revoking = await authority.grounds.watchConnection(connection.id);
      await store.shares.revoke({ connectionId: granted.connectionId, shareId: granted.id });
      // Another act, complete before this one settles, restores the mission.
      const restoring = await authority.grounds.watchConnection(connection.id);
      await share(connection, user(bob), [READ]);
      await restoring.settle('operator');
      expect(await revoking.settle(ada.id)).toEqual({
        orphaned: [],
        restored: [],
        partsLost: [],
        partsRestored: [],
      });
      // Known limit (single-process only): a `mission-restored` with no `mission-orphaned`.
      expect((await adminTrail()).map((e) => e.act)).toEqual(['mission-restored']);
    });
  });

  describe('MembershipSettler.watch', () => {
    it('marks the connections whose owner group emptied unowned and reports what the member lost', async () => {
      const group = await store.groups.getOrCreate('admins', 'local', null);
      await store.groups.addMember(group.id, bob.id);
      const owned = await connect({ kind: 'group', id: group.id });
      const adas = await connect(user(ada));
      const m = await mission(bob, [owned], [READ]);

      const watch = await authority.membership.watch(bob.id);
      await store.groups.removeMember(group.id, bob.id);
      const settlement = await watch.settle('operator');

      expect(settlement.unowned.map((c) => c.id)).toEqual([owned.id]);
      expect(settlement.orphaned.map((x) => x.id)).toEqual([m.id]);
      expect(settlement.restored).toEqual([]);
      expect((await store.connections.getById(owned.id))?.status).toBe('unowned');
      expect((await store.connections.getById(adas.id))?.status).toBe('active');
    });

    it('reports the missions a regained membership grounds again', async () => {
      const group = await store.groups.getOrCreate('admins', 'local', null);
      await store.groups.addMember(group.id, bob.id);
      await store.groups.addMember(group.id, ada.id);
      const owned = await connect({ kind: 'group', id: group.id });
      const m = await mission(bob, [owned], [READ]);
      await store.groups.removeMember(group.id, bob.id);

      const watch = await authority.membership.watch(bob.id);
      await store.groups.addMember(group.id, bob.id);
      const settlement = await watch.settle('operator');

      expect(settlement.restored.map((x) => x.id)).toEqual([m.id]);
      expect(settlement.orphaned).toEqual([]);
      expect(settlement.unowned).toEqual([]);
    });

    it('changes nothing while the group keeps another member', async () => {
      const group = await store.groups.getOrCreate('admins', 'local', null);
      await store.groups.addMember(group.id, bob.id);
      await store.groups.addMember(group.id, ada.id);
      const owned = await connect({ kind: 'group', id: group.id });
      const watch = await authority.membership.watch(bob.id);
      await store.groups.removeMember(group.id, bob.id);
      expect(await watch.settle('operator')).toEqual({
        unowned: [],
        orphaned: [],
        restored: [],
        partsLost: [],
        partsRestored: [],
      });
      expect((await store.connections.getById(owned.id))?.status).toBe('active');
    });
  });
});
