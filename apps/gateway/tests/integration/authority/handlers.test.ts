/**
 * The HTTP acts of the feature, as a browser form posts them: share and
 * revoke a share, transfer a connection, the operator's local groups and
 * reassignment. Each answers a redirect whose `?notice=<id>` names a one-time
 * notice — never text in the URL.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../../../src/server/auth';
import { NOTICE_PARAM, type Notice } from '../../../src/server/connections';
import { enumerateCatalog } from '../../../src/server/missions';
import { selectAllIds, SHARE_FIELDS } from '../../../src/server/shares';
import type { UserRecord } from '../../../src/server/store/types';
import { authorityRig, PURGE, READ, WRITE_STAGING, type AuthorityRig } from './support';

const PUBLIC_URL = 'https://gateway.example.com';

describe('share, transfer, groups and reassignment over HTTP', () => {
  let rig: AuthorityRig;

  beforeEach(async () => {
    rig = await authorityRig();
  });
  afterEach(async () => {
    await rig.close();
  });

  async function sessionOf(user: UserRecord): Promise<string> {
    const session = await rig.root.auth.sessions.create({
      kind: 'user',
      userId: user.id,
      login: { email: user.email, groups: [] },
    });
    return session.id;
  }

  /** A same-origin form POST; `fields` may repeat a name (the ticked risks). */
  function form(path: string, sessionId: string, fields: readonly (readonly [string, string])[]) {
    return new Request(`${PUBLIC_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: PUBLIC_URL,
        cookie: `${SESSION_COOKIE}=${sessionId}`,
      },
      body: new URLSearchParams(fields.map(([k, v]) => [k, v])).toString(),
    });
  }

  /** The landing path and the notice the redirect left for that session. */
  async function landing(
    response: Response,
    sessionId: string,
  ): Promise<{ path: string; notice: Notice | null }> {
    expect(response.status).toBe(303);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const url = new URL(response.headers.get('location') ?? '', PUBLIC_URL);
    const id = url.searchParams.get(NOTICE_PARAM);
    // The URL carries the opaque id only.
    expect([...url.searchParams.keys()]).toEqual([NOTICE_PARAM]);
    return { path: url.pathname, notice: await rig.root.connections.notices.take(sessionId, id) };
  }

  const sharesPath = () => `/connections/${rig.connection.id}/shares`;

  describe('POST /connections/<id>/shares', () => {
    it('stores what "select all" resolved to: one `risk` field per ticked risk, never "all"', async () => {
      const ada = await sessionOf(rig.ada);
      const catalog = enumerateCatalog(rig.depot.plugin.catalog);
      const ticked = selectAllIds(catalog);
      const response = await rig.root.shares.handlers.share(
        form(sharesPath(), ada, [
          [SHARE_FIELDS.targetKind, 'user'],
          [SHARE_FIELDS.email, 'bob@example.com'],
          ...ticked.map((id) => [SHARE_FIELDS.risk, id] as const),
        ]),
        rig.connection.id,
      );
      const { path, notice } = await landing(response, ada);
      expect(path).toBe(`/connections/${rig.connection.id}`);
      expect(notice).toMatchObject({ tone: 'success', title: 'Shared' });
      expect(notice?.lines[0]).toContain('bob@example.com may now accept 5 risks');

      const [share] = await rig.root.store.shares.listForConnection(rig.connection.id);
      expect(share?.restriction).toEqual([...ticked].sort());
      expect(share?.restriction).not.toContain('depot.uncategorized-write');
      // A risk the catalog gains later is not covered: the rows are the list, not a rule.
      const rows = rig.root.store.db
        .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM share_restrictions')
        .get();
      expect(rows?.n).toBe(ticked.length);
    });

    it('shares to a group, then updates the same target with a narrower list', async () => {
      const ada = await sessionOf(rig.ada);
      const team = await rig.root.groups.service.create(rig.operator.id, 'team');
      const post = (risks: readonly string[]) =>
        rig.root.shares.handlers.share(
          form(sharesPath(), ada, [
            [SHARE_FIELDS.targetKind, 'group'],
            [SHARE_FIELDS.group, team.id],
            ...risks.map((id) => [SHARE_FIELDS.risk, id] as const),
          ]),
          rig.connection.id,
        );
      expect((await landing(await post([READ, PURGE]), ada)).notice?.title).toBe('Shared');
      const updated = await landing(await post([READ]), ada);
      expect(updated.notice).toMatchObject({ title: 'Share updated' });
      expect(updated.notice?.lines).toContain('This replaces the restriction they held before.');
    });

    it.each([
      ['nothing ticked', [], 'Tick at least one risk'],
      ['the literal "all"', ['all'], 'not in this provider'],
      ['a wildcard', ['depot.*'], 'not in this provider'],
    ])('refuses %s and lands back on the dialog', async (_case, risks, sentence) => {
      const ada = await sessionOf(rig.ada);
      const response = await rig.root.shares.handlers.share(
        form(sharesPath(), ada, [
          [SHARE_FIELDS.targetKind, 'user'],
          [SHARE_FIELDS.email, 'bob@example.com'],
          ...risks.map((id) => [SHARE_FIELDS.risk, id] as const),
        ]),
        rig.connection.id,
      );
      const { path, notice } = await landing(response, ada);
      expect(path).toBe(`/connections/${rig.connection.id}/share`);
      expect(notice).toMatchObject({ tone: 'danger', title: 'Not shared' });
      expect(notice?.lines.join(' ')).toContain(sentence);
      expect(await rig.root.store.shares.listForConnection(rig.connection.id)).toEqual([]);
    });

    it('tells someone who does not own the connection that it does not exist', async () => {
      const bob = await sessionOf(rig.bob);
      const response = await rig.root.shares.handlers.share(
        form(sharesPath(), bob, [
          [SHARE_FIELDS.targetKind, 'user'],
          [SHARE_FIELDS.email, 'ops@example.com'],
          [SHARE_FIELDS.risk, READ],
        ]),
        rig.connection.id,
      );
      const { path, notice } = await landing(response, bob);
      expect(path).toBe('/connections');
      expect(notice?.tone).toBe('danger');
      expect(await rig.root.store.shares.listForConnection(rig.connection.id)).toEqual([]);
    });
  });

  it('POST …/shares/<id>/revoke tells how many missions were orphaned', async () => {
    const ada = await sessionOf(rig.ada);
    const { share } = await rig.root.shares.service.share(
      await rig.actor(rig.ada),
      rig.connection.id,
      { target: { kind: 'user', email: 'bob@example.com' }, riskIds: [READ, WRITE_STAGING] },
    );
    await rig.issueFor(rig.bob, [READ]);
    const response = await rig.root.shares.handlers.revoke(
      form(`${sharesPath()}/${share.id}/revoke`, ada, []),
      rig.connection.id,
      share.id,
    );
    const { path, notice } = await landing(response, ada);
    expect(path).toBe(`/connections/${rig.connection.id}`);
    expect(notice).toMatchObject({ tone: 'success', title: 'Share revoked' });
    expect(notice?.lines.join(' ')).toContain('1 mission that depended on it is now orphaned');
  });

  it('POST /connections/<id>/transfer moves the ownership to a group of the owner, and to no other', async () => {
    const ada = await sessionOf(rig.ada);
    const mine = await rig.root.groups.service.create(rig.operator.id, 'mine');
    const theirs = await rig.root.groups.service.create(rig.operator.id, 'theirs');
    await rig.root.groups.service.addMember(rig.operator.id, mine.id, 'ada@example.com');
    const post = (groupId: string) =>
      rig.root.connections.handlers.transfer(
        form(`/connections/${rig.connection.id}/transfer`, ada, [['group_id', groupId]]),
        rig.connection.id,
      );

    const refused = await landing(await post(theirs.id), ada);
    expect(refused.notice).toMatchObject({ tone: 'danger', title: 'Not transferred' });
    expect(refused.notice?.lines[0]).toContain('a group you belong to');

    const done = await landing(await post(mine.id), ada);
    expect(done.notice).toMatchObject({ tone: 'success', title: 'Transferred to group mine' });
    expect((await rig.root.store.connections.getById(rig.connection.id))?.owner).toEqual({
      kind: 'group',
      id: mine.id,
    });
  });

  describe('Administration', () => {
    it('creates a local group, adds and removes a member, and reassigns the connection it left ownerless', async () => {
      const ops = await sessionOf(rig.operator);
      const { groups, connections } = rig.root;

      const created = await landing(
        await groups.handlers.create(form('/admin/groups/create', ops, [['name', 'depot-admins']])),
        ops,
      );
      expect(created).toMatchObject({
        path: '/admin/groups',
        notice: { tone: 'success', title: 'Group "depot-admins" created' },
      });
      const group = (await rig.root.store.groups.getByName('depot-admins'))!;

      const added = await landing(
        await groups.handlers.addMember(
          form(`/admin/groups/${group.id}/members`, ops, [['email', 'ada@example.com']]),
          group.id,
        ),
        ops,
      );
      expect(added.notice?.title).toBe('ada@example.com added to "depot-admins"');

      await connections.service.transfer(await rig.actor(rig.ada), rig.connection.id, group.id);
      const removed = await landing(
        await groups.handlers.removeMember(
          form(`/admin/groups/${group.id}/members/${rig.ada.id}/remove`, ops, []),
          group.id,
          rig.ada.id,
        ),
        ops,
      );
      expect(removed.notice).toMatchObject({
        tone: 'warning',
        title: 'ada@example.com removed from "depot-admins"',
      });
      expect(removed.notice?.lines.join(' ')).toContain('1 connection has no owner left');

      const reassigned = await landing(
        await connections.handlers.reassign(
          form(`/admin/connections/${rig.connection.id}/reassign`, ops, [
            ['owner_kind', 'user'],
            ['owner_email', 'bob@example.com'],
          ]),
          rig.connection.id,
        ),
        ops,
      );
      expect(reassigned).toMatchObject({
        path: '/admin/connections',
        notice: { tone: 'success', title: 'Depot main: owner reassigned' },
      });
      expect(await rig.root.store.connections.getById(rig.connection.id)).toMatchObject({
        status: 'active',
        owner: { kind: 'user', id: rig.bob.id },
      });
    });

    it('lets the bootstrap operator keep groups too, audited under the bootstrap actor', async () => {
      const session = await rig.root.auth.sessions.create({ kind: 'bootstrap' });
      const response = await rig.root.groups.handlers.create(
        form('/admin/groups/create', session.id, [['name', 'early']]),
      );
      expect((await landing(response, session.id)).notice?.tone).toBe('success');
      expect((await rig.adminEntries('group-created'))[0]?.user_id).toBe('bootstrap');
    });

    it('refuses a plain user on every operator act, and reassigns nothing that has an owner', async () => {
      const bob = await sessionOf(rig.bob);
      const { groups, connections } = rig.root;
      const refusals = [
        await groups.handlers.create(form('/admin/groups/create', bob, [['name', 'mine']])),
        await groups.handlers.addMember(form('/admin/groups/x/members', bob, []), 'x'),
        await groups.handlers.removeMember(
          form('/admin/groups/x/members/y/remove', bob, []),
          'x',
          'y',
        ),
        await connections.handlers.reassign(
          form(`/admin/connections/${rig.connection.id}/reassign`, bob, [
            ['owner_kind', 'user'],
            ['owner_email', 'bob@example.com'],
          ]),
          rig.connection.id,
        ),
      ];
      expect(refusals.map((r) => r.status)).toEqual([403, 403, 403, 403]);
      expect(await rig.root.store.groups.list()).toEqual([]);

      // The operator themselves cannot take a connection that has an owner.
      const ops = await sessionOf(rig.operator);
      const owned = await landing(
        await connections.handlers.reassign(
          form(`/admin/connections/${rig.connection.id}/reassign`, ops, [
            ['owner_kind', 'user'],
            ['owner_email', 'ops@example.com'],
          ]),
          rig.connection.id,
        ),
        ops,
      );
      expect(owned.notice).toMatchObject({ tone: 'danger', title: 'Not reassigned' });
      expect((await rig.root.store.connections.getById(rig.connection.id))?.owner).toEqual({
        kind: 'user',
        id: rig.ada.id,
      });
    });
  });
});
