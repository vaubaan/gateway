/**
 * What the page of an account lists under "Missions using this account" and
 * "Who has access": two read-only views, for an owner of the connection only.
 *
 *   - `MissionService.onConnection`: every mission that carries the connection,
 *     whoever issued it, with its derived state — and nothing to anyone who does
 *     not own the connection now;
 *   - `ShareService.holders`: the owner and every active share, each with the
 *     people behind it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { line } from '../../../src/server/execution/testing';
import { isShareError } from '../../../src/server/shares';
import { authorityRig, READ, WRITE_STAGING, type AuthorityRig } from './support';

describe('what an owner reads about a connection', () => {
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
  const onConnection = (user: { id: string }) =>
    rig.root.missions.service.onConnection(user, rig.connection.id);

  describe('MissionService.onConnection', () => {
    it('lists the missions of everyone on the connection, newest first, with what each uses here', async () => {
      await shareToBob([READ]);
      const mine = await rig.issueFor(rig.ada, [READ, WRITE_STAGING], 'Ada writes', (riskId) =>
        riskId === WRITE_STAGING ? { ...line(riskId), gate: 'approval' } : line(riskId),
      );
      const theirs = await rig.issueFor(rig.bob, [READ], 'Bob reads');

      const listed = await onConnection(rig.ada);
      expect(listed.map((mission) => mission.id).sort()).toEqual(
        [mine.mission.id, theirs.mission.id].sort(),
      );
      const byId = new Map(listed.map((mission) => [mission.id, mission]));
      expect(byId.get(mine.mission.id)).toMatchObject({
        name: 'Ada writes',
        creator: { id: rig.ada.id, label: rig.ada.email },
        state: 'active',
        exhausted: 0,
        orphan_cause: null,
        permissions: 2,
        asks_first: 1,
        readable: true,
      });
      // Bob's mission: named, but its own page is not the owner's to open.
      expect(byId.get(theirs.mission.id)).toMatchObject({
        name: 'Bob reads',
        creator: { id: rig.bob.id, label: 'bob@example.com' },
        state: 'active',
        permissions: 1,
        asks_first: 0,
        readable: false,
      });
      // The resources are the explicit ids stored at issuance, all of this connection's.
      const known = new Set(
        (await rig.root.store.connections.listResources(rig.connection.id)).map((r) => r.id),
      );
      for (const mission of listed) {
        expect(mission.resource_ids.every((id) => known.has(id))).toBe(true);
      }
    });

    it('says a mission stopped for want of an owner, and why; a closed one reads stopped', async () => {
      const { share } = await shareToBob([READ]);
      const mission = await rig.issueFor(rig.bob, [READ], 'Bob reads');
      await rig.root.shares.service.revoke(await rig.actor(rig.ada), share.id);

      expect(await onConnection(rig.ada)).toMatchObject([
        { id: mission.mission.id, state: 'orphaned', orphan_cause: 'authority-lost' },
      ]);

      await rig.root.missions.service.revoke(rig.ada, mission.mission.id);
      expect(await onConnection(rig.ada)).toMatchObject([
        { id: mission.mission.id, state: 'revoked', orphan_cause: null },
      ]);
    });

    it('answers nothing to whoever does not own the connection now', async () => {
      await shareToBob([READ]);
      await rig.issueFor(rig.bob, [READ]);
      await rig.issueFor(rig.ada, [READ]);

      // Not to someone who holds an access, not to an administrator, not for an unknown id.
      expect(await onConnection(rig.bob)).toEqual([]);
      expect(await onConnection(rig.operator)).toEqual([]);
      expect(await rig.root.missions.service.onConnection(rig.ada, 'nope')).toEqual([]);
    });

    it('follows the ownership: a member of the owning group reads it, a former member does not', async () => {
      const team = await rig.root.groups.service.create(rig.operator.id, 'depot-owners');
      await rig.root.groups.service.addMember(rig.operator.id, team.id, rig.ada.email);
      await rig.root.groups.service.addMember(rig.operator.id, team.id, rig.operator.email);
      await rig.root.connections.service.transfer(
        await rig.actor(rig.ada),
        rig.connection.id,
        team.id,
      );
      await rig.issueFor(rig.ada, [READ], 'Ada reads');

      expect(await onConnection(rig.operator)).toMatchObject([{ name: 'Ada reads' }]);
      await rig.root.groups.service.removeMember(rig.operator.id, team.id, rig.operator.id);
      expect(await onConnection(rig.operator)).toEqual([]);
    });
  });

  describe('ShareService.holders', () => {
    const holders = async (user: typeof rig.ada) =>
      rig.root.shares.service.holders(await rig.actor(user), rig.connection.id);

    it('names the owner and each active share with the people behind it', async () => {
      const team = await rig.root.groups.service.create(rig.operator.id, 'finance');
      await rig.root.groups.service.addMember(rig.operator.id, team.id, rig.operator.email);
      await shareToBob([READ]);
      await rig.root.shares.service.share(await rig.actor(rig.ada), rig.connection.id, {
        target: { kind: 'group', groupId: team.id },
        riskIds: [READ, WRITE_STAGING],
      });

      const view = await holders(rig.ada);
      expect(view.owner).toMatchObject({
        kind: 'user',
        id: rig.ada.id,
        email: rig.ada.email,
        you: true,
        inactive: false,
        people: [{ id: rig.ada.id, you: true }],
      });
      expect(view.shares).toHaveLength(2);
      const [first, second] = view.shares;
      expect(first).toMatchObject({
        targetLabel: 'bob@example.com',
        holder: {
          kind: 'user',
          name: 'Bob',
          email: 'bob@example.com',
          you: false,
          people: [{ id: rig.bob.id, name: 'Bob', you: false }],
        },
        share: { restriction: [READ] },
      });
      expect(first?.givenBy).toBe(rig.ada.displayName ?? rig.ada.email);
      expect(second).toMatchObject({
        holder: {
          kind: 'group',
          name: 'finance',
          email: null,
          you: false,
          people: [{ id: rig.operator.id, name: 'Ops' }],
        },
        share: { restriction: [READ, WRITE_STAGING] },
      });
    });

    it('lists the members of the owning group, and leaves a revoked share out', async () => {
      const team = await rig.root.groups.service.create(rig.operator.id, 'depot-owners');
      await rig.root.groups.service.addMember(rig.operator.id, team.id, rig.ada.email);
      await rig.root.groups.service.addMember(rig.operator.id, team.id, rig.operator.email);
      const { share } = await shareToBob([READ]);
      await rig.root.connections.service.transfer(
        await rig.actor(rig.ada),
        rig.connection.id,
        team.id,
      );
      await rig.root.shares.service.revoke(await rig.actor(rig.ada), share.id);

      const view = await holders(rig.ada);
      expect(view.owner).toMatchObject({ kind: 'group', name: 'depot-owners', you: true });
      expect(view.owner.people.map((person) => [person.id, person.you]).sort()).toEqual(
        [
          [rig.ada.id, true],
          [rig.operator.id, false],
        ].sort(),
      );
      expect(view.shares).toEqual([]);
    });

    it('says a person who was deactivated', async () => {
      await shareToBob([READ]);
      await rig.root.users.service.deactivate(
        { actorId: rig.operator.id, userId: rig.operator.id },
        rig.bob.id,
      );
      const view = await holders(rig.ada);
      expect(view.shares[0]?.holder).toMatchObject({ kind: 'user', inactive: true });
    });

    it('is the owner’s alone: anyone else reads "not found"', async () => {
      await shareToBob([READ]);
      for (const user of [rig.bob, rig.operator]) {
        const refusal = await holders(user).then(
          () => null,
          (err: unknown) => err,
        );
        expect(isShareError(refusal, 'not-found')).toBe(true);
      }
    });
  });
});
