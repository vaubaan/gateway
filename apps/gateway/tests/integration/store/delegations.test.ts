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
  });
});
