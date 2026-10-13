/**
 * Closing an orphaned mission (spec §2.3: "the creator, or an owner of the
 * connection, may close it").
 *
 *   - an owner of a connection the mission carries revokes it while it is orphaned,
 *     and only then: a mission that serves is its creator's alone, and reads
 *     "not found" to everyone else;
 *   - the entry names who closed it and on what ground;
 *   - a closed mission is revoked: no share brings it back;
 *   - a delegated client never acts as an owner.
 */
import { REFUSAL_RPC_CODE } from '@vaubaan/gateway-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../../../src/server/auth';
import type { UserRecord } from '../../../src/server/store/types';
import { authorityRig, READ, WRITE_STAGING, type AuthorityRig } from './support';

const PUBLIC_URL = 'https://gateway.example.com';

describe('closing an orphaned mission', () => {
  let rig: AuthorityRig;

  beforeEach(async () => {
    rig = await authorityRig();
  });
  afterEach(async () => {
    await rig.close();
  });

  const shareToBob = async (riskIds: readonly string[]) =>
    rig.root.shares.service.share(await rig.actor(rig.ada), rig.connection.id, {
      target: { kind: 'user', email: 'bob@example.com' },
      riskIds,
    });

  /** Bob's mission on Ada's connection, orphaned by the revocation of the share. */
  async function orphaned() {
    const { share } = await shareToBob([READ]);
    const mission = await rig.issueFor(rig.bob, [READ], 'Bob reads');
    await rig.root.shares.service.revoke(await rig.actor(rig.ada), share.id);
    expect(await rig.statusOf(mission)).toBe('orphaned');
    return mission;
  }

  const revoke = (user: UserRecord, missionId: string) =>
    rig.root.missions.service.revoke(user, missionId);

  it('an owner of the connection closes it: revoked, every token stopped, the entry says who and why', async () => {
    const mission = await orphaned();

    const result = await revoke(rig.ada, mission.mission.id);
    expect(result).toMatchObject({ ok: true, tokensRevoked: 1 });
    expect(await rig.storedStatusOf(mission)).toBe('revoked');
    expect(await rig.statusOf(mission)).toBe('revoked');

    const body = await rig.read(mission);
    expect(body.error?.code).toBe(REFUSAL_RPC_CODE);
    expect(body.error?.data).toMatchObject({ code: 'mission-inactive', status: 'revoked' });

    const [entry] = await rig.adminEntries('mission-revoked');
    expect(entry).toMatchObject({
      user_id: rig.ada.id,
      object: { type: 'mission', id: mission.mission.id },
      before: { status: 'orphaned' },
      after: {
        status: 'revoked',
        tokens_revoked: 1,
        closed_as: 'connection-owner',
        connection_id: rig.connection.id,
      },
      delegated_client_id: null,
    });
  });

  it('a closed mission never comes back: a share made again restores nothing', async () => {
    const mission = await orphaned();
    await revoke(rig.ada, mission.mission.id);

    const forecast = await rig.root.shares.service.forecast(
      await rig.actor(rig.ada),
      rig.connection.id,
      { target: { kind: 'user', email: 'bob@example.com' }, riskIds: [READ] },
    );
    expect(forecast.restores).toEqual([]);
    expect(await shareToBob([READ])).toMatchObject({ restored: 0 });
    expect(await rig.statusOf(mission)).toBe('revoked');
  });

  it('an owner cannot close a mission that serves, and learns nothing about it', async () => {
    await shareToBob([READ]);
    const mission = await rig.issueFor(rig.bob, [READ]);

    expect(await revoke(rig.ada, mission.mission.id)).toEqual({ ok: false, reason: 'not-found' });
    expect(await rig.statusOf(mission)).toBe('active');
    expect((await rig.read(mission)).result).toBeDefined();
    expect(await rig.adminEntries('mission-revoked')).toEqual([]);
  });

  it('someone who owns none of its connections reads "not found", orphaned or not', async () => {
    const mission = await orphaned();
    expect(await revoke(rig.operator, mission.mission.id)).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(await revoke(rig.ada, 'no-such-mission')).toEqual({ ok: false, reason: 'not-found' });
    expect(await rig.storedStatusOf(mission)).toBe('active');
  });

  it('the creator still closes it, as before, with no ground named', async () => {
    const mission = await orphaned();
    expect(await revoke(rig.bob, mission.mission.id)).toMatchObject({ ok: true });
    const [entry] = await rig.adminEntries('mission-revoked');
    expect(entry?.user_id).toBe(rig.bob.id);
    expect(entry?.after).toEqual({ status: 'revoked', tokens_revoked: 1 });
  });

  it('every member of the group that owns the connection may close it; a former member may not', async () => {
    const team = await rig.root.groups.service.create(rig.operator.id, 'depot-owners');
    await rig.root.groups.service.addMember(rig.operator.id, team.id, rig.ada.email);
    await rig.root.groups.service.addMember(rig.operator.id, team.id, rig.operator.email);
    await rig.root.connections.service.transfer(
      await rig.actor(rig.ada),
      rig.connection.id,
      team.id,
    );
    const mission = await orphaned();

    await rig.root.groups.service.removeMember(rig.operator.id, team.id, rig.ada.id);
    expect(await revoke(rig.ada, mission.mission.id)).toEqual({ ok: false, reason: 'not-found' });
    expect(await revoke(rig.operator, mission.mission.id)).toMatchObject({ ok: true });
    expect((await rig.adminEntries('mission-revoked'))[0]).toMatchObject({
      user_id: rig.operator.id,
      after: { closed_as: 'connection-owner' },
    });
  });

  it('is answered the same a second time, with nothing written again', async () => {
    const mission = await orphaned();
    await revoke(rig.ada, mission.mission.id);
    expect(await revoke(rig.ada, mission.mission.id)).toMatchObject({
      ok: true,
      tokensRevoked: 0,
    });
    expect(await rig.adminEntries('mission-revoked')).toHaveLength(1);
  });

  it('a delegated client acts for the creator only, never as an owner of the connection', async () => {
    const mission = await orphaned();
    const result = await rig.root.missions.service.revoke(rig.ada, mission.mission.id, {
      delegation: { id: 'delegation-1', clientId: 'client-1' },
    });
    expect(result).toEqual({ ok: false, reason: 'not-found' });
    expect(await rig.storedStatusOf(mission)).toBe('active');
  });

  it('closes the missions a revoked connection left orphaned', async () => {
    await shareToBob([READ, WRITE_STAGING]);
    const mission = await rig.issueFor(rig.bob, [READ, WRITE_STAGING]);
    await rig.root.connections.service.revoke(await rig.actor(rig.ada), rig.connection.id);
    expect(await rig.statusOf(mission)).toBe('orphaned');

    expect(await rig.root.missions.service.orphanedOn(rig.ada, rig.connection.id)).toEqual([
      {
        id: mission.mission.id,
        name: mission.mission.name,
        creator_label: 'bob@example.com',
        cause: 'connection-revoked',
      },
    ]);
    expect(await revoke(rig.ada, mission.mission.id)).toMatchObject({ ok: true });
    expect(await rig.root.missions.service.orphanedOn(rig.ada, rig.connection.id)).toEqual([]);
  });

  describe('what the connection page lists', () => {
    it('the orphaned missions of the connection, to its owners only, and none that serves', async () => {
      await shareToBob([READ]);
      const serving = await rig.issueFor(rig.bob, [READ], 'Serving');
      expect(await rig.root.missions.service.orphanedOn(rig.ada, rig.connection.id)).toEqual([]);

      const [share] = await rig.root.store.shares.listForConnection(rig.connection.id);
      await rig.root.shares.service.revoke(await rig.actor(rig.ada), share?.id ?? '');
      expect(await rig.root.missions.service.orphanedOn(rig.ada, rig.connection.id)).toEqual([
        {
          id: serving.mission.id,
          name: 'Serving',
          creator_label: 'bob@example.com',
          cause: 'authority-lost',
        },
      ]);
      // Not to the creator, not to a stranger, not for an unknown connection.
      expect(await rig.root.missions.service.orphanedOn(rig.bob, rig.connection.id)).toEqual([]);
      expect(await rig.root.missions.service.orphanedOn(rig.operator, rig.connection.id)).toEqual(
        [],
      );
      expect(await rig.root.missions.service.orphanedOn(rig.ada, 'nope')).toEqual([]);
    });
  });

  describe('POST /api/missions/<id>/revoke', () => {
    async function post(user: UserRecord, missionId: string): Promise<Response> {
      const session = await rig.root.auth.sessions.create({
        kind: 'user',
        userId: user.id,
        login: { email: user.email, groups: [] },
      });
      return rig.root.missions.handlers.revoke(
        new Request(`${PUBLIC_URL}/api/missions/${missionId}/revoke`, {
          method: 'POST',
          headers: { origin: PUBLIC_URL, cookie: `${SESSION_COOKIE}=${session.id}` },
        }),
        missionId,
      );
    }

    it('answers the owner of the connection 200 on an orphaned mission, and 404 on one that serves', async () => {
      const mission = await orphaned();
      const closed = await post(rig.ada, mission.mission.id);
      expect(closed.status).toBe(200);
      expect(await closed.json()).toEqual({
        mission: { id: mission.mission.id, status: 'revoked' },
      });

      await shareToBob([READ]);
      const serving = await rig.issueFor(rig.bob, [READ], 'Serving');
      const refused = await post(rig.ada, serving.mission.id);
      expect(refused.status).toBe(404);
      expect(await rig.statusOf(serving)).toBe('active');
    });
  });
});
