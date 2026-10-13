/**
 * The operator deactivates a user (ADR operator-deactivates-a-user; spec §2.3
 * "creator removed from the IdP"): offboarding on the instance, without the
 * identity provider. Run on the real composition root (`:memory:` store,
 * simulated IdP, the instance's HTTP surface) with a user who holds one of
 * everything: a web session, a delegation with live tokens, a mission issued
 * through it, a local-group membership, a connection of their own.
 *
 * What must hold afterwards, each read where the product reads it:
 * the session is nobody, the sign-in is refused, the delegated tokens are
 * dead on the management door and at the token endpoint, the mission is
 * refused at the execution door without a word written on it, the connection
 * is the operator's to reassign — and every one of these has its entry.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LOGIN_COOKIE, SESSION_COOKIE } from '../../../src/server/auth';
import type { UserRecord } from '../../../src/server/store/types';
import { UserAdminError, USERS_PAGE } from '../../../src/server/users';
import {
  ADA,
  BOB,
  draftOn,
  EXECUTION_URL,
  MANAGEMENT_URL,
  openManagementRig,
  type Agent,
  type ManagementRig,
} from '../management/support';
import {
  bearer,
  OPS,
  PUBLIC_URL,
  tokenRequest,
  toolsList,
  type Browser,
} from '../oauth-as/support';

const SHARED = ['github.read-code', 'github.read-meta'];

/** The clock is the system's: a session opened in the very millisecond of a deactivation is refused. */
const nextMillisecond = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('deactivating a user: sessions end, delegations are revoked, missions follow the derived rule', () => {
  let rig: ManagementRig;
  let ops: UserRecord;
  let bob: UserRecord;
  let bobBrowser: Browser;
  let agent: Agent;
  let missionId: string;
  let missionToken: string;
  let ownConnectionId: string;
  const operator = () => ({ actorId: ops.id, userId: ops.id });

  beforeEach(async () => {
    rig = await openManagementRig();
    ops = await rig.browser().signIn(OPS);
    bob = rig.seeded.bob;
    // Ada shares her GitHub connection with Bob: the authority his mission rests on.
    await rig.root.shares.service.share(
      await rig.actor(rig.seeded.ada),
      rig.seeded.github.connection.id,
      { target: { kind: 'user', email: bob.email }, riskIds: SHARED },
    );
    // A web session, a delegation, a mission issued through it.
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
  });
  afterEach(async () => {
    await agent.close().catch(() => undefined);
    await rig.close();
  });

  const sessionOf = (browser: Browser) =>
    rig.root.auth.authenticator.authenticate(
      new Headers({ cookie: `${SESSION_COOKIE}=${browser.cookies.get(SESSION_COOKIE) ?? ''}` }),
    );

  async function executionSays(token: string): Promise<string> {
    const response = await toolsList(rig, EXECUTION_URL, bearer(token));
    if (response.status !== 200) return `http-${response.status}`;
    const body = (await response.json()) as { error?: { data?: { code?: string } } };
    return body.error?.data?.code ?? 'ok';
  }

  const refresh = () =>
    tokenRequest(rig, {
      grant_type: 'refresh_token',
      client_id: agent.delegated.clientId,
      refresh_token: agent.delegated.tokens.refresh_token,
    });

  it('before: everything Bob holds works', async () => {
    expect((await sessionOf(bobBrowser))?.kind).toBe('user');
    expect(await executionSays(missionToken)).toBe('ok');
    const door = await toolsList(rig, MANAGEMENT_URL, bearer(agent.delegated.tokens.access_token));
    expect(door.status).toBe(200);
  });

  it('ends the sessions, the delegations and the authority at once, and audits each', async () => {
    const done = await rig.root.users.service.deactivate(operator(), bob.id);
    expect(done).toMatchObject({
      user: { id: bob.id, status: 'removed' },
      groupsLeft: ['reviewers'],
      delegationsRevoked: 1,
      orphaned: 1,
      unowned: 1,
    });

    // ── The human session is nobody, and its row is gone at the first look ──
    expect(await sessionOf(bobBrowser)).toBeNull();

    // ── The delegated tokens are dead: at the door and at the token endpoint ──
    const door = await toolsList(rig, MANAGEMENT_URL, bearer(agent.delegated.tokens.access_token));
    expect(door.status).toBe(401);
    const renewed = await refresh();
    expect(renewed.status).toBe(400);
    expect(await renewed.json()).toMatchObject({ error: 'invalid_grant' });
    expect(await rig.root.store.delegations.getById(agent.delegated.delegationId)).toMatchObject({
      status: 'revoked',
      revokeReason: 'user-deactivated',
    });

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
        after: { status: 'removed', groups_left: ['reviewers'], delegations_revoked: 1 },
        delegated_client_id: null,
      },
    ]);
    expect(await rig.adminEntries('delegation-revoked')).toMatchObject([
      {
        user_id: ops.id,
        object: { type: 'delegation', id: agent.delegated.delegationId },
        after: { reason: 'user-deactivated', delegating_user_id: bob.id },
        delegated_client_id: null,
      },
    ]);
    expect(await rig.adminEntries('mission-orphaned')).toMatchObject([
      {
        user_id: ops.id,
        object: { type: 'mission', id: missionId },
        after: { status: 'orphaned', cause: 'creator-removed' },
      },
    ]);
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
    // A new consent is impossible too: it needs a session.
    await expect(rig.agentOf(BOB)).rejects.toThrow();
  });

  it('reactivation: the user signs in again and what still has grounds serves again; what was closed stays closed', async () => {
    await rig.root.users.service.deactivate(operator(), bob.id);
    expect(await executionSays(missionToken)).toBe('mission-inactive');
    const back = await rig.root.users.service.reactivate(operator(), bob.id);
    expect(back).toMatchObject({ user: { id: bob.id, status: 'active' }, restored: 1 });

    // The share still stands: the mission serves again, same token.
    expect(await executionSays(missionToken)).toBe('ok');
    expect(await rig.adminEntries('mission-restored')).toMatchObject([
      { user_id: ops.id, object: { type: 'mission', id: missionId } },
    ]);
    expect(await rig.adminEntries('user-reactivated')).toMatchObject([
      { user_id: ops.id, object: { type: 'user', id: bob.id }, after: { status: 'active' } },
    ]);

    // The session opened before the deactivation is not reopened…
    expect(await sessionOf(bobBrowser)).toBeNull();
    // …the delegation stays revoked…
    expect((await refresh()).status).toBe(400);
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

  it('closes everything it can when one step fails, then reports the failure: the audit entry and the settlement do not depend on the delegations', async () => {
    const original = rig.root.oauth.delegations.revokeAllOf.bind(rig.root.oauth.delegations);
    rig.root.oauth.delegations.revokeAllOf = async () => {
      throw new Error('delegations unavailable');
    };
    try {
      await expect(rig.root.users.service.deactivate(operator(), bob.id)).rejects.toThrow(
        'delegations unavailable',
      );
    } finally {
      rig.root.oauth.delegations.revokeAllOf = original;
    }
    // The user is deactivated and everything else was closed.
    expect((await rig.root.store.users.getById(bob.id))?.status).toBe('removed');
    expect(await rig.root.store.groups.groupsOf(bob.id)).toEqual([]);
    expect((await rig.root.store.connections.getById(ownConnectionId))?.status).toBe('unowned');
    expect(await rig.adminEntries('user-deactivated')).toMatchObject([
      { after: { status: 'removed', groups_left: ['reviewers'], delegations_revoked: 0 } },
    ]);
    expect(await rig.adminEntries('mission-orphaned')).toHaveLength(1);
    // The delegation was not revoked — and is dead all the same: its user is not active.
    const door = await toolsList(rig, MANAGEMENT_URL, bearer(agent.delegated.tokens.access_token));
    expect(door.status).toBe(401);
    expect((await refresh()).status).toBe(400);
    expect(rig.logs.some((line) => line.includes('not everything they held was closed'))).toBe(
      true,
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
