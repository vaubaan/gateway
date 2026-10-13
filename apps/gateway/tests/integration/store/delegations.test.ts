/**
 * Delegations: OAuth clients, consents, single-use codes, rotating refresh tokens and
 * revocable access tokens of the management door. Spec §4.1 bis, §6.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/server/store/index.ts';
import { openTestStore, type TestStore } from '../../../src/server/store/testing.ts';

describe('delegations repository', () => {
  let t: TestStore;
  let store: Store;
  let user: string;
  let clientId: string;

  beforeEach(async () => {
    t = openTestStore();
    store = t.store;
    user = (await store.users.upsertFromIdp({ subject: 'u', email: 'u@x' })).id;
    clientId = (
      await store.delegations.registerClient({
        clientId: 'claude-code',
        name: 'Claude Code',
        redirectUris: ['http://127.0.0.1/callback', 'http://127.0.0.1/callback'],
      })
    ).id;
  });
  afterEach(() => store.close());

  it('registers a public client with de-duplicated redirect URIs', async () => {
    const client = await store.delegations.getClientByClientId('claude-code');
    expect(client).toMatchObject({
      id: clientId,
      clientSecretHash: null,
      redirectUris: ['http://127.0.0.1/callback'],
    });
    expect(await store.delegations.getClient(clientId)).toEqual(client);
    await expect(
      store.delegations.registerClient({ clientId: 'x', name: 'x', redirectUris: [] }),
    ).rejects.toThrow(/redirect URI/);
    await expect(
      store.delegations.registerClient({
        clientId: 'claude-code',
        name: 'dup',
        redirectUris: ['a'],
      }),
    ).rejects.toThrow(/UNIQUE/);
  });

  it('records a consent and lists it for the user', async () => {
    const d = await store.delegations.create({ userId: user, clientId, scope: 'missions:manage' });
    expect(d).toMatchObject({ userId: user, clientId, scope: 'missions:manage', status: 'active' });
    expect(await store.delegations.listForUser(user)).toEqual([d]);
    expect(await store.delegations.getById(d.id)).toEqual(d);
  });

  it('authorization codes are single-use and expire', async () => {
    const d = await store.delegations.create({ userId: user, clientId, scope: 's' });
    const code = await store.delegations.createCode({
      delegationId: d.id,
      codeHash: 'code-hash',
      redirectUri: 'http://127.0.0.1/callback',
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
      expiresAt: '2026-10-13T09:05:00.000Z',
    });
    const consumed = await store.delegations.consumeCode('code-hash');
    expect(consumed?.id).toBe(code.id);
    expect(consumed?.consumedAt).toBe(t.clock.now().toISOString());
    expect(await store.delegations.consumeCode('code-hash')).toBeNull();

    await store.delegations.createCode({
      delegationId: d.id,
      codeHash: 'late',
      redirectUri: 'http://127.0.0.1/callback',
      codeChallenge: 'c',
      codeChallengeMethod: 'S256',
      expiresAt: '2026-10-13T09:05:00.000Z',
    });
    t.clock.set('2026-10-13T09:05:00.000Z');
    expect(await store.delegations.consumeCode('late')).toBeNull();
  });

  it('refresh tokens rotate: the old one is revoked and linked to its successor', async () => {
    const d = await store.delegations.create({ userId: user, clientId, scope: 's' });
    const first = await store.delegations.createRefreshToken({
      delegationId: d.id,
      tokenHash: 'r1',
      expiresAt: '2026-11-13T09:00:00.000Z',
    });
    const second = await store.delegations.rotateRefreshToken('r1', {
      tokenHash: 'r2',
      expiresAt: '2026-12-13T09:00:00.000Z',
    });
    expect(second?.delegationId).toBe(d.id);
    expect(
      await store.delegations.rotateRefreshToken('r1', { tokenHash: 'r3', expiresAt: 'x' }),
    ).toBeNull();
    const rows = store.db
      .prepare<
        [string],
        { id: string; revoked_at: string | null; replaced_by_id: string | null }
      >('SELECT id, revoked_at, replaced_by_id FROM oauth_refresh_tokens WHERE delegation_id = ? ORDER BY created_at')
      .all(d.id);
    expect(rows).toEqual([
      { id: first.id, revoked_at: t.clock.now().toISOString(), replaced_by_id: second?.id ?? null },
      { id: second?.id ?? '', revoked_at: null, replaced_by_id: null },
    ]);
    expect(await store.delegations.revokeRefreshToken(second?.id ?? '')).toBe(true);
    expect(await store.delegations.revokeRefreshToken(second?.id ?? '')).toBe(false);
  });

  it('access tokens are found only while live and while the delegation is active', async () => {
    const d = await store.delegations.create({ userId: user, clientId, scope: 's' });
    const token = await store.delegations.createAccessToken({
      delegationId: d.id,
      tokenHash: 'a1',
      expiresAt: '2026-10-13T10:00:00.000Z',
    });
    const found = await store.delegations.findActiveAccessToken('a1');
    expect(found?.token.id).toBe(token.id);
    expect(found?.delegation.userId).toBe(user);
    expect(await store.delegations.findActiveAccessToken('nope')).toBeNull();

    expect(await store.delegations.revokeAccessToken(token.id)).toBe(true);
    expect(await store.delegations.findActiveAccessToken('a1')).toBeNull();
  });

  it('revoking the delegation revokes every token under it', async () => {
    const d = await store.delegations.create({ userId: user, clientId, scope: 's' });
    await store.delegations.createAccessToken({
      delegationId: d.id,
      tokenHash: 'a1',
      expiresAt: '2026-10-13T10:00:00.000Z',
    });
    await store.delegations.createRefreshToken({
      delegationId: d.id,
      tokenHash: 'r1',
      expiresAt: '2026-11-13T09:00:00.000Z',
    });
    const revoked = await store.delegations.revoke(d.id);
    expect(revoked.status).toBe('revoked');
    expect(await store.delegations.findActiveAccessToken('a1')).toBeNull();
    expect(
      await store.delegations.rotateRefreshToken('r1', { tokenHash: 'r2', expiresAt: 'x' }),
    ).toBeNull();
    await expect(
      store.delegations.createAccessToken({ delegationId: d.id, tokenHash: 'a2', expiresAt: 'x' }),
    ).rejects.toThrow(/revoked/);
    await expect(store.delegations.revoke('missing')).rejects.toThrow(/not found/);
  });

  it('a mission issued by delegation records the delegation id', async () => {
    const d = await store.delegations.create({ userId: user, clientId, scope: 's' });
    const connection = await store.connections.create({
      provider: 'github',
      owner: { kind: 'user', id: user },
      displayName: 'gh',
      credential: null,
    });
    const m = await store.missions.create({
      name: 'by agent',
      creatorUserId: user,
      periodSeconds: null,
      delegationId: d.id,
      connections: [{ connectionId: connection.id, resourceScope: 'all', resourceIds: [] }],
      policy: [
        { riskId: 'github.code-read', quota: 1, rateLimit: 1, rateWindowSeconds: 60, gate: 'auto' },
      ],
    });
    expect(m.delegationId).toBe(d.id);

    // `issued_via`: the client behind the mission, read through the delegation it names.
    const own = await store.missions.create({
      name: 'by hand',
      creatorUserId: user,
      periodSeconds: null,
      connections: [{ connectionId: connection.id, resourceScope: 'all', resourceIds: [] }],
      policy: [
        { riskId: 'github.code-read', quota: 1, rateLimit: 1, rateWindowSeconds: 60, gate: 'auto' },
      ],
    });
    const issuers = await store.missions.issuersOf([m.id, own.id, m.id, 'missing']);
    expect([...issuers]).toEqual([
      [
        m.id,
        { missionId: m.id, delegationId: d.id, clientId: 'claude-code', clientName: 'Claude Code' },
      ],
    ]);
    expect(await store.missions.issuersOf([])).toEqual(new Map());
    // A revoked delegation still names who issued the mission.
    await store.delegations.revoke(d.id, 'user');
    expect((await store.missions.issuersOf([m.id])).get(m.id)?.clientId).toBe('claude-code');
  });

  describe('rotateSuccessorOf — the reuse window of a rotation', () => {
    const NEXT = { expiresAt: '2026-12-13T09:00:00.000Z' };

    async function rotatedOnce() {
      const d = await store.delegations.create({ userId: user, clientId, scope: 's' });
      await store.delegations.createRefreshToken({
        delegationId: d.id,
        tokenHash: 'r1',
        expiresAt: '2026-11-13T09:00:00.000Z',
      });
      const rotatedAt = t.clock.now().toISOString();
      const second = await store.delegations.rotateRefreshToken('r1', { tokenHash: 'r2', ...NEXT });
      return { d, rotatedAt, second };
    }

    it('rotates the live head when the presented token is its immediate predecessor, rotated since the instant given', async () => {
      const { d, rotatedAt, second } = await rotatedOnce();
      t.clock.advance(10_000);
      const third = await store.delegations.rotateSuccessorOf('r1', rotatedAt, {
        tokenHash: 'r3',
        ...NEXT,
      });
      expect(third).toMatchObject({ delegationId: d.id, revokedAt: null, replacedById: null });
      const head = await store.delegations.findRefreshToken('r2');
      expect(head?.token).toMatchObject({
        id: second?.id,
        replacedById: third?.id,
        revokedAt: t.clock.now().toISOString(),
      });
      // One live head, and the family is a chain: r1 → r2 → r3.
      expect((await store.delegations.findRefreshToken('r1'))?.token.replacedById).toBe(second?.id);
      const live = store.db
        .prepare<
          [],
          { n: number }
        >('SELECT COUNT(*) AS n FROM oauth_refresh_tokens WHERE revoked_at IS NULL')
        .get();
      expect(live?.n).toBe(1);
    });

    it('answers null when the token was rotated before the instant given', async () => {
      const { rotatedAt } = await rotatedOnce();
      const later = new Date(Date.parse(rotatedAt) + 1).toISOString();
      expect(
        await store.delegations.rotateSuccessorOf('r1', later, { tokenHash: 'r3', ...NEXT }),
      ).toBeNull();
      expect((await store.delegations.findRefreshToken('r2'))?.token.revokedAt).toBeNull();
    });

    it('answers null when the successor is no longer the head, or the token was never rotated, or is unknown', async () => {
      const { rotatedAt } = await rotatedOnce();
      // The head itself: never rotated.
      expect(
        await store.delegations.rotateSuccessorOf('r2', rotatedAt, { tokenHash: 'x1', ...NEXT }),
      ).toBeNull();
      expect(
        await store.delegations.rotateSuccessorOf('nope', rotatedAt, { tokenHash: 'x2', ...NEXT }),
      ).toBeNull();
      // The head moves on: r1's successor is now rotated too.
      await store.delegations.rotateRefreshToken('r2', { tokenHash: 'r3', ...NEXT });
      expect(
        await store.delegations.rotateSuccessorOf('r1', rotatedAt, { tokenHash: 'x3', ...NEXT }),
      ).toBeNull();
    });

    it('answers null once the delegation is revoked or the head expired', async () => {
      const revoked = await rotatedOnce();
      await store.delegations.revoke(revoked.d.id, 'user');
      expect(
        await store.delegations.rotateSuccessorOf('r1', revoked.rotatedAt, {
          tokenHash: 'x1',
          ...NEXT,
        }),
      ).toBeNull();

      const d = await store.delegations.create({ userId: user, clientId, scope: 's' });
      await store.delegations.createRefreshToken({
        delegationId: d.id,
        tokenHash: 'e1',
        expiresAt: '2026-11-13T09:00:00.000Z',
      });
      const rotatedAt = t.clock.now().toISOString();
      await store.delegations.rotateRefreshToken('e1', {
        tokenHash: 'e2',
        expiresAt: new Date(t.clock.now().getTime() + 1_000).toISOString(),
      });
      t.clock.advance(2_000);
      expect(
        await store.delegations.rotateSuccessorOf('e1', rotatedAt, { tokenHash: 'x2', ...NEXT }),
      ).toBeNull();
    });
  });
});
