/**
 * The operator deactivates a user (ADR operator-deactivates-a-user; spec §2.3
 * "creator removed from the IdP"): offboarding on the instance, without the
 * identity provider. Run on the real composition root (`:memory:` store,
 * simulated IdP, the instance's HTTP surface) with a user who holds one of
 * everything: a web session, a platform management mission on their Vaubaan
 * account with an agent holding its key, a mission that agent issued, a member
 * key on a colleague's mission, a local-group membership, a connection of their
 * own.
 *
 * What must hold afterwards, each read where the product reads it:
 * the session is nobody, the sign-in is refused, both missions — the platform
 * one included — are refused at the execution door without a word written on
 * them, the member key is revoked, the connection is the operator's to
 * reassign — and every one of these has its entry.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LOGIN_COOKIE, SESSION_COOKIE } from '../../../src/server/auth';
import type { UserRecord } from '../../../src/server/store/types';
import { UserAdminError, USERS_PAGE } from '../../../src/server/users';
import {
  ADA,
  BOB,
  bearer,
  draftOn,
  EXECUTION_URL,
  openVaubaanRig,
  OPS,
  PUBLIC_URL,
  toolsList,
  type Agent,
  type Browser,
  type VaubaanRig,
} from '../vaubaan/support';

const SHARED = ['github.read-code', 'github.read-meta'];

/** The clock is the system's: a session opened in the very millisecond of a deactivation is refused. */
const nextMillisecond = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('deactivating a user: sessions end, member keys are revoked, missions follow the derived rule', () => {
  let rig: VaubaanRig;
  let ops: UserRecord;
  let bob: UserRecord;
  let bobBrowser: Browser;
  let agent: Agent;
  let missionId: string;
  let missionToken: string;
  let ownConnectionId: string;
  /** Ada's mission Bob is a teammate of, and the key he generated there. */
  let teamMissionId: string;
  let memberTokenPrefix: string;
  const operator = () => ({ actorId: ops.id, userId: ops.id });

  beforeEach(async () => {
    rig = await openVaubaanRig();
    ops = await rig.browser().signIn(OPS);
    bob = rig.seeded.bob;
    // Ada shares her GitHub connection with Bob: the authority his mission rests on.
    await rig.root.shares.service.share(
      await rig.actor(rig.seeded.ada),
      rig.seeded.github.connection.id,
      { target: { kind: 'user', email: bob.email }, riskIds: SHARED },
    );
    // A web session, a platform mission with its agent, a mission that agent issued.
    bobBrowser = rig.browser();
    await bobBrowser.signIn(BOB);
    agent = await rig.agentOf(BOB);
    const issued = await agent.call<{
      mission: { mission_id: string };
      token: { secret: string };
    }>('issue_mission', draftOn(rig.seeded.github.connection.id, ['github.read-code']));
    if (issued.isError) throw new Error(`issue refused: ${issued.text}`);
    missionId = issued.data.mission.mission_id;
    missionToken = issued.data.token.secret;
    // A local group, and a connection Bob owns in his own name.
    const team = await rig.root.groups.service.create(ops.id, 'reviewers');
    await rig.root.groups.service.addMember(ops.id, team.id, bob.email);
    const own = await rig.root.store.connections.create({
      provider: 'github',
      owner: { kind: 'user', id: bob.id },
      displayName: 'Bob’s GitHub',
      credential: null,
    });
    ownConnectionId = own.id;
    // A mission of Ada with Bob as a teammate holding his own key.
    const adas = await rig.root.missions.service.issue(
      rig.seeded.ada,
      draftOn(rig.seeded.github.connection.id, ['github.read-meta']) as never,
    );
    if (!adas.ok) throw new Error('Ada’s issuance was refused');
    teamMissionId = adas.mission.id;
    const added = await rig.root.missions.team.addMember(rig.seeded.ada, teamMissionId, {
      email: bob.email,
    });
    if (!added.ok) throw new Error('add refused');
    const generated = await rig.root.missions.team.generateToken(bob, teamMissionId);
    if (!generated.ok) throw new Error('generate refused');
    memberTokenPrefix = generated.token.prefix;
  });
  afterEach(async () => {
    await agent.close().catch(() => undefined);
    await rig.close();
  });

  const sessionOf = (browser: Browser) =>
    rig.root.auth.authenticator.authenticate(
      new Headers({ cookie: `${SESSION_COOKIE}=${browser.cookies.get(SESSION_COOKIE) ?? ''}` }),
    );

  async function memberTokenStatus(): Promise<string | undefined> {
    const tokens = await rig.root.store.missions.listTokens(teamMissionId);
    return tokens.find((token) => token.prefix === memberTokenPrefix)?.status;
  }

  async function executionSays(token: string): Promise<string> {
    const response = await toolsList(rig, EXECUTION_URL, bearer(token));
    if (response.status !== 200) return `http-${response.status}`;
    const body = (await response.json()) as { error?: { data?: { code?: string } } };
    return body.error?.data?.code ?? 'ok';
  }

  it('before: everything Bob holds works', async () => {
    expect((await sessionOf(bobBrowser))?.kind).toBe('user');
    expect(await executionSays(missionToken)).toBe('ok');
    expect(await executionSays(agent.token)).toBe('ok');
    expect(await memberTokenStatus()).toBe('active');
  });

  it('ends the sessions, the member keys and the authority at once, and audits each', async () => {
    const done = await rig.root.users.service.deactivate(operator(), bob.id);
    expect(done).toMatchObject({
      user: { id: bob.id, status: 'removed' },
      groupsLeft: ['reviewers'],
      memberTokensRevoked: 1,
      // The platform mission and the mission its agent issued.
      orphaned: 2,
      unowned: 1,
    });

    // ── The human session is nobody, and its row is gone at the first look ──
    expect(await sessionOf(bobBrowser)).toBeNull();

    // ── The platform agent is stopped: its mission reads orphaned at the door ──
    expect(await executionSays(agent.token)).toBe('mission-inactive');
    expect(await memberTokenStatus()).not.toBe('active');

    // ── The mission: refused at the execution door, nothing stored on it ──
    expect(await executionSays(missionToken)).toBe('mission-inactive');
    expect((await rig.root.store.missions.getById(missionId))?.status).toBe('active');

    // ── Groups and ownership ──
    expect(await rig.root.store.groups.groupsOf(bob.id)).toEqual([]);
    expect((await rig.root.store.connections.getById(ownConnectionId))?.status).toBe('unowned');
    expect(
      (await rig.root.connections.service.listOwnerless()).map((v) => v.connection.id),
    ).toEqual([ownConnectionId]);

    // ── Nobody shares to them any more ──
    await expect(
      rig.root.shares.service.share(
        await rig.actor(rig.seeded.ada),
        rig.seeded.github.connection.id,
        { target: { kind: 'user', email: bob.email }, riskIds: ['github.read-meta'] },
      ),
    ).rejects.toMatchObject({ code: 'target-unknown' });

    // ── Every effect has its entry, in the operator's name ──
    expect(await rig.adminEntries('user-deactivated')).toMatchObject([
      {
        user_id: ops.id,
        object: { type: 'user', id: bob.id },
        before: { status: 'active', email: bob.email },
        after: { status: 'removed', groups_left: ['reviewers'], member_tokens_revoked: 1 },
      },
    ]);
    const orphanedEntries = await rig.adminEntries('mission-orphaned');
    expect(orphanedEntries.map((e) => e.object.id).sort()).toEqual(
      [missionId, agent.missionId].sort(),
    );
    for (const entry of orphanedEntries) {
      expect(entry).toMatchObject({
        user_id: ops.id,
        after: { status: 'orphaned', cause: 'creator-removed' },
      });
    }
    expect(await rig.adminEntries('mission-revoked')).toEqual([]);
  });

  it('refuses the sign-in of a deactivated user although the identity provider vouches for them', async () => {
    const deactivated = (await rig.root.users.service.deactivate(operator(), bob.id)).user;
    const browser = rig.browser();
    const response = await browser.navigate('/auth/login?return_to=/missions', BOB);
    expect(response.headers.get('location')).toBe('/login?error=account-deactivated');
    expect(browser.cookies.has(SESSION_COOKIE)).toBe(false);
    expect(browser.cookies.has(LOGIN_COOKIE)).toBe(false);
    // Nothing of the attempt was written: status, last sign-in and groups are as they were.
    expect(await rig.root.store.users.getById(bob.id)).toEqual(deactivated);
    expect(rig.logs.some((line) => line.includes('account-deactivated'))).toBe(true);
    // A new platform mission is impossible too: a deactivated person holds nothing.
    await expect(rig.agentOf(BOB)).rejects.toThrow();
  });

  it('reactivation: the user signs in again and what still has grounds serves again; what was closed stays closed', async () => {
    await rig.root.users.service.deactivate(operator(), bob.id);
    expect(await executionSays(missionToken)).toBe('mission-inactive');
    const back = await rig.root.users.service.reactivate(operator(), bob.id);
    expect(back).toMatchObject({ user: { id: bob.id, status: 'active' }, restored: 2 });

    // The share still stands: the mission serves again, same token; so does the platform one.
    expect(await executionSays(missionToken)).toBe('ok');
    expect(await executionSays(agent.token)).toBe('ok');
    expect((await rig.adminEntries('mission-restored')).map((e) => e.object.id).sort()).toEqual(
      [missionId, agent.missionId].sort(),
    );
    expect(await rig.adminEntries('user-reactivated')).toMatchObject([
      { user_id: ops.id, object: { type: 'user', id: bob.id }, after: { status: 'active' } },
    ]);

    // The session opened before the deactivation is not reopened…
    expect(await sessionOf(bobBrowser)).toBeNull();
    // …the member key stays revoked…
    expect(await memberTokenStatus()).not.toBe('active');
    // …the local group and the connection he owned do not come back by themselves.
    expect(await rig.root.store.groups.groupsOf(bob.id)).toEqual([]);
    expect((await rig.root.store.connections.getById(ownConnectionId))?.status).toBe('unowned');

    // Reactivated, he is the owner of his connection again as far as authority goes
    // (a mission on it would be grounded), but the connection is ownerless: no owner
    // act passes until the operator reassigns it.
    const own = (await rig.root.store.connections.getById(ownConnectionId))!;
    expect((await rig.root.missions.authority.authorityOf(bob, own)).basis).toBe('owner');
    await expect(
      rig.root.shares.service.share(await rig.actor(bob), ownConnectionId, {
        target: { kind: 'user', email: ADA.email },
        riskIds: ['github.read-code'],
      }),
    ).rejects.toMatchObject({ code: 'connection-unowned' });

    // A new sign-in is a new session.
    await nextMillisecond();
    const browser = rig.browser();
    await browser.signIn(BOB);
    expect((await sessionOf(browser))?.kind).toBe('user');
  });

  it('a deactivated owner’s connection is the operator’s to reassign', async () => {
    await rig.root.users.service.deactivate(operator(), bob.id);
    const reassigned = await rig.root.connections.service.reassign(ops.id, ownConnectionId, {
      kind: 'user',
      email: ADA.email,
    });
    expect(reassigned).toMatchObject({
      status: 'active',
      owner: { kind: 'user', id: rig.seeded.ada.id },
    });
  });

  it('refuses what makes no sense, and writes nothing then', async () => {
    const { service } = rig.root.users;
    await expect(service.deactivate(operator(), ops.id)).rejects.toMatchObject({
      code: 'cannot-deactivate-self',
    });
    await expect(service.deactivate(operator(), 'no-such-user')).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(service.reactivate(operator(), bob.id)).rejects.toMatchObject({
      code: 'not-deactivated',
    });
    expect(await rig.adminEntries('user-deactivated')).toEqual([]);
    expect((await rig.root.store.users.getById(ops.id))?.status).toBe('active');

    await service.deactivate(operator(), bob.id);
    await expect(service.deactivate(operator(), bob.id)).rejects.toBeInstanceOf(UserAdminError);
    expect(await rig.adminEntries('user-deactivated')).toHaveLength(1);
    await expect(service.reactivate(operator(), 'no-such-user')).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('closes everything it can when one step fails, then reports the failure: the audit entry and the settlement do not depend on the member keys', async () => {
    const team = rig.root.missions.team;
    const original = team.revokeTokensOfDeactivated.bind(team);
    team.revokeTokensOfDeactivated = async () => {
      throw new Error('tokens unavailable');
    };
    try {
      await expect(rig.root.users.service.deactivate(operator(), bob.id)).rejects.toThrow(
        'tokens unavailable',
      );
    } finally {
      team.revokeTokensOfDeactivated = original;
    }
    // The user is deactivated and everything else was closed.
    expect((await rig.root.store.users.getById(bob.id))?.status).toBe('removed');
    expect(await rig.root.store.groups.groupsOf(bob.id)).toEqual([]);
    expect((await rig.root.store.connections.getById(ownConnectionId))?.status).toBe('unowned');
    expect(await rig.adminEntries('user-deactivated')).toMatchObject([
      { after: { status: 'removed', groups_left: ['reviewers'], member_tokens_revoked: 0 } },
    ]);
    expect(await rig.adminEntries('mission-orphaned')).toHaveLength(2);
    // The member key was not revoked — and is dead all the same: its holder is not active.
    expect(await memberTokenStatus()).toBe('active');
    expect(await executionSays(agent.token)).toBe('mission-inactive');
    expect(rig.logs.some((line) => line.includes('not everything they held was closed'))).toBe(
      true,
    );
  });

  it('what a half-failed deactivation left open is closed before the user is active again', async () => {
    const team = rig.root.missions.team;
    const original = team.revokeTokensOfDeactivated.bind(team);
    team.revokeTokensOfDeactivated = async () => {
      throw new Error('tokens unavailable');
    };
    try {
      await expect(rig.root.users.service.deactivate(operator(), bob.id)).rejects.toThrow(
        'tokens unavailable',
      );
    } finally {
      team.revokeTokensOfDeactivated = original;
    }
    // The member key is still `active` in the store: dead only because Bob is not.
    expect(await memberTokenStatus()).toBe('active');

    const back = await rig.root.users.service.reactivate(operator(), bob.id);

    expect(back.user.status).toBe('active');
    // Bob is active again and the member key did not come back with him: he generates a new one.
    expect(await memberTokenStatus()).not.toBe('active');
    expect(await rig.adminEntries('mission-token-revoked')).toMatchObject([
      { after: expect.objectContaining({ reason: 'holder-deactivated' }) as object },
    ]);
  });

  it('a reactivation that cannot close what was left open does not happen', async () => {
    await rig.root.users.service.deactivate(operator(), bob.id);
    const team = rig.root.missions.team;
    const original = team.revokeTokensOfDeactivated.bind(team);
    team.revokeTokensOfDeactivated = async () => {
      throw new Error('tokens unavailable');
    };
    try {
      await expect(rig.root.users.service.reactivate(operator(), bob.id)).rejects.toThrow(
        'tokens unavailable',
      );
    } finally {
      team.revokeTokensOfDeactivated = original;
    }
    expect((await rig.root.store.users.getById(bob.id))?.status).toBe('removed');
    expect(await rig.adminEntries('user-reactivated')).toEqual([]);
    // Once the store answers again, the operator's second attempt goes through.
    expect((await rig.root.users.service.reactivate(operator(), bob.id)).user.status).toBe(
      'active',
    );
  });

  it('the bootstrap operator may deactivate anyone, an operator included', async () => {
    const done = await rig.root.users.service.deactivate(
      { actorId: 'bootstrap', userId: null },
      ops.id,
    );
    expect(done.user.status).toBe('removed');
  });

  describe('over HTTP: operator only, origin-checked', () => {
    const post = (path: string, headers: Record<string, string>) =>
      new Request(`${PUBLIC_URL}${path}`, { method: 'POST', headers });
    const cookieOf = (browser: Browser) =>
      `${SESSION_COOKIE}=${browser.cookies.get(SESSION_COOKIE) ?? ''}`;

    it('an operator deactivates and lands on the Users page with what happened', async () => {
      const opsBrowser = rig.browser();
      await opsBrowser.signIn(OPS);
      const response = await rig.root.users.handlers.deactivate(
        post(`${USERS_PAGE}/${bob.id}/deactivate`, {
          cookie: cookieOf(opsBrowser),
          origin: PUBLIC_URL,
        }),
        bob.id,
      );
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toMatch(/^\/admin\/users\?notice=/);
      expect((await rig.root.store.users.getById(bob.id))?.status).toBe('removed');

      const again = await rig.root.users.handlers.reactivate(
        post(`${USERS_PAGE}/${bob.id}/reactivate`, {
          cookie: cookieOf(opsBrowser),
          origin: PUBLIC_URL,
        }),
        bob.id,
      );
      expect(again.status).toBe(303);
      expect((await rig.root.store.users.getById(bob.id))?.status).toBe('active');
    });

    it('refuses a plain user, a foreign origin and no session; nobody is deactivated', async () => {
      const ada = rig.browser();
      await ada.signIn(ADA);
      const opsBrowser = rig.browser();
      await opsBrowser.signIn(OPS);
      const attempts: [string, Record<string, string>, number][] = [
        ['a plain user', { cookie: cookieOf(ada), origin: PUBLIC_URL }, 403],
        ['a foreign origin', { cookie: cookieOf(opsBrowser), origin: 'https://evil.example' }, 403],
        ['no origin', { cookie: cookieOf(opsBrowser) }, 403],
        ['no session', { origin: PUBLIC_URL }, 401],
      ];
      for (const [name, headers, status] of attempts) {
        const response = await rig.root.users.handlers.deactivate(
          post(`${USERS_PAGE}/${bob.id}/deactivate`, headers),
          bob.id,
        );
        expect(response.status, name).toBe(status);
      }
      expect((await rig.root.store.users.getById(bob.id))?.status).toBe('active');
      expect(await rig.adminEntries('user-deactivated')).toEqual([]);
    });
  });
});
