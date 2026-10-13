/**
 * A share that would bring orphaned missions back names them before it is made
 * (spec §2.3; product owner's decision of 2026-10-13).
 *
 *   - the forecast is exact: the missions the share restores are the ones it names,
 *     under the union of the creator's other shares, for a user or a group target;
 *   - it reads only: no share, no entry, no change of state;
 *   - over HTTP the first post stores nothing and comes back to the dialog; the share
 *     is made by the post that carries every mission it would restore.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../../../src/server/auth';
import { NOTICE_PARAM } from '../../../src/server/connections';
import { SHARE_CONFIRM_PARAM, SHARE_FIELDS, type ShareInput } from '../../../src/server/shares';
import type { UserRecord } from '../../../src/server/store/types';
import { authorityRig, PURGE, READ, WRITE_STAGING, type AuthorityRig } from './support';

const PUBLIC_URL = 'https://gateway.example.com';

const toBob = (riskIds: readonly string[]): ShareInput => ({
  target: { kind: 'user', email: 'bob@example.com' },
  riskIds,
});

describe('a share that would bring orphaned missions back', () => {
  let rig: AuthorityRig;

  beforeEach(async () => {
    rig = await authorityRig();
  });
  afterEach(async () => {
    await rig.close();
  });

  const ada = () => rig.actor(rig.ada);
  const share = async (input: ShareInput) =>
    rig.root.shares.service.share(await ada(), rig.connection.id, input);
  const forecast = async (input: ShareInput) =>
    rig.root.shares.service.forecast(await ada(), rig.connection.id, input);
  const activeShares = async () =>
    (await rig.root.store.shares.listForConnection(rig.connection.id)).filter(
      (s) => s.status === 'active',
    );

  /** Bob holds two missions, then loses the share that grounded them. */
  async function orphanTwo() {
    const { share: first } = await share(toBob([READ, WRITE_STAGING]));
    const reader = await rig.issueFor(rig.bob, [READ]);
    const writer = await rig.issueFor(rig.bob, [READ, WRITE_STAGING]);
    await rig.root.shares.service.revoke(await ada(), first.id);
    expect(await rig.statusOf(reader)).toBe('orphaned');
    expect(await rig.statusOf(writer)).toBe('orphaned');
    return { reader, writer };
  }

  describe('the forecast', () => {
    it('names exactly the missions the share would ground again, with who issued them', async () => {
      const { reader, writer } = await orphanTwo();

      const narrow = await forecast(toBob([READ]));
      expect(narrow.targetLabel).toBe('bob@example.com');
      expect(narrow.restriction).toEqual([READ]);
      expect(narrow.restores).toEqual([
        { id: reader.mission.id, name: reader.mission.name, creatorLabel: 'bob@example.com' },
      ]);

      const wide = await forecast(toBob([WRITE_STAGING, READ]));
      expect(wide.restores.map((m) => m.id).sort()).toEqual(
        [reader.mission.id, writer.mission.id].sort(),
      );
      // A share that covers none of what they accepted brings nothing back.
      expect((await forecast(toBob([PURGE]))).restores).toEqual([]);
    });

    it('is what the share then does', async () => {
      const { reader, writer } = await orphanTwo();
      const told = await forecast(toBob([READ]));
      const outcome = await share(toBob([READ]));
      expect(outcome.restored).toBe(told.restores.length);
      expect(await rig.statusOf(reader)).toBe('active');
      expect(await rig.statusOf(writer)).toBe('orphaned');
    });

    it('reads only: no share, no entry, no mission changes state', async () => {
      const { reader } = await orphanTwo();
      const adminCount = async () => (await rig.root.store.audit.list({ kind: 'admin' })).length;
      const entriesBefore = await adminCount();
      await forecast(toBob([READ, WRITE_STAGING]));
      expect(await activeShares()).toEqual([]);
      expect(await adminCount()).toBe(entriesBefore);
      expect(await rig.statusOf(reader)).toBe('orphaned');
      expect(await rig.adminEntries('mission-restored')).toEqual([]);
    });

    it('counts the union with the shares the creator still receives', async () => {
      const team = await rig.root.groups.service.create(rig.operator.id, 'depot-team');
      await rig.root.groups.service.addMember(rig.operator.id, team.id, 'bob@example.com');
      await share({ target: { kind: 'group', groupId: team.id }, riskIds: [READ] });
      const { share: direct } = await share(toBob([WRITE_STAGING]));
      const mission = await rig.issueFor(rig.bob, [READ, WRITE_STAGING]);
      await rig.root.shares.service.revoke(await ada(), direct.id);
      expect(await rig.statusOf(mission)).toBe('orphaned');

      // The group share still gives the read half: the missing half alone restores it.
      expect((await forecast(toBob([WRITE_STAGING]))).restores.map((m) => m.id)).toEqual([
        mission.mission.id,
      ]);
    });

    it('supposes the share in place of the one its target holds, not beside it', async () => {
      await share(toBob([READ]));
      const { share: toTeam } = await (async () => {
        const team = await rig.root.groups.service.create(rig.operator.id, 'depot-team');
        await rig.root.groups.service.addMember(rig.operator.id, team.id, 'bob@example.com');
        return share({ target: { kind: 'group', groupId: team.id }, riskIds: [WRITE_STAGING] });
      })();
      const mission = await rig.issueFor(rig.bob, [READ, WRITE_STAGING]);
      await rig.root.shares.service.revoke(await ada(), toTeam.id);
      expect(await rig.statusOf(mission)).toBe('orphaned');

      // Replacing Bob's share by the write half alone drops the read half he holds.
      expect((await forecast(toBob([WRITE_STAGING]))).restores).toEqual([]);
      expect((await forecast(toBob([READ, WRITE_STAGING]))).restores.map((m) => m.id)).toEqual([
        mission.mission.id,
      ]);
    });

    it('reaches the members of a group target, and nobody else', async () => {
      const { reader } = await orphanTwo();
      const team = await rig.root.groups.service.create(rig.operator.id, 'depot-team');
      const toTeam: ShareInput = { target: { kind: 'group', groupId: team.id }, riskIds: [READ] };
      expect((await forecast(toTeam)).restores).toEqual([]);
      await rig.root.groups.service.addMember(rig.operator.id, team.id, 'bob@example.com');
      expect((await forecast(toTeam)).restores.map((m) => m.id)).toEqual([reader.mission.id]);
    });

    it('leaves out the missions the store holds as revoked, and refuses what a share refuses', async () => {
      const { reader, writer } = await orphanTwo();
      await rig.root.store.missions.setStatus(writer.mission.id, 'revoked');
      expect((await forecast(toBob([READ, WRITE_STAGING]))).restores.map((m) => m.id)).toEqual([
        reader.mission.id,
      ]);

      await expect(forecast(toBob([]))).rejects.toMatchObject({ code: 'restriction-empty' });
      await expect(forecast(toBob(['depot.*']))).rejects.toMatchObject({ code: 'risk-unknown' });
      await expect(
        rig.root.shares.service.forecast(
          await rig.actor(rig.bob),
          rig.connection.id,
          toBob([READ]),
        ),
      ).rejects.toMatchObject({ code: 'not-found' });
    });
  });

  describe('POST /accounts/<id>/shares', () => {
    async function sessionOf(user: UserRecord): Promise<string> {
      const session = await rig.root.auth.sessions.create({
        kind: 'user',
        userId: user.id,
        login: { email: user.email, groups: [] },
      });
      return session.id;
    }

    function post(sessionId: string, risks: readonly string[], restores: readonly string[] = []) {
      const fields: [string, string][] = [
        [SHARE_FIELDS.targetKind, 'user'],
        [SHARE_FIELDS.email, 'bob@example.com'],
        ...risks.map((id): [string, string] => [SHARE_FIELDS.risk, id]),
        ...restores.map((id): [string, string] => [SHARE_FIELDS.restore, id]),
      ];
      return rig.root.shares.handlers.share(
        new Request(`${PUBLIC_URL}/accounts/${rig.connection.id}/shares`, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            origin: PUBLIC_URL,
            cookie: `${SESSION_COOKIE}=${sessionId}`,
          },
          body: new URLSearchParams(fields).toString(),
        }),
        rig.connection.id,
      );
    }

    function locationOf(response: Response): URL {
      expect(response.status).toBe(303);
      expect(response.headers.get('cache-control')).toBe('no-store');
      return new URL(response.headers.get('location') ?? '', PUBLIC_URL);
    }

    it('does not share on the first post: it comes back to the dialog, which holds what was asked', async () => {
      const { reader } = await orphanTwo();
      const session = await sessionOf(rig.ada);

      const url = locationOf(await post(session, [READ]));
      expect(url.pathname).toBe(`/accounts/${rig.connection.id}/share`);
      // The URL carries an opaque id, nothing of the share.
      expect([...url.searchParams.keys()]).toEqual([SHARE_CONFIRM_PARAM]);
      expect(await activeShares()).toEqual([]);
      expect(await rig.statusOf(reader)).toBe('orphaned');

      const id = url.searchParams.get(SHARE_CONFIRM_PARAM);
      expect(await rig.root.shares.pending.read(session, id)).toEqual({
        connectionId: rig.connection.id,
        input: toBob([READ]),
      });
      // Read as often as the page is loaded, and by that session only.
      expect(await rig.root.shares.pending.read(session, id)).not.toBeNull();
      expect(await rig.root.shares.pending.read(await sessionOf(rig.bob), id)).toBeNull();
      expect(await rig.root.shares.pending.read(session, 'not-an-id')).toBeNull();
    });

    it('shares on the post that carries every mission it would restore', async () => {
      const { reader } = await orphanTwo();
      const session = await sessionOf(rig.ada);

      const url = locationOf(await post(session, [READ], [reader.mission.id]));
      expect(url.pathname).toBe(`/accounts/${rig.connection.id}`);
      const notice = await rig.root.connections.notices.take(
        session,
        url.searchParams.get(NOTICE_PARAM),
      );
      expect(notice).toMatchObject({ tone: 'success', title: 'Access given' });
      expect(notice?.lines.join(' ')).toContain('1 stopped mission is covered again');
      expect((await activeShares()).map((s) => s.restriction)).toEqual([[READ]]);
      expect(await rig.statusOf(reader)).toBe('active');
      expect((await rig.read(reader)).result).toBeDefined();
    });

    it('comes back again when a mission it would restore was not among the ones read', async () => {
      const { reader, writer } = await orphanTwo();
      const session = await sessionOf(rig.ada);

      // The owner read one mission; the share asked would bring two back.
      const url = locationOf(await post(session, [READ, WRITE_STAGING], [reader.mission.id]));
      expect(url.searchParams.has(SHARE_CONFIRM_PARAM)).toBe(true);
      expect(await activeShares()).toEqual([]);
      expect(await rig.statusOf(writer)).toBe('orphaned');
      // An id that names nothing confirms nothing.
      const again = locationOf(await post(session, [READ], ['someone-else']));
      expect(again.searchParams.has(SHARE_CONFIRM_PARAM)).toBe(true);
      expect(await activeShares()).toEqual([]);
    });

    it('shares at once when nothing would come back', async () => {
      const session = await sessionOf(rig.ada);
      const url = locationOf(await post(session, [READ]));
      expect(url.pathname).toBe(`/accounts/${rig.connection.id}`);
      expect([...url.searchParams.keys()]).toEqual([NOTICE_PARAM]);
      expect((await activeShares()).length).toBe(1);
    });
  });
});
