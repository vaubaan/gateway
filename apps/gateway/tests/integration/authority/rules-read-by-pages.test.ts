/**
 * The rules a page shows a control on are the rules the service refuses on
 * (handbook web-app, Invariants, "Everything that decides is under `src/server/`"). Each
 * rule is stated once, next to the act it guards, and the page reads it from
 * the view it already loads. These tests tie the two ends: what the reader
 * says and what the act then answers, on the same state.
 *
 *   - a revoked or unowned connection takes no owner act
 *       `ownerActRefusal` → `ShareContext.unshareable`, `transferTargets`
 *   - the gates of a revoked or orphaned mission are not edited
 *       `gateEditBlockedBy` → `MissionDetail.gates_editable`
 *   - a group without member is not named owner
 *       `ConnectionService.reassignTargets`
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ownerActRefusal } from '../../../src/server/connections';
import { gateEditBlockedBy } from '../../../src/server/missions/mission-service';
import { unshareableReason } from '../../../src/server/shares';
import { MISSION_STATUSES } from '../../../src/server/store/repositories/enums';
import type { ConnectionRecord, GroupRecord } from '../../../src/server/store/types';
import { authorityRig, READ, type AuthorityRig } from './support';

type ConnectionStatus = ConnectionRecord['status'];

/** Keyed by status: a new connection status fails to compile until it is listed here. */
const EVERY_CONNECTION_STATUS: Readonly<Record<ConnectionStatus, true>> = {
  active: true,
  expired: true,
  revoked: true,
  unowned: true,
};
const CONNECTION_STATUSES = Object.keys(EVERY_CONNECTION_STATUS) as ConnectionStatus[];

describe('the predicates, on every status', () => {
  it('a connection takes no owner act once revoked or unowned, and only then', () => {
    const refused = Object.fromEntries(
      CONNECTION_STATUSES.map((status) => [status, ownerActRefusal({ status })]),
    );
    expect(refused).toEqual({
      active: null,
      expired: null,
      revoked: 'connection-revoked',
      unowned: 'connection-unowned',
    });
    // The share codes are the connection's own.
    for (const status of CONNECTION_STATUSES) {
      expect(unshareableReason({ status })).toBe(ownerActRefusal({ status }));
    }
  });

  it('the gates of a mission are not edited once it is revoked or orphaned, and only then', () => {
    const blocked = Object.fromEntries(
      MISSION_STATUSES.map((status) => [status, gateEditBlockedBy({ status })]),
    );
    expect(blocked).toEqual({
      active: null,
      // An expired mission serves again once its creator extends the expiry (a claim's
      // `extend-expiry`): its gates stay theirs to set meanwhile.
      expired: null,
      orphaned: 'orphaned',
      revoked: 'revoked',
    });
  });
});

describe('what the page reads is what the act answers', () => {
  let rig: AuthorityRig;
  let admins: GroupRecord;

  beforeEach(async () => {
    rig = await authorityRig();
    admins = await rig.root.groups.service.create(rig.operator.id, 'depot-admins');
    await rig.root.groups.service.addMember(rig.operator.id, admins.id, 'ada@example.com');
  });
  afterEach(async () => {
    await rig.close();
  });

  const ada = () => rig.actor(rig.ada);
  const connection = async () => (await rig.root.store.connections.getById(rig.connection.id))!;
  const toBob = { target: { kind: 'user', email: 'bob@example.com' }, riskIds: [READ] } as const;

  it('an owned connection: shareable, and transferable to the groups of its owner', async () => {
    const { connections, shares } = rig.root;
    expect(
      (await shares.service.contextFor(await ada(), rig.connection.id)).unshareable,
    ).toBeNull();
    expect(
      connections.service.transferTargets(await ada(), await connection()).map((g) => g.id),
    ).toEqual([admins.id]);
    await expect(
      shares.service.share(await ada(), rig.connection.id, toBob),
    ).resolves.toBeDefined();
    await expect(
      connections.service.transfer(await ada(), rig.connection.id, admins.id),
    ).resolves.toMatchObject({ owner: { kind: 'group', id: admins.id } });
  });

  it('an unowned connection: the context names the refusal of share, and no transfer target is offered', async () => {
    const { connections, groups, shares } = rig.root;
    const others = await groups.service.create(rig.operator.id, 'others');
    await groups.service.addMember(rig.operator.id, others.id, 'ada@example.com');
    await connections.service.transfer(await ada(), rig.connection.id, admins.id);
    await groups.service.removeMember(rig.operator.id, admins.id, rig.ada.id);
    // Ada joins the emptied owner group again: she reads the connection, which stays unowned.
    await groups.service.addMember(rig.operator.id, admins.id, 'ada@example.com');
    expect((await connection()).status).toBe('unowned');

    const context = await shares.service.contextFor(await ada(), rig.connection.id);
    expect(context.unshareable).toBe('connection-unowned');
    await expect(shares.service.share(await ada(), rig.connection.id, toBob)).rejects.toMatchObject(
      {
        code: context.unshareable,
      },
    );
    // She belongs to another group, yet it is not offered: `transfer` would refuse it.
    expect(connections.service.transferTargets(await ada(), await connection())).toEqual([]);
    await expect(
      connections.service.transfer(await ada(), rig.connection.id, others.id),
    ).rejects.toMatchObject({ code: 'connection-unowned' });
  });

  it('a revoked connection: the same, with the revoked code', async () => {
    const { connections, shares } = rig.root;
    await connections.service.revoke(await ada(), rig.connection.id);

    const context = await shares.service.contextFor(await ada(), rig.connection.id);
    expect(context.unshareable).toBe('connection-revoked');
    await expect(shares.service.share(await ada(), rig.connection.id, toBob)).rejects.toMatchObject(
      {
        code: context.unshareable,
      },
    );
    expect(connections.service.transferTargets(await ada(), await connection())).toEqual([]);
    await expect(
      connections.service.transfer(await ada(), rig.connection.id, admins.id),
    ).rejects.toMatchObject({ code: 'connection-revoked' });
  });

  it('reassignTargets lists the groups reassign accepts: the ones that have a member', async () => {
    const { connections, groups } = rig.root;
    const empty = await groups.service.create(rig.operator.id, 'empty');
    const staffed = await groups.service.create(rig.operator.id, 'staffed');
    await groups.service.addMember(rig.operator.id, staffed.id, 'bob@example.com');
    await connections.service.transfer(await ada(), rig.connection.id, admins.id);
    await groups.service.removeMember(rig.operator.id, admins.id, rig.ada.id);

    // `depot-admins` just emptied: it is not offered either.
    const targets = await connections.service.reassignTargets();
    expect(targets.map((g) => g.name)).toEqual(['staffed']);
    for (const refused of [empty, admins]) {
      await expect(
        connections.service.reassign(rig.operator.id, rig.connection.id, {
          kind: 'group',
          groupId: refused.id,
        }),
      ).rejects.toMatchObject({ code: 'owner-group-empty' });
    }
    await expect(
      connections.service.reassign(rig.operator.id, rig.connection.id, {
        kind: 'group',
        groupId: targets[0]!.id,
      }),
    ).resolves.toMatchObject({ status: 'active', owner: { kind: 'group', id: staffed.id } });
  });

  it('gates_editable follows setGate: off while the mission is orphaned, back with the authority, off for good once revoked', async () => {
    const { missions, shares } = rig.root;
    const { share } = await shares.service.share(await ada(), rig.connection.id, toBob);
    const issued = await rig.issueFor(rig.bob, [READ]);
    const editable = async () =>
      (await missions.service.get(rig.bob, issued.mission.id))?.gates_editable;
    const setGate = (gate: string) =>
      missions.service.setGate(rig.bob, issued.mission.id, READ, gate);

    expect(await editable()).toBe(true);
    expect(await setGate('approval')).toMatchObject({ ok: true });

    await shares.service.revoke(await ada(), share.id);
    expect(await editable()).toBe(false);
    expect(await setGate('auto')).toEqual({ ok: false, reason: 'inactive', state: 'orphaned' });

    await shares.service.share(await ada(), rig.connection.id, toBob);
    expect(await editable()).toBe(true);
    expect(await setGate('auto')).toMatchObject({ ok: true });

    await missions.service.revoke(rig.bob, issued.mission.id);
    expect(await editable()).toBe(false);
    expect(await setGate('approval')).toEqual({ ok: false, reason: 'inactive', state: 'revoked' });
  });
});
