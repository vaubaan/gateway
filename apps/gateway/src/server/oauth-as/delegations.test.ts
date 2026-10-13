import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { silentLogger } from '../logging';
import type { OAuthClientRecord } from '../store/types';
import { ClientRegistry } from './clients';
import { delegationLifetime } from './delegation-lifetime';
import { delegationStateOf, endDelegation } from './delegations';
import { mintAccessToken } from './secrets';
import {
  DEFAULT_TEST_OAUTH,
  LOOPBACK_REDIRECT,
  openOAuthRig,
  WEB_REDIRECT,
  type OAuthRig,
} from './testing';
import { DelegatedTokenVerifier } from './verifier';

describe('DelegationService', () => {
  let rig: OAuthRig;
  let client: OAuthClientRecord;

  beforeEach(async () => {
    rig = await openOAuthRig();
    client = await rig.registerClient(undefined, 'Claude Code');
  });
  afterEach(() => rig.close());

  it('lists nothing for a user who authorized nobody', async () => {
    expect(await rig.delegations.listFor(rig.ada)).toEqual([]);
  });

  it('lists a user’s delegations with the client holding each, most recent first', async () => {
    const first = await rig.issue(rig.ada, client);
    rig.clock.advance(60_000);
    const other = await rig.registerClient(undefined, 'Another agent');
    const second = await rig.issue(rig.ada, other);
    await rig.issue(rig.bob, client);

    const views = await rig.delegations.listFor(rig.ada);
    expect(views.map((view) => view.delegation.id)).toEqual([
      second.delegationId,
      first.delegationId,
    ]);
    expect(views[0]).toMatchObject({
      state: 'active',
      clientStatus: 'approved',
      client: { name: 'Another agent' },
      lastTokenAt: rig.clock.now().toISOString(),
      missions: [],
    });
    expect(views[1]?.client.name).toBe('Claude Code');
    expect(views[0]?.liveUntil).toBe(
      new Date(rig.clock.now().getTime() + 30 * 86_400_000).toISOString(),
    );
  });

  it('shows the missions each delegation issued, and only those', async () => {
    const { delegationId } = await rig.issue(rig.ada, client);
    const untouched = await rig.issue(rig.ada, client);
    const connection = await rig.store.connections.create({
      provider: 'github',
      owner: { kind: 'user', id: rig.ada.id },
      displayName: 'gh',
      credential: null,
    });
    const mission = (name: string, viaDelegation: string | null) =>
      rig.store.missions.create({
        name,
        creatorUserId: rig.ada.id,
        periodSeconds: null,
        delegationId: viaDelegation,
        connections: [{ connectionId: connection.id, resourceScope: 'all', resourceIds: [] }],
        policy: [
          {
            riskId: 'github.code-read',
            quota: 1,
            rateLimit: 1,
            rateWindowSeconds: 60,
            gate: 'auto',
          },
        ],
      });
    await mission('issued by the agent', delegationId);
    await mission('issued by hand', null);

    const views = await rig.delegations.listFor(rig.ada);
    const byId = new Map(views.map((view) => [view.delegation.id, view]));
    expect(byId.get(delegationId)?.missions.map((m) => m.name)).toEqual(['issued by the agent']);
    expect(byId.get(untouched.delegationId)?.missions).toEqual([]);
  });

  it('calls a delegation idle when no token of it is left alive', async () => {
    const neverRedeemed = await rig.grant(rig.ada, client);
    let [view] = await rig.delegations.listFor(rig.ada);
    expect(view).toMatchObject({
      delegation: { id: neverRedeemed.delegationId },
      state: 'idle',
      lastTokenAt: null,
      liveUntil: null,
    });

    const { delegationId } = await rig.issue(rig.bob, client);
    rig.clock.advance(31 * 86_400_000);
    [view] = await rig.delegations.listFor(rig.bob);
    expect(view).toMatchObject({ delegation: { id: delegationId }, state: 'idle' });
  });

  it('shows when the consent ends, and reads a delegation past its lifetime as expired without writing anything', async () => {
    const { delegationId } = await rig.issue(rig.ada, client);
    const consentedAt = rig.clock.now().getTime();
    const deadline = new Date(consentedAt + 90 * 86_400_000).toISOString();

    let [view] = await rig.delegations.listFor(rig.ada);
    expect(view).toMatchObject({ state: 'active', expiresAt: deadline });

    // Unused for 31 days: idle, and the consent still ends on the same day.
    rig.clock.advance(31 * 86_400_000);
    [view] = await rig.delegations.listFor(rig.ada);
    expect(view).toMatchObject({ state: 'idle', expiresAt: deadline });

    rig.clock.advance(59 * 86_400_000);
    [view] = await rig.delegations.listFor(rig.ada);
    expect(view).toMatchObject({ state: 'expired', expiresAt: deadline, liveUntil: null });
    expect((await rig.store.delegations.getById(delegationId))?.status).toBe('active');
    expect(rig.audit.admin.filter((entry) => entry.act === 'delegation-revoked')).toEqual([]);

    // The user may still close it for good; a revocation is said before an expiry.
    expect((await rig.delegations.revoke(rig.ada, delegationId)).outcome).toBe('revoked');
    [view] = await rig.delegations.listFor(rig.ada);
    expect(view?.state).toBe('revoked');
  });

  it('derives the state in one place: revoked, then expired, then active or idle', () => {
    const now = '2026-10-13T09:00:00.000Z';
    const later = '2026-10-13T09:10:00.000Z';
    expect(delegationStateOf({ status: 'revoked' }, true, later, now)).toBe('revoked');
    expect(delegationStateOf({ status: 'revoked' }, false, later, now)).toBe('revoked');
    expect(delegationStateOf({ status: 'active' }, true, later, now)).toBe('expired');
    expect(delegationStateOf({ status: 'active' }, false, later, now)).toBe('active');
    expect(delegationStateOf({ status: 'active' }, false, now, now)).toBe('idle');
    expect(delegationStateOf({ status: 'active' }, false, null, now)).toBe('idle');
  });

  it('revokes in one call: the tokens stop at once and the entry names the user', async () => {
    const { tokens, delegationId } = await rig.issue(rig.ada, client);
    rig.audit.entries.length = 0;
    const result = await rig.delegations.revoke(rig.ada, delegationId);
    expect(result).toMatchObject({
      outcome: 'revoked',
      delegation: { status: 'revoked', revokeReason: 'user' },
    });
    expect(await rig.verifier.resolve(tokens.access_token)).toBeNull();
    await expect(
      rig.tokens.refresh(
        client,
        rig.form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_grant' });
    expect(rig.audit.admin).toEqual([
      {
        kind: 'admin',
        ts: rig.clock.now().toISOString(),
        user_id: rig.ada.id,
        act: 'delegation-revoked',
        object: { type: 'delegation', id: delegationId },
        before: { status: 'active' },
        after: {
          status: 'revoked',
          reason: 'user',
          client_id: client.clientId,
          client_name: 'Claude Code',
        },
        delegated_client_id: null,
      },
    ]);
    const [view] = await rig.delegations.listFor(rig.ada);
    expect(view).toMatchObject({ state: 'revoked', liveUntil: null });
  });

  it('revoking twice writes one entry', async () => {
    const { delegationId } = await rig.issue(rig.ada, client);
    rig.audit.entries.length = 0;
    await rig.delegations.revoke(rig.ada, delegationId);
    expect((await rig.delegations.revoke(rig.ada, delegationId)).outcome).toBe('already-revoked');
    expect(rig.audit.admin).toHaveLength(1);
  });

  it('a user cannot revoke, nor learn of, another user’s delegation', async () => {
    const { tokens, delegationId } = await rig.issue(rig.ada, client);
    rig.audit.entries.length = 0;
    expect(await rig.delegations.revoke(rig.bob, delegationId)).toEqual({ outcome: 'not-found' });
    expect(await rig.delegations.revoke(rig.bob, 'missing')).toEqual({ outcome: 'not-found' });
    expect(await rig.verifier.resolve(tokens.access_token)).not.toBeNull();
    expect(rig.audit.entries).toEqual([]);
    expect(await rig.delegations.listFor(rig.bob)).toEqual([]);
  });

  it('shows why the gateway itself ended a delegation', async () => {
    const { tokens, delegationId } = await rig.issue(rig.ada, client);
    const refresh = (token: string) =>
      rig.tokens.refresh(client, rig.form({ grant_type: 'refresh_token', refresh_token: token }));
    await refresh(tokens.refresh_token);
    // Past the reuse window, the same token again is a replay.
    rig.clock.advance(61_000);
    await expect(refresh(tokens.refresh_token)).rejects.toMatchObject({ code: 'invalid_grant' });
    const [view] = await rig.delegations.listFor(rig.ada);
    expect(view).toMatchObject({
      delegation: { id: delegationId, revokeReason: 'refresh-token-replay' },
      state: 'revoked',
    });
  });
});

describe('a delegation revoked for a replay: the missions it issued are surfaced, never revoked silently', () => {
  let rig: OAuthRig;
  let client: OAuthClientRecord;

  beforeEach(async () => {
    rig = await openOAuthRig();
    client = await rig.registerClient(undefined, 'Claude Code');
  });
  afterEach(() => rig.close());

  async function missionOf(
    name: string,
    delegationId: string | null,
    options: { expiresAt?: string | null } = {},
  ) {
    const connection =
      (await rig.store.connections.listOwnedBy([{ kind: 'user', id: rig.ada.id }]))[0] ??
      (await rig.store.connections.create({
        provider: 'github',
        owner: { kind: 'user', id: rig.ada.id },
        displayName: 'gh',
        credential: null,
      }));
    return rig.store.missions.create({
      name,
      creatorUserId: rig.ada.id,
      periodSeconds: null,
      expiresAt: options.expiresAt ?? null,
      delegationId,
      connections: [{ connectionId: connection.id, resourceScope: 'all', resourceIds: [] }],
      policy: [
        { riskId: 'github.code-read', quota: 1, rateLimit: 1, rateWindowSeconds: 60, gate: 'auto' },
      ],
    });
  }

  /** Renews once, lets the reuse window close, presents the first token again. */
  async function replay(refreshToken: string): Promise<void> {
    const refresh = (token: string) =>
      rig.tokens.refresh(client, rig.form({ grant_type: 'refresh_token', refresh_token: token }));
    await refresh(refreshToken);
    rig.clock.advance(61_000);
    await expect(refresh(refreshToken)).rejects.toMatchObject({ code: 'invalid_grant' });
  }

  it('names in the audit entry the missions still running, and leaves every one of them as it was', async () => {
    const { tokens, delegationId } = await rig.issue(rig.ada, client);
    const running = await missionOf('issued by the agent', delegationId);
    const alsoRunning = await missionOf('issued by the agent, no expiry', delegationId);
    const revoked = await missionOf('already revoked', delegationId);
    await rig.store.missions.setStatus(revoked.id, 'revoked');
    await missionOf('expired by then', delegationId, {
      expiresAt: new Date(rig.clock.now().getTime() + 1_000).toISOString(),
    });
    const byHand = await missionOf('issued by hand', null);
    rig.audit.entries.length = 0;

    await replay(tokens.refresh_token);

    const [entry] = rig.audit.admin.filter((e) => e.act === 'delegation-revoked');
    expect(entry).toMatchObject({
      user_id: rig.ada.id,
      object: { type: 'delegation', id: delegationId },
      after: {
        status: 'revoked',
        reason: 'refresh-token-replay',
        missions_to_review: [
          { mission_id: running.id, name: 'issued by the agent' },
          { mission_id: alsoRunning.id, name: 'issued by the agent, no expiry' },
        ],
      },
    });
    // Surfaced, not revoked: nothing was written on any mission.
    for (const mission of [running, alsoRunning, byHand]) {
      expect((await rig.store.missions.getById(mission.id))?.status, mission.name).toBe('active');
    }
    expect(rig.audit.admin.some((e) => e.act === 'mission-revoked')).toBe(false);
  });

  it('the Delegations view lists them for review, until each is revoked or expires', async () => {
    const { tokens, delegationId } = await rig.issue(rig.ada, client);
    const first = await missionOf('first', delegationId);
    const second = await missionOf('second', delegationId);
    await replay(tokens.refresh_token);

    let [view] = await rig.delegations.listFor(rig.ada);
    expect(view).toMatchObject({ state: 'revoked', replayed: true });
    expect(view?.toReview.map((m) => m.id)).toEqual([first.id, second.id]);
    // Every mission it issued is still listed, as before.
    expect(view?.missions.map((m) => m.id)).toEqual([first.id, second.id]);

    await rig.store.missions.setStatus(first.id, 'revoked');
    [view] = await rig.delegations.listFor(rig.ada);
    expect(view?.toReview.map((m) => m.id)).toEqual([second.id]);
  });

  it('says nothing of the kind for a delegation the user, the client or an operator ended', async () => {
    const { delegationId } = await rig.issue(rig.ada, client);
    await missionOf('issued by the agent', delegationId);
    rig.audit.entries.length = 0;
    await rig.delegations.revoke(rig.ada, delegationId);
    const [entry] = rig.audit.admin;
    expect(entry?.after).not.toHaveProperty('missions_to_review');
    const [view] = await rig.delegations.listFor(rig.ada);
    expect(view).toMatchObject({ state: 'revoked', replayed: false, toReview: [] });
  });

  it('still revokes and still writes the entry when the missions cannot be read: the list is absent, not empty', async () => {
    const { delegationId } = await rig.issue(rig.ada, client);
    const errors: string[] = [];
    const revoked = await endDelegation(
      {
        repo: rig.store.delegations,
        missions: {
          listForCreator: async () => {
            throw new Error('store unavailable');
          },
        },
        audit: rig.audit,
        clock: rig.clock,
        logger: { ...silentLogger, error: (message: string) => errors.push(message) },
      },
      delegationId,
      { reason: 'refresh-token-replay', actorId: rig.ada.id, viaClient: true },
    );
    expect(revoked).toMatchObject({ status: 'revoked', revokeReason: 'refresh-token-replay' });
    const entry = rig.audit.admin.find((e) => e.act === 'delegation-revoked');
    expect(entry?.after).toMatchObject({ status: 'revoked', reason: 'refresh-token-replay' });
    expect(entry?.after).not.toHaveProperty('missions_to_review');
    expect(errors).toEqual(['could not list the missions of a delegation revoked for a replay']);
  });

  it('an authorization code presented twice is surfaced the same way', async () => {
    const granted = await rig.grant(rig.ada, client);
    const form = () =>
      rig.form({
        grant_type: 'authorization_code',
        code: granted.code,
        code_verifier: granted.pkce.verifier,
        redirect_uri: granted.redirectUri,
      });
    await rig.tokens.exchangeCode(client, form());
    const mission = await missionOf('issued between the two', granted.delegationId);
    rig.audit.entries.length = 0;
    await expect(rig.tokens.exchangeCode(client, form())).rejects.toMatchObject({
      code: 'invalid_grant',
    });
    expect(rig.audit.admin[0]).toMatchObject({
      act: 'delegation-revoked',
      after: {
        reason: 'authorization-code-replay',
        missions_to_review: [{ mission_id: mission.id, name: 'issued between the two' }],
      },
    });
  });
});

describe('DelegatedTokenVerifier', () => {
  let rig: OAuthRig;
  let client: OAuthClientRecord;

  beforeEach(async () => {
    rig = await openOAuthRig();
    client = await rig.registerClient();
  });
  afterEach(() => rig.close());

  it('resolves a live token to the delegation, the user and the public client id', async () => {
    const { tokens, delegationId } = await rig.issue(rig.ada, client);
    expect(await rig.verifier.resolve(tokens.access_token)).toEqual({
      delegation_id: delegationId,
      user_id: rig.ada.id,
      client_id: client.clientId,
      scopes: ['mgmt'],
      expires_at: new Date(rig.clock.now().getTime() + 900_000).toISOString(),
    });
    // The form an Authorization header leaves it in.
    expect(await rig.verifier.resolve(` ${tokens.access_token} `)).not.toBeNull();
  });

  it.each([
    ['an unknown token of the right shape', () => mintAccessToken()],
    ['a mission-token-shaped value', () => 'vbn_live_abcdefgh_' + 'a'.repeat(32)],
    ['an empty string', () => ''],
    ['a session-id-shaped value', () => 'A'.repeat(43)],
  ])('resolves %s to nothing, without touching the store', async (_case, make) => {
    expect(await rig.verifier.resolve(make())).toBeNull();
  });

  it('never resolves a refresh token, an authorization code or a client id', async () => {
    const granted = await rig.grant(rig.ada, client);
    expect(await rig.verifier.resolve(granted.code)).toBeNull();
    const { tokens } = await rig.issue(rig.ada, client);
    expect(await rig.verifier.resolve(tokens.refresh_token)).toBeNull();
    expect(await rig.verifier.resolve(client.clientId)).toBeNull();
  });

  it('stops resolving at once when the delegation is revoked or the user removed', async () => {
    const revoked = await rig.issue(rig.ada, client);
    await rig.delegations.revoke(rig.ada, revoked.delegationId);
    expect(await rig.verifier.resolve(revoked.tokens.access_token)).toBeNull();

    const removed = await rig.issue(rig.bob, client);
    rig.store.db.prepare("UPDATE users SET status = 'removed' WHERE id = ?").run(rig.bob.id);
    expect(await rig.verifier.resolve(removed.tokens.access_token)).toBeNull();
  });

  describe('the client’s status is evaluated at every verification', () => {
    /** The same store read under another registration policy: what a restart with a new configuration sees. */
    function verifierUnder(
      registration: Partial<typeof DEFAULT_TEST_OAUTH.clientRegistration>,
    ): DelegatedTokenVerifier {
      const clients = new ClientRegistry({
        repo: rig.store.delegations,
        config: { ...DEFAULT_TEST_OAUTH.clientRegistration, ...registration },
        audit: rig.audit,
        rateLimiter: { take: async () => ({ allowed: true, remaining: 1, retryAfterMs: 0 }) },
        clock: rig.clock,
        logger: silentLogger,
      });
      return new DelegatedTokenVerifier({
        repo: rig.store.delegations,
        users: rig.store.users,
        clients,
        lifetime: delegationLifetime(DEFAULT_TEST_OAUTH.delegationMaxLifetimeSeconds, rig.clock),
      });
    }

    it('a tightened policy applies to tokens already issued: the delegation is active, the token is worth nothing', async () => {
      const { tokens, delegationId } = await rig.issue(rig.ada, client);
      expect(await rig.verifier.resolve(tokens.access_token)).not.toBeNull();

      for (const registration of [{ policy: 'closed' as const }, { autoApproveLoopback: false }]) {
        expect(await verifierUnder(registration).resolve(tokens.access_token)).toBeNull();
      }
      // Nothing was revoked: relaxing the policy again restores the token.
      expect(await rig.store.delegations.getById(delegationId)).toMatchObject({ status: 'active' });
      expect(await verifierUnder({ policy: 'open' }).resolve(tokens.access_token)).not.toBeNull();
    });

    it('an operator’s approval holds whatever the policy becomes', async () => {
      const { tokens } = await rig.issue(rig.ada, client);
      await rig.clients.decide('operator-1', client.id, 'approved');
      expect(await verifierUnder({ policy: 'closed' }).resolve(tokens.access_token)).not.toBeNull();
    });

    it('a client marked disabled is refused even while one of its delegations is still active', async () => {
      const { tokens, delegationId } = await rig.issue(rig.ada, client);
      // The decision alone, as a store that failed between the two writes would have left it.
      await rig.store.delegations.decideClient(client.id, 'disabled', 'operator-1');
      expect(await rig.store.delegations.getById(delegationId)).toMatchObject({ status: 'active' });
      expect(await rig.verifier.resolve(tokens.access_token)).toBeNull();
    });

    it('a client whose redirect URIs left the loopback interface goes back to pending, and its tokens with it', async () => {
      const { tokens } = await rig.issue(rig.ada, client);
      await rig.store.delegations.updateClientDocument(client.id, {
        name: client.name,
        redirectUris: [LOOPBACK_REDIRECT, WEB_REDIRECT],
        clientUri: null,
        metadataExpiresAt: rig.clock.now().toISOString(),
      });
      expect(await rig.verifier.resolve(tokens.access_token)).toBeNull();
    });
  });

  describe('endDelegation: one function revokes and leaves the entry', () => {
    const deps = () => ({
      repo: rig.store.delegations,
      missions: rig.store.missions,
      audit: rig.audit,
      clock: rig.clock,
      logger: silentLogger,
    });

    it('names the delegating user when somebody else acts, and the client when the act came through it', async () => {
      const byOperator = await rig.issue(rig.ada, client);
      const byClient = await rig.issue(rig.bob, client);
      rig.audit.entries.length = 0;

      await endDelegation(deps(), byOperator.delegationId, {
        reason: 'operator',
        actorId: 'operator-1',
        viaClient: false,
      });
      await endDelegation(deps(), byClient.delegationId, {
        reason: 'client',
        actorId: rig.bob.id,
        viaClient: true,
      });
      expect(rig.audit.admin).toEqual([
        {
          kind: 'admin',
          ts: rig.clock.now().toISOString(),
          user_id: 'operator-1',
          act: 'delegation-revoked',
          object: { type: 'delegation', id: byOperator.delegationId },
          before: { status: 'active' },
          after: {
            status: 'revoked',
            reason: 'operator',
            delegating_user_id: rig.ada.id,
            client_id: client.clientId,
            client_name: client.name,
          },
          delegated_client_id: null,
        },
        {
          kind: 'admin',
          ts: rig.clock.now().toISOString(),
          user_id: rig.bob.id,
          act: 'delegation-revoked',
          object: { type: 'delegation', id: byClient.delegationId },
          before: { status: 'active' },
          after: {
            status: 'revoked',
            reason: 'client',
            client_id: client.clientId,
            client_name: client.name,
          },
          delegated_client_id: client.clientId,
        },
      ]);
    });

    it('answers null and writes nothing for a delegation already revoked, or unknown', async () => {
      const { delegationId } = await rig.issue(rig.ada, client);
      const by = { reason: 'user', actorId: rig.ada.id, viaClient: false } as const;
      expect(await endDelegation(deps(), delegationId, by)).toMatchObject({ status: 'revoked' });
      rig.audit.entries.length = 0;
      expect(await endDelegation(deps(), delegationId, by)).toBeNull();
      expect(await endDelegation(deps(), 'no-such-delegation', by)).toBeNull();
      expect(rig.audit.entries).toEqual([]);
    });
  });
});
