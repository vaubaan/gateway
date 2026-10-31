/**
 * Ownership of a connection end to end (spec §0 "Connection", §2.3 "unowned",
 * §7.2, §11.2): transfer to a group the owner belongs to, the `unowned`
 * state when that group empties — the connection keeps serving the missions
 * that still have grounds, nobody can share or reconnect it — and the
 * operator's reassignment, their only act on the domain.
 */
import { throughSecondFactor } from '../../support/auth/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SESSION_COOKIE } from '../../../src/server/auth';
import { ConnectError } from '../../../src/server/connections';
import type { GroupRecord, UserRecord } from '../../../src/server/store/types';
import { FakeIdp } from '../auth/fake-idp';
import { authorityRig, OPERATOR_EMAIL, PURGE, READ, type AuthorityRig } from './support';
import { saveTestOidcProvider } from '../../support/auth/testing';

const PUBLIC_URL = 'https://gateway.example.com';
const CLIENT = { clientId: 'vaubaan-gateway', clientSecret: 'client-secret-for-tests' };

describe('ownership: transfer, unowned, operator reassignment', () => {
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

  const transferToAdmins = async () =>
    rig.root.connections.service.transfer(await rig.actor(rig.ada), rig.connection.id, admins.id);

  it('transfers to a group the owner belongs to: every member, now and later, is a full owner', async () => {
    const transferred = await transferToAdmins();
    expect(transferred.owner).toEqual({ kind: 'group', id: admins.id });
    expect(await rig.adminEntries('connection-transferred')).toMatchObject([
      {
        user_id: rig.ada.id,
        object: { type: 'connection', id: rig.connection.id },
        before: { owner: { kind: 'user', id: rig.ada.id } },
        after: { owner: { kind: 'group', id: admins.id } },
      },
    ]);

    // Ada is still an owner (she is in the group); Bob is not, until he joins.
    const { authority } = rig.root.missions;
    const current = (await rig.root.store.connections.getById(rig.connection.id))!;
    expect((await authority.authorityOf(rig.ada, current)).basis).toBe('owner');
    expect((await authority.authorityOf(rig.bob, current)).basis).toBe('none');
    await rig.root.groups.service.addMember(rig.operator.id, admins.id, 'bob@example.com');
    expect((await authority.authorityOf(rig.bob, current)).basis).toBe('owner');
    expect(
      (await rig.root.connections.service.listFor(await rig.actor(rig.bob))).map(
        (v) => v.connection.id,
      ),
    ).toEqual([rig.connection.id]);
    // A later member issues missions on the full catalog, with no share.
    expect((await rig.read(await rig.issueFor(rig.bob, [READ, PURGE]))).result).toBeDefined();
  });

  describe('a co-owner cannot keep a share for the day they leave the group (docs/spec/vaubaan-gateway.md)', () => {
    const shareAs = async (actor: UserRecord, email: string) =>
      rig.root.shares.service.share(await rig.actor(actor), rig.connection.id, {
        target: { kind: 'user', email },
        riskIds: [READ, PURGE],
      });

    beforeEach(async () => {
      await rig.root.groups.service.addMember(rig.operator.id, admins.id, 'bob@example.com');
      await transferToAdmins();
    });

    it('refuses a share to oneself and to a fellow member, and stores nothing', async () => {
      await expect(shareAs(rig.bob, 'bob@example.com')).rejects.toMatchObject({
        code: 'target-is-owner',
      });
      // Two members cannot do it for each other either: the target owns the connection now.
      await expect(shareAs(rig.ada, 'bob@example.com')).rejects.toMatchObject({
        code: 'target-is-owner',
      });
      expect(await rig.root.store.shares.listForConnection(rig.connection.id)).toEqual([]);
      expect(await rig.adminEntries('share-created')).toEqual([]);
      // Somebody outside the group is still a target.
      expect((await shareAs(rig.bob, OPERATOR_EMAIL)).share.target).toEqual({
        kind: 'user',
        id: rig.operator.id,
      });
    });

    it('leaving the owner group therefore ends the authority: missions orphaned, no new issuance', async () => {
      await expect(shareAs(rig.bob, 'bob@example.com')).rejects.toMatchObject({
        code: 'target-is-owner',
      });
      const mission = await rig.issueFor(rig.bob, [READ]);
      expect((await rig.read(mission)).result).toBeDefined();

      await rig.root.groups.service.removeMember(rig.operator.id, admins.id, rig.bob.id);

      const current = (await rig.root.store.connections.getById(rig.connection.id))!;
      expect(await rig.root.missions.authority.authorityOf(rig.bob, current)).toMatchObject({
        basis: 'none',
        riskIds: [],
      });
      expect(await rig.statusOf(mission)).toBe('orphaned');
      expect((await rig.read(mission)).error?.data).toMatchObject({ code: 'mission-inactive' });
      expect((await rig.tryIssue(rig.bob, [READ])).ok).toBe(false);
    });

    it('a share an owner makes to a former member, after they left, is an ordinary share', async () => {
      await rig.root.groups.service.removeMember(rig.operator.id, admins.id, rig.bob.id);
      const outcome = await shareAs(rig.ada, 'bob@example.com');
      expect(outcome.share.target).toEqual({ kind: 'user', id: rig.bob.id });
      const current = (await rig.root.store.connections.getById(rig.connection.id))!;
      expect((await rig.root.missions.authority.authorityOf(rig.bob, current)).basis).toBe('share');
    });

    it('a share to a group is not refused because the sharer belongs to it', async () => {
      const team = await rig.root.groups.service.create(rig.operator.id, 'team');
      await rig.root.groups.service.addMember(rig.operator.id, team.id, 'bob@example.com');
      const outcome = await rig.root.shares.service.share(
        await rig.actor(rig.bob),
        rig.connection.id,
        { target: { kind: 'group', groupId: team.id }, riskIds: [READ] },
      );
      expect(outcome.targetLabel).toBe('group team');
    });
  });

  it('refuses a transfer to a group the owner is not in, and by anyone who is not an owner', async () => {
    const others = await rig.root.groups.service.create(rig.operator.id, 'others');
    await rig.root.groups.service.addMember(rig.operator.id, others.id, 'bob@example.com');
    const ada = await rig.actor(rig.ada);

    await expect(
      rig.root.connections.service.transfer(ada, rig.connection.id, others.id),
    ).rejects.toMatchObject({ code: 'transfer-not-member' });
    // A forged actor claiming the group does not help: Bob does not own the connection.
    await expect(
      rig.root.connections.service.transfer(await rig.actor(rig.bob), rig.connection.id, others.id),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect((await rig.root.store.connections.getById(rig.connection.id))?.owner).toEqual({
      kind: 'user',
      id: rig.ada.id,
    });
    expect(rig.root.connections.service.transferTargets(ada, rig.connection)).toEqual([
      expect.objectContaining({ id: admins.id }),
    ]);
  });

  it('becomes unowned when the owner group empties: it keeps serving, nobody shares or reconnects, the operator reassigns', async () => {
    // Bob holds a share; Ada (owner through the group) has a mission of her own.
    await rig.root.shares.service.share(await rig.actor(rig.ada), rig.connection.id, {
      target: { kind: 'user', email: 'bob@example.com' },
      riskIds: [READ],
    });
    await transferToAdmins();
    const bobs = await rig.issueFor(rig.bob, [READ], 'Shared');
    const adas = await rig.issueFor(rig.ada, [READ], 'Owner');

    // The last member leaves.
    const removal = await rig.root.groups.service.removeMember(
      rig.operator.id,
      admins.id,
      rig.ada.id,
    );
    expect(removal).toMatchObject({ unowned: 1, orphaned: 1 });
    const unowned = (await rig.root.store.connections.getById(rig.connection.id))!;
    expect(unowned.status).toBe('unowned');

    // Missions keep running where the authority is still there (the share)…
    expect((await rig.read(bobs)).result).toBeDefined();
    // …and the one grounded on the vanished ownership is orphaned (spec §2.3).
    expect(await rig.statusOf(adas)).toBe('orphaned');

    // Nobody can share, reconnect or transfer: there is no owner to do it.
    const ada = await rig.actor(rig.ada);
    await expect(rig.root.shares.service.contextFor(ada, unowned.id)).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(rig.root.connections.service.get(ada, unowned.id)).rejects.toBeInstanceOf(
      ConnectError,
    );
    expect(await rig.root.connections.service.listFor(ada)).toEqual([]);

    // The operator sees it and names a new owner.
    const ownerless = await rig.root.connections.service.listOwnerless();
    expect(ownerless.map((v) => [v.connection.id, v.owner_label])).toEqual([
      [unowned.id, 'group depot-admins'],
    ]);
    const reassigned = await rig.root.connections.service.reassign(rig.operator.id, unowned.id, {
      kind: 'user',
      email: 'ada@example.com',
    });
    expect(reassigned).toMatchObject({ status: 'active', owner: { kind: 'user', id: rig.ada.id } });
    expect(await rig.adminEntries('connection-reassigned')).toMatchObject([
      {
        user_id: rig.operator.id,
        before: { owner: { kind: 'group', id: admins.id }, status: 'unowned' },
        after: { owner: { kind: 'user', id: rig.ada.id }, status: 'active' },
      },
    ]);
    expect(await rig.root.connections.service.listOwnerless()).toEqual([]);

    // The new owner acts again; the share and its mission never stopped.
    expect((await rig.root.shares.service.contextFor(ada, unowned.id)).shares).toHaveLength(1);
    expect((await rig.read(bobs)).result).toBeDefined();
    // Ada owns the connection again: the mission her lost membership had orphaned is
    // restored by the operator's act, and its token serves again.
    expect(await rig.statusOf(adas)).toBe('active');
    expect((await rig.read(adas)).result).toBeDefined();
    expect(await rig.adminEntries('mission-restored')).toMatchObject([
      {
        user_id: rig.operator.id,
        object: { type: 'mission', id: adas.mission.id },
        before: { status: 'orphaned', cause: 'authority-lost' },
        after: { status: 'active' },
      },
    ]);
    expect((await rig.read(await rig.issueFor(rig.ada, [READ]))).result).toBeDefined();
  });

  it('reassigns only an ownerless connection, to a known user or a group that has members', async () => {
    const reassign = rig.root.connections.service.reassign.bind(rig.root.connections.service);
    const toAda = { kind: 'user', email: 'ada@example.com' } as const;
    // An owned connection is not the operator's business.
    await expect(reassign(rig.operator.id, rig.connection.id, toAda)).rejects.toMatchObject({
      code: 'not-ownerless',
    });
    await expect(reassign(rig.operator.id, 'nope', toAda)).rejects.toMatchObject({
      code: 'not-found',
    });

    await transferToAdmins();
    await rig.root.groups.service.removeMember(rig.operator.id, admins.id, rig.ada.id);
    await expect(
      reassign(rig.operator.id, rig.connection.id, { kind: 'user', email: 'ghost@example.com' }),
    ).rejects.toMatchObject({ code: 'owner-unknown' });
    // The emptied group itself is not an owner.
    await expect(
      reassign(rig.operator.id, rig.connection.id, { kind: 'group', groupId: admins.id }),
    ).rejects.toMatchObject({ code: 'owner-group-empty' });
    expect((await rig.root.store.connections.getById(rig.connection.id))?.status).toBe('unowned');

    await rig.root.groups.service.addMember(rig.operator.id, admins.id, 'bob@example.com');
    // A member came back, yet the connection stays unowned until the operator decides.
    expect((await rig.root.store.connections.getById(rig.connection.id))?.status).toBe('unowned');
    const reassigned = await reassign(rig.operator.id, rig.connection.id, {
      kind: 'group',
      groupId: admins.id,
    });
    expect(reassigned).toMatchObject({ status: 'active', owner: { kind: 'group', id: admins.id } });
  });

  it('expires an unowned connection whose credential dies; it stays reassignable and its new owner reconnects', async () => {
    await transferToAdmins();
    await rig.root.groups.service.removeMember(rig.operator.id, admins.id, rig.ada.id);
    // The provider rejects the key and the plugin cannot refresh it.
    await expect(rig.root.connections.credentials.refresh(rig.connection.id)).rejects.toBeDefined();
    expect((await rig.root.store.connections.getById(rig.connection.id))?.status).toBe('expired');

    expect(
      (await rig.root.connections.service.listOwnerless()).map((v) => v.connection.id),
    ).toEqual([rig.connection.id]);
    const reassigned = await rig.root.connections.service.reassign(
      rig.operator.id,
      rig.connection.id,
      { kind: 'user', email: 'bob@example.com' },
    );
    expect(reassigned).toMatchObject({
      status: 'expired',
      owner: { kind: 'user', id: rig.bob.id },
    });
    expect(await rig.root.connections.service.listOwnerless()).toEqual([]);
  });
});

describe('a sign-in that changes the IdP groups settles what the lost membership held', () => {
  let rig: AuthorityRig;
  let idp: FakeIdp;

  beforeEach(async () => {
    idp = new FakeIdp(CLIENT);
    rig = await authorityRig({ deps: { oidc: { fetch: idp.fetch, allowInsecureIssuer: true } } });
    await saveTestOidcProvider(rig.root.store.config, {
      issuer: idp.issuer.href,
      clientId: CLIENT.clientId,
      clientSecret: CLIENT.clientSecret,
      claims: { sub: 'sub', email: 'email', groups: 'groups' },
      allowedEmailDomains: [],
    });
  });
  afterEach(async () => {
    await rig.close();
  });

  /** The browser's round trip: /auth/login → IdP consent → /auth/callback. */
  async function signIn(claims: Record<string, unknown>): Promise<void> {
    idp.nextClaims = claims;
    const start = await rig.root.auth.handlers.loginStart(
      new Request(`${PUBLIC_URL}/auth/login?return_to=%2Fconnections`),
    );
    const cookies = start.headers
      .getSetCookie()
      .map((header) => header.split(';')[0])
      .join('; ');
    const callback = idp.authorize(new URL(start.headers.get('location') ?? ''));
    const first = await rig.root.auth.handlers.loginCallback(
      new Request(callback.href, { headers: { cookie: cookies } }),
      'idp',
    );
    // The gateway's own second factor, answered as the person's app would.
    let jar = first.headers
      .getSetCookie()
      .map((header) => header.split(';')[0])
      .join('; ');
    let sessionSet = jar.includes(`${SESSION_COOKIE}=`);
    const finish = await throughSecondFactor(rig.root, PUBLIC_URL, first, {
      cookie: () => jar,
      absorb: (r) => {
        const set = r.headers.getSetCookie().map((header) => header.split(';')[0]);
        sessionSet ||= set.some((c) => c?.startsWith(`${SESSION_COOKIE}=`) === true);
        jar = [jar, ...set].join('; ');
      },
    });
    expect(finish.status).toBe(303);
    expect(sessionSet).toBe(true);
  }

  const bobClaims = (groups: string[]) => ({ sub: 'idp|bob', email: 'bob@example.com', groups });
  const adaClaims = (groups: string[]) => ({ sub: 'idp|ada', email: 'ada@example.com', groups });

  it('orphans the missions a dropped IdP group grounded, in the name of the user who signed in', async () => {
    await signIn(bobClaims(['depot-readers']));
    const readers = (await rig.root.store.groups.getByName('depot-readers'))!;
    expect(readers.source).toBe('idp');
    await rig.root.shares.service.share(await rig.actor(rig.ada), rig.connection.id, {
      target: { kind: 'group', groupId: readers.id },
      riskIds: [READ],
    });
    const mission = await rig.issueFor(rig.bob, [READ]);

    // Same groups: nothing changes.
    await signIn(bobClaims(['depot-readers']));
    expect(await rig.statusOf(mission)).toBe('active');

    // The IdP no longer claims the group.
    await signIn(bobClaims([]));
    expect(await rig.statusOf(mission)).toBe('orphaned');
    expect(await rig.adminEntries('mission-orphaned')).toMatchObject([
      { user_id: rig.bob.id, object: { id: mission.mission.id } },
    ]);
  });

  it('a group claim missing at one sign-in is not a permanent outage: the next sign-in that carries it restores the same mission', async () => {
    await signIn(bobClaims(['depot-readers']));
    const readers = (await rig.root.store.groups.getByName('depot-readers'))!;
    await rig.root.shares.service.share(await rig.actor(rig.ada), rig.connection.id, {
      target: { kind: 'group', groupId: readers.id },
      riskIds: [READ],
    });
    const mission = await rig.issueFor(rig.bob, [READ]);
    expect((await rig.read(mission)).result).toBeDefined();
    const session = (await rig.root.store.sessions.getByMission(mission.mission.id))!;
    const consumed = async () =>
      (await rig.root.store.sessions.counters(session.id)).map((c) => [c.riskId, c.consumed]);
    expect(await consumed()).toEqual([[READ, 1]]);

    // The IdP omits the group at this sign-in (a group overage claim, a broken mapping).
    await signIn(bobClaims([]));
    expect(await rig.statusOf(mission)).toBe('orphaned');
    expect(await rig.storedStatusOf(mission)).toBe('active');
    const refused = await rig.read(mission);
    expect(refused.error?.data).toMatchObject({ code: 'mission-inactive', status: 'orphaned' });
    expect(await consumed()).toEqual([[READ, 1]]);

    // The next sign-in carries it again: same mission, same token, same session, same counters.
    await signIn(bobClaims(['depot-readers']));
    expect(await rig.statusOf(mission)).toBe('active');
    expect((await rig.read(mission)).result).toBeDefined();
    expect((await rig.root.store.sessions.getByMission(mission.mission.id))?.id).toBe(session.id);
    expect(await consumed()).toEqual([[READ, 2]]);

    // Both sign-ins are the user's own acts.
    const acts = [
      ...(await rig.adminEntries('mission-orphaned')),
      ...(await rig.adminEntries('mission-restored')),
    ].map((e) => [e.act, e.user_id, e.object.id]);
    expect(acts).toEqual([
      ['mission-orphaned', rig.bob.id, mission.mission.id],
      ['mission-restored', rig.bob.id, mission.mission.id],
    ]);
    // A further sign-in with the same groups writes nothing more.
    await signIn(bobClaims(['depot-readers']));
    expect(await rig.adminEntries('mission-restored')).toHaveLength(1);
  });

  it('turns a connection unowned when the sign-in removed the last member of its IdP owner group', async () => {
    await signIn(adaClaims(['depot-owners']));
    const owners = (await rig.root.store.groups.getByName('depot-owners'))!;
    await rig.root.connections.service.transfer(
      await rig.actor(rig.ada),
      rig.connection.id,
      owners.id,
    );
    expect((await rig.root.store.connections.getById(rig.connection.id))?.status).toBe('active');

    await signIn(adaClaims([]));
    expect((await rig.root.store.connections.getById(rig.connection.id))?.status).toBe('unowned');
  });

  it('merges IdP and local groups: a sign-in never touches a local membership', async () => {
    const local = await rig.root.groups.service.create(rig.operator.id, 'local-team');
    await rig.root.groups.service.addMember(rig.operator.id, local.id, 'bob@example.com');
    await signIn(bobClaims(['from-idp']));
    const names = async () =>
      (await rig.root.store.groups.groupsOf(rig.bob.id)).map((g) => `${g.source}:${g.name}`);
    expect(await names()).toEqual(['idp:from-idp', 'local:local-team']);

    // Both kinds ground authority alike.
    const idpGroup = (await rig.root.store.groups.getByName('from-idp'))!;
    const ada = await rig.actor(rig.ada);
    await rig.root.shares.service.share(ada, rig.connection.id, {
      target: { kind: 'group', groupId: idpGroup.id },
      riskIds: [READ],
    });
    await rig.root.shares.service.share(ada, rig.connection.id, {
      target: { kind: 'group', groupId: local.id },
      riskIds: [PURGE],
    });
    const mission = await rig.issueFor(rig.bob, [READ, PURGE]);

    // The claims change; the local membership stays, the IdP one goes.
    await signIn(bobClaims(['local-team']));
    expect(await names()).toEqual(['local:local-team']);
    // The claim that collides with the local group granted nothing new; the IdP half is gone.
    expect(await rig.statusOf(mission)).toBe('orphaned');
    const [context] = await rig.root.missions.service.issuanceContext(rig.bob);
    expect(context?.authority).toEqual([PURGE]);
  });
});
