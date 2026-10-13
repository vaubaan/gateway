/**
 * Two guarantees of the acts on a connection that hold at the write, not at a
 * read some awaits earlier (spec §2.3, §7.8):
 *
 *   - the operator's reassignment only ever lands on a connection that is
 *     ownerless at the instant of the write, and on an owner group that has a
 *     member at that instant (`ConnectionsRepo.assignOwnerlessTo`);
 *   - the missions an act orphans are recorded even when the act's own audit
 *     entry cannot be written (`watch.settle` in a `finally`).
 *
 * The interleavings are produced by hooking the one await that sits between
 * the service's checks and its write (`MissionGrounds.watchConnection`).
 */
import type { AuditEntry } from '@vaubaan/gateway-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GroupRecord } from '../../../src/server/store/types';
import { authorityRig, READ, type AuthorityRig } from '../authority/support';

describe('the operator reassigns only what is ownerless at the write', () => {
  let rig: AuthorityRig;
  let admins: GroupRecord;

  beforeEach(async () => {
    rig = await authorityRig();
    const { service } = rig.root.groups;
    admins = await service.create(rig.operator.id, 'depot-admins');
    await service.addMember(rig.operator.id, admins.id, 'ada@example.com');
    await rig.root.connections.service.transfer(
      await rig.actor(rig.ada),
      rig.connection.id,
      admins.id,
    );
    // The last member leaves: the connection is `unowned`.
    await service.removeMember(rig.operator.id, admins.id, rig.ada.id);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rig.close();
  });

  /** Runs `act` once, between the service's checks and its write. */
  function betweenCheckAndWrite(act: () => Promise<unknown>): void {
    const { grounds } = rig.root.authority;
    const watchConnection = grounds.watchConnection.bind(grounds);
    vi.spyOn(grounds, 'watchConnection').mockImplementationOnce(async (connectionId) => {
      await act();
      return watchConnection(connectionId);
    });
  }

  const connection = async () => (await rig.root.store.connections.getById(rig.connection.id))!;
  const reassign = (
    owner: Parameters<AuthorityRig['root']['connections']['service']['reassign']>[2],
  ) => rig.root.connections.service.reassign(rig.operator.id, rig.connection.id, owner);

  it('refuses when a member joined the owner group of an expired connection meanwhile', async () => {
    // Expired and ownerless: reassignable only because its owner group is empty.
    await expect(rig.root.connections.credentials.refresh(rig.connection.id)).rejects.toBeDefined();
    expect((await connection()).status).toBe('expired');
    betweenCheckAndWrite(() =>
      rig.root.groups.service.addMember(rig.operator.id, admins.id, 'ada@example.com'),
    );

    await expect(reassign({ kind: 'user', email: 'bob@example.com' })).rejects.toMatchObject({
      code: 'not-ownerless',
    });
    // The connection has an owner again and the operator did not take it.
    expect(await connection()).toMatchObject({
      status: 'expired',
      owner: { kind: 'group', id: admins.id },
    });
    expect(await rig.adminEntries('connection-reassigned')).toEqual([]);
  });

  it('refuses when the new owner group lost its last member meanwhile', async () => {
    const { service } = rig.root.groups;
    const others = await service.create(rig.operator.id, 'others');
    await service.addMember(rig.operator.id, others.id, 'bob@example.com');
    betweenCheckAndWrite(() => service.removeMember(rig.operator.id, others.id, rig.bob.id));

    await expect(reassign({ kind: 'group', groupId: others.id })).rejects.toMatchObject({
      code: 'owner-group-empty',
    });
    // Still ownerless under its emptied group: never `active` under an empty one.
    expect(await connection()).toMatchObject({
      status: 'unowned',
      owner: { kind: 'group', id: admins.id },
    });
    expect(await rig.adminEntries('connection-reassigned')).toEqual([]);
  });

  it('records the owner and the status read inside the write as the `before` of the entry', async () => {
    const reassigned = await reassign({ kind: 'user', email: 'bob@example.com' });
    expect(reassigned).toMatchObject({ status: 'active', owner: { kind: 'user', id: rig.bob.id } });
    expect(await rig.adminEntries('connection-reassigned')).toMatchObject([
      {
        user_id: rig.operator.id,
        before: { owner: { kind: 'group', id: admins.id }, status: 'unowned' },
        after: { status: 'active', owner: { kind: 'user', id: rig.bob.id } },
      },
    ]);
  });
});

describe('ConnectionsRepo.assignOwnerlessTo', () => {
  let rig: AuthorityRig;

  beforeEach(async () => {
    rig = await authorityRig();
  });
  afterEach(async () => {
    await rig.close();
  });

  it('writes nothing on a connection that has an owner, or one that is revoked', async () => {
    const { connections } = rig.root.store;
    const toBob = { kind: 'user', id: rig.bob.id } as const;
    expect(await connections.assignOwnerlessTo(rig.connection.id, toBob)).toEqual({
      outcome: 'not-ownerless',
    });
    expect((await connections.getById(rig.connection.id))?.owner).toEqual({
      kind: 'user',
      id: rig.ada.id,
    });

    await connections.revoke(rig.connection.id);
    expect(await connections.assignOwnerlessTo(rig.connection.id, toBob)).toEqual({
      outcome: 'not-ownerless',
    });
    await expect(connections.assignOwnerlessTo('nope', toBob)).rejects.toThrow(/nope/);
  });
});

describe('the missions an act orphans are recorded whatever happens to the entry of the act', () => {
  let rig: AuthorityRig;

  beforeEach(async () => {
    rig = await authorityRig();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rig.close();
  });

  it('a revocation whose own audit entry fails still writes `mission-orphaned`', async () => {
    const mission = await rig.issueFor(rig.ada, [READ]);
    const writer = rig.root.store.auditWriter;
    const write = writer.write.bind(writer);
    vi.spyOn(writer, 'write').mockImplementation(async (entry: AuditEntry) => {
      if (entry.kind === 'admin' && entry.act === 'connection-revoked') {
        throw new Error('the audit store refused the write');
      }
      return write(entry);
    });

    await expect(
      rig.root.connections.service.revoke(await rig.actor(rig.ada), rig.connection.id),
    ).rejects.toThrow(/refused the write/);

    // The revocation is committed, and the audit says why the mission stopped serving.
    expect((await rig.root.store.connections.getById(rig.connection.id))?.status).toBe('revoked');
    expect(await rig.adminEntries('mission-orphaned')).toMatchObject([
      { object: { type: 'mission', id: mission.mission.id } },
    ]);
    expect(await rig.statusOf(mission)).toBe('orphaned');
  });
});
