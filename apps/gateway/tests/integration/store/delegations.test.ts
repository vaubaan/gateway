/**
 * Delegations: OAuth clients, consents, single-use codes, rotating refresh tokens and
 * revocable access tokens of the management door. Spec §4.1 bis, §6.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/server/store/index.ts';
import {
  issueFirstRefreshToken,
  openTestStore,
  type TestStore,
} from '../../../src/server/store/testing.ts';

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

  it('refresh tokens rotate: the old one is revoked and linked to its successor', async () => {
    const d = await store.delegations.create({ userId: user, clientId, scope: 's' });
    const first = await issueFirstRefreshToken(store, d.id, {
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
  });

  describe('redeemCode: the code grant as one transaction', () => {
    const NEXT = {
      refresh: { tokenHash: 'r1', expiresAt: '2026-11-13T09:00:00.000Z' },
      access: { tokenHash: 'a1', expiresAt: '2026-10-13T09:15:00.000Z' },
    };
    const count = (table: string): number =>
      store.db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;
    const consumedAt = (hash: string): string | null | undefined =>
      store.db
        .prepare<
          [string],
          { consumed_at: string | null }
        >('SELECT consumed_at FROM oauth_codes WHERE code_hash = ?')
        .get(hash)?.consumed_at;

    async function codeOf(hash = 'code-hash') {
      const d = await store.delegations.create({ userId: user, clientId, scope: 's' });
      await store.delegations.createCode({
        delegationId: d.id,
        codeHash: hash,
        redirectUri: 'http://127.0.0.1/callback',
        codeChallenge: 'challenge',
        codeChallengeMethod: 'S256',
        expiresAt: '2026-10-13T09:05:00.000Z',
      });
      return d;
    }

    it('spends the code and writes the first pair, once', async () => {
      const d = await codeOf();
      const seen: unknown[] = [];
      const first = await store.delegations.redeemCode(
        'code-hash',
        (code, delegation) => {
          seen.push([code.consumedAt, code.codeChallenge, delegation.id]);
          return null;
        },
        NEXT,
      );
      expect(first).toMatchObject({ outcome: 'issued', delegation: { id: d.id } });
      // The check judged the spent code.
      expect(seen).toEqual([[t.clock.now().toISOString(), 'challenge', d.id]]);
      expect(await store.delegations.findActiveAccessToken('a1')).not.toBeNull();
      expect((await store.delegations.findRefreshToken('r1'))?.delegation.id).toBe(d.id);

      const again = await store.delegations.redeemCode('code-hash', () => null, {
        refresh: { ...NEXT.refresh, tokenHash: 'r2' },
        access: { ...NEXT.access, tokenHash: 'a2' },
      });
      expect(again).toMatchObject({ outcome: 'replayed', delegation: { id: d.id } });
      expect(count('oauth_refresh_tokens')).toBe(1);
      expect(count('oauth_access_tokens')).toBe(1);
    });

    it('a refusal of the check spends the code and writes no token', async () => {
      await codeOf();
      expect(
        await store.delegations.redeemCode('code-hash', () => 'wrong verifier', NEXT),
      ).toMatchObject({ outcome: 'refused', reason: 'wrong verifier' });
      expect(consumedAt('code-hash')).toBe(t.clock.now().toISOString());
      expect(count('oauth_refresh_tokens') + count('oauth_access_tokens')).toBe(0);
    });

    it('a revoked delegation is refused after the check, the code spent', async () => {
      const d = await codeOf();
      await store.delegations.revoke(d.id, 'user');
      expect(await store.delegations.redeemCode('code-hash', () => null, NEXT)).toMatchObject({
        outcome: 'refused',
        reason: 'delegation-revoked',
      });
      expect(consumedAt('code-hash')).toBe(t.clock.now().toISOString());
      expect(count('oauth_refresh_tokens') + count('oauth_access_tokens')).toBe(0);
    });

    it('an unknown or an expired code changes nothing, and the check is not asked', async () => {
      await codeOf();
      const check = (): string | null => {
        throw new Error('the check must not run');
      };
      expect(await store.delegations.redeemCode('nope', check, NEXT)).toEqual({
        outcome: 'unknown',
      });
      t.clock.set('2026-10-13T09:05:00.000Z');
      expect(await store.delegations.redeemCode('code-hash', check, NEXT)).toEqual({
        outcome: 'expired',
      });
      expect(consumedAt('code-hash')).toBeNull();
    });

    it.each(['oauth_refresh_tokens', 'oauth_access_tokens'])(
      'a failed insert into %s rolls everything back: the code is unspent and no token exists',
      async (table) => {
        await codeOf();
        store.db.exec(
          `CREATE TRIGGER fault BEFORE INSERT ON ${table}
           BEGIN SELECT RAISE(ABORT, 'simulated store fault'); END`,
        );
        await expect(store.delegations.redeemCode('code-hash', () => null, NEXT)).rejects.toThrow(
          /simulated store fault/,
        );
        expect(consumedAt('code-hash')).toBeNull();
        expect(count('oauth_refresh_tokens') + count('oauth_access_tokens')).toBe(0);

        store.db.exec('DROP TRIGGER fault');
        expect(await store.delegations.redeemCode('code-hash', () => null, NEXT)).toMatchObject({
          outcome: 'issued',
        });
      },
    );
  });

  describe('a rotation writes the access token of the renewal in the same transaction', () => {
    const refreshRows = () =>
      store.db
        .prepare<
          [],
          { token_hash: string; revoked_at: string | null }
        >('SELECT token_hash, revoked_at FROM oauth_refresh_tokens ORDER BY created_at, token_hash')
        .all();

    it('rotateRefreshToken with an access token: both rows, or neither', async () => {
      const d = await store.delegations.create({ userId: user, clientId, scope: 's' });
      await issueFirstRefreshToken(store, d.id, {
        tokenHash: 'r1',
        expiresAt: '2026-11-13T09:00:00.000Z',
      });
      store.db.exec(
        `CREATE TRIGGER fault BEFORE INSERT ON oauth_access_tokens
         BEGIN SELECT RAISE(ABORT, 'simulated store fault'); END`,
      );
      await expect(
        store.delegations.rotateRefreshToken(
          'r1',
          { tokenHash: 'r2', expiresAt: '2026-12-13T09:00:00.000Z' },
          { tokenHash: 'a2', expiresAt: '2026-10-13T09:15:00.000Z' },
        ),
      ).rejects.toThrow(/simulated store fault/);
      expect(refreshRows()).toEqual([{ token_hash: 'r1', revoked_at: null }]);

      store.db.exec('DROP TRIGGER fault');
      const next = await store.delegations.rotateRefreshToken(
        'r1',
        { tokenHash: 'r2', expiresAt: '2026-12-13T09:00:00.000Z' },
        { tokenHash: 'a2', expiresAt: '2026-10-13T09:15:00.000Z' },
      );
      expect(next?.delegationId).toBe(d.id);
      expect((await store.delegations.findActiveAccessToken('a2'))?.delegation.id).toBe(d.id);
      expect(refreshRows()).toEqual([
        { token_hash: 'r1', revoked_at: t.clock.now().toISOString() },
        { token_hash: 'r2', revoked_at: null },
      ]);
    });

    it('rotateSuccessorOf with an access token: both rows, or the head is left as it was', async () => {
      const d = await store.delegations.create({ userId: user, clientId, scope: 's' });
      await issueFirstRefreshToken(store, d.id, {
        tokenHash: 'r1',
        expiresAt: '2026-11-13T09:00:00.000Z',
      });
      await store.delegations.rotateRefreshToken('r1', {
        tokenHash: 'r2',
        expiresAt: '2026-11-13T09:00:00.000Z',
      });
      const since = t.clock.now().toISOString();
      const before = refreshRows();
      store.db.exec(
        `CREATE TRIGGER fault BEFORE INSERT ON oauth_access_tokens
         BEGIN SELECT RAISE(ABORT, 'simulated store fault'); END`,
      );
      const reuse = () =>
        store.delegations.rotateSuccessorOf(
          'r1',
          since,
          { tokenHash: 'r3', expiresAt: '2026-11-13T09:00:00.000Z' },
          { tokenHash: 'a3', expiresAt: '2026-10-13T09:15:00.000Z' },
        );
      await expect(reuse()).rejects.toThrow(/simulated store fault/);
      expect(refreshRows()).toEqual(before);

      store.db.exec('DROP TRIGGER fault');
      expect((await reuse())?.delegationId).toBe(d.id);
      expect(await store.delegations.findActiveAccessToken('a3')).not.toBeNull();
    });
  });

  describe('disableClient: the decision and the revocations are one transaction', () => {
    it('disables the client and revokes its active delegations with their tokens, and only those', async () => {
      const other = (
        await store.delegations.registerClient({
          clientId: 'other',
          name: 'Other',
          redirectUris: ['http://127.0.0.1/cb'],
        })
      ).id;
      const first = await store.delegations.create({ userId: user, clientId, scope: 's' });
      const gone = await store.delegations.create({ userId: user, clientId, scope: 's' });
      await store.delegations.revoke(gone.id, 'user');
      const untouched = await store.delegations.create({
        userId: user,
        clientId: other,
        scope: 's',
      });
      for (const [d, hash] of [
        [first, 'a-first'],
        [untouched, 'a-untouched'],
      ] as const) {
        await store.delegations.createAccessToken({
          delegationId: d.id,
          tokenHash: hash,
          expiresAt: '2026-10-13T10:00:00.000Z',
        });
      }

      const { client, revoked } = await store.delegations.disableClient(clientId, 'operator-1');
      expect(client).toMatchObject({ operatorDecision: 'disabled', decidedBy: 'operator-1' });
      // Only what this call ended: the delegation revoked earlier keeps its own reason.
      expect(revoked.map((d) => [d.id, d.status, d.revokeReason])).toEqual([
        [first.id, 'revoked', 'operator'],
      ]);
      expect((await store.delegations.getById(gone.id))?.revokeReason).toBe('user');
      expect(await store.delegations.findActiveAccessToken('a-first')).toBeNull();
      expect(await store.delegations.findActiveAccessToken('a-untouched')).not.toBeNull();
      // Again: nothing left to revoke.
      expect((await store.delegations.disableClient(clientId, 'operator-2')).revoked).toEqual([]);
      await expect(store.delegations.disableClient('missing', 'operator-1')).rejects.toThrow(
        /oauth_client/,
      );
    });

    it('interrupted half-way, nothing is changed: the client is not disabled and every delegation lives', async () => {
      const first = await store.delegations.create({ userId: user, clientId, scope: 's' });
      const second = await store.delegations.create({ userId: user, clientId, scope: 's' });
      await store.delegations.createAccessToken({
        delegationId: second.id,
        tokenHash: 'a-second',
        expiresAt: '2026-10-13T10:00:00.000Z',
      });
      // The decision and a delegation are written, then a token cannot be revoked.
      store.db.exec(
        `CREATE TRIGGER fault BEFORE UPDATE ON oauth_access_tokens
         BEGIN SELECT RAISE(ABORT, 'simulated store fault'); END`,
      );
      await expect(store.delegations.disableClient(clientId, 'operator-1')).rejects.toThrow(
        /simulated store fault/,
      );
      expect(await store.delegations.getClient(clientId)).toMatchObject({
        operatorDecision: null,
      });
      for (const d of [first, second]) {
        expect((await store.delegations.getById(d.id))?.status).toBe('active');
      }
      expect(await store.delegations.findActiveAccessToken('a-second')).not.toBeNull();
    });
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
    await issueFirstRefreshToken(store, d.id, {
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
      await issueFirstRefreshToken(store, d.id, {
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
      await issueFirstRefreshToken(store, d.id, {
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
