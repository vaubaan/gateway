/**
 * What migration 0006 and the authorization server (P2.3) added to the
 * delegations repository: client registration kinds and operator decisions,
 * revocation reasons, the lookups a replay is recognised with, token activity,
 * the sweep of expired rows, and the audit scope of a user's own delegations.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Store } from '../../../src/server/store/index.ts';
import { openTestStore, type TestStore } from '../../../src/server/store/testing.ts';

const LOOPBACK = 'http://127.0.0.1/callback';
const DAY_MS = 86_400_000;

describe('delegations repository — clients, reasons, replay lookups, sweep', () => {
  let t: TestStore;
  let store: Store;
  let user: string;

  beforeEach(async () => {
    t = openTestStore();
    store = t.store;
    user = (await store.users.upsertFromIdp({ subject: 'u', email: 'u@example.com' })).id;
  });
  afterEach(() => store.close());

  const at = (offsetMs: number): string =>
    new Date(t.clock.now().getTime() + offsetMs).toISOString();

  async function client(clientId: string) {
    return store.delegations.registerClient({ clientId, name: clientId, redirectUris: [LOOPBACK] });
  }

  describe('clients', () => {
    it('registers a dynamic public client by default, undecided', async () => {
      expect(await client('c1')).toMatchObject({
        registration: 'dynamic',
        tokenEndpointAuthMethod: 'none',
        clientSecretHash: null,
        clientUri: null,
        metadataExpiresAt: null,
        operatorDecision: null,
        decidedAt: null,
        decidedBy: null,
      });
    });

    it('stores what a confidential or a metadata-document client declares', async () => {
      const confidential = await store.delegations.registerClient({
        clientId: 'c2',
        name: 'Confidential',
        clientSecretHash: 'digest',
        redirectUris: ['https://app.example.com/cb'],
        tokenEndpointAuthMethod: 'client_secret_basic',
        clientUri: 'https://app.example.com/',
      });
      expect(confidential).toMatchObject({
        clientSecretHash: 'digest',
        tokenEndpointAuthMethod: 'client_secret_basic',
        clientUri: 'https://app.example.com/',
      });
      const document = await store.delegations.registerClient({
        clientId: 'https://app.example.com/client.json',
        name: 'Document',
        redirectUris: [LOOPBACK],
        registration: 'metadata-document',
        metadataExpiresAt: at(3_600_000),
      });
      expect(document).toMatchObject({
        registration: 'metadata-document',
        metadataExpiresAt: at(3_600_000),
      });
    });

    it('lists every client, most recently registered first', async () => {
      await client('old');
      t.clock.advance(1000);
      await client('new');
      expect((await store.delegations.listClients()).map((c) => c.clientId)).toEqual([
        'new',
        'old',
      ]);
    });

    it('replaces the name and the redirect URIs a metadata document changed', async () => {
      const c = await client('doc');
      const updated = await store.delegations.updateClientDocument(c.id, {
        name: 'Renamed',
        redirectUris: ['http://localhost/cb', 'http://localhost/cb'],
        clientUri: 'https://app.example.com/',
        metadataExpiresAt: at(60_000),
      });
      expect(updated).toMatchObject({
        id: c.id,
        clientId: 'doc',
        name: 'Renamed',
        redirectUris: ['http://localhost/cb'],
        clientUri: 'https://app.example.com/',
        metadataExpiresAt: at(60_000),
      });
      await expect(
        store.delegations.updateClientDocument(c.id, {
          name: 'x',
          redirectUris: [],
          clientUri: null,
          metadataExpiresAt: at(0),
        }),
      ).rejects.toThrow(/redirect URI/);
      await expect(
        store.delegations.updateClientDocument('missing', {
          name: 'x',
          redirectUris: [LOOPBACK],
          clientUri: null,
          metadataExpiresAt: at(0),
        }),
      ).rejects.toThrow(/not found/);
    });

    it('records the operator decision, and the latest one replaces the previous', async () => {
      const c = await client('c');
      const approved = await store.delegations.decideClient(c.id, 'approved', 'operator-1');
      expect(approved).toMatchObject({
        operatorDecision: 'approved',
        decidedBy: 'operator-1',
        decidedAt: t.clock.now().toISOString(),
      });
      t.clock.advance(1000);
      expect(await store.delegations.decideClient(c.id, 'disabled', 'operator-2')).toMatchObject({
        operatorDecision: 'disabled',
        decidedBy: 'operator-2',
        decidedAt: t.clock.now().toISOString(),
      });
      await expect(store.delegations.decideClient('missing', 'approved', 'x')).rejects.toThrow(
        /not found/,
      );
    });

    it('forgets only the old clients nobody decided about and nobody consented to', async () => {
      const unused = await client('unused');
      const decided = await client('decided');
      await store.delegations.decideClient(decided.id, 'disabled', 'operator');
      const used = await client('used');
      await store.delegations.create({ userId: user, clientId: used.id, scope: 'mgmt' });
      t.clock.advance(DAY_MS);
      const recent = await client('recent');

      expect(await store.delegations.deleteUnusedClients(at(-1000))).toBe(1);
      expect(await store.delegations.getClient(unused.id)).toBeNull();
      expect(
        store.db
          .prepare<
            [string],
            { n: number }
          >('SELECT COUNT(*) AS n FROM oauth_client_redirect_uris WHERE client_id = ?')
          .get(unused.id)?.n,
      ).toBe(0);
      for (const kept of [decided, used, recent]) {
        expect(await store.delegations.getClient(kept.id)).not.toBeNull();
      }
    });
  });

  describe('delegations', () => {
    it('lists the delegations of one client', async () => {
      const a = await client('a');
      const b = await client('b');
      const first = await store.delegations.create({ userId: user, clientId: a.id, scope: 'mgmt' });
      await store.delegations.create({ userId: user, clientId: b.id, scope: 'mgmt' });
      expect((await store.delegations.listForClient(a.id)).map((d) => d.id)).toEqual([first.id]);
    });

    it('records why a delegation ended, once', async () => {
      const c = await client('c');
      const d = await store.delegations.create({ userId: user, clientId: c.id, scope: 'mgmt' });
      expect(d.revokeReason).toBeNull();
      const revoked = await store.delegations.revoke(d.id, 'refresh-token-replay');
      expect(revoked).toMatchObject({ status: 'revoked', revokeReason: 'refresh-token-replay' });
      // A second revocation changes neither the time nor the reason.
      t.clock.advance(1000);
      expect(await store.delegations.revoke(d.id, 'user')).toEqual(revoked);
    });

    it('revokeIfActive answers only to the call that revoked', async () => {
      const c = await client('c');
      const d = await store.delegations.create({ userId: user, clientId: c.id, scope: 'mgmt' });
      await store.delegations.createAccessToken({
        delegationId: d.id,
        tokenHash: 'a1',
        expiresAt: at(60_000),
      });
      const first = await store.delegations.revokeIfActive(d.id, 'user');
      expect(first).toMatchObject({ id: d.id, status: 'revoked', revokeReason: 'user' });
      expect(await store.delegations.findActiveAccessToken('a1')).toBeNull();
      expect(await store.delegations.revokeIfActive(d.id, 'operator')).toBeNull();
      expect(await store.delegations.revokeIfActive('missing', 'user')).toBeNull();
      expect((await store.delegations.getById(d.id))?.revokeReason).toBe('user');
    });

    it('reports the last token and the latest live expiry of each delegation', async () => {
      const c = await client('c');
      const quiet = await store.delegations.create({ userId: user, clientId: c.id, scope: 'mgmt' });
      const busy = await store.delegations.create({ userId: user, clientId: c.id, scope: 'mgmt' });
      await store.delegations.createRefreshToken({
        delegationId: busy.id,
        tokenHash: 'r1',
        expiresAt: at(30 * DAY_MS),
      });
      t.clock.advance(5000);
      const access = await store.delegations.createAccessToken({
        delegationId: busy.id,
        tokenHash: 'a1',
        expiresAt: at(60_000),
      });
      const activity = await store.delegations.activityOf([quiet.id, busy.id, 'missing']);
      expect(activity.has(quiet.id)).toBe(false);
      expect(activity.has('missing')).toBe(false);
      expect(activity.get(busy.id)).toEqual({
        lastTokenAt: access.createdAt,
        liveUntil: at(30 * DAY_MS - 5000),
      });

      await store.delegations.revoke(busy.id, 'user');
      expect((await store.delegations.activityOf([busy.id])).get(busy.id)).toEqual({
        lastTokenAt: access.createdAt,
        liveUntil: null,
      });
      expect((await store.delegations.activityOf([])).size).toBe(0);
    });
  });

  describe('lookups a replay is recognised with', () => {
    it('finds a code after it was consumed, with its delegation', async () => {
      const c = await client('c');
      const d = await store.delegations.create({ userId: user, clientId: c.id, scope: 'mgmt' });
      await store.delegations.createCode({
        delegationId: d.id,
        codeHash: 'code',
        redirectUri: LOOPBACK,
        codeChallenge: 'challenge',
        codeChallengeMethod: 'S256',
        expiresAt: at(60_000),
      });
      expect((await store.delegations.findCode('code'))?.token.consumedAt).toBeNull();
      await store.delegations.consumeCode('code');
      const found = await store.delegations.findCode('code');
      expect(found?.token.consumedAt).toBe(t.clock.now().toISOString());
      expect(found?.delegation.id).toBe(d.id);
      expect(await store.delegations.findCode('unknown')).toBeNull();
    });

    it('finds a refresh token after it was rotated, linked to its successor', async () => {
      const c = await client('c');
      const d = await store.delegations.create({ userId: user, clientId: c.id, scope: 'mgmt' });
      await store.delegations.createRefreshToken({
        delegationId: d.id,
        tokenHash: 'r1',
        expiresAt: at(DAY_MS),
      });
      const next = await store.delegations.rotateRefreshToken('r1', {
        tokenHash: 'r2',
        expiresAt: at(DAY_MS),
      });
      const rotated = await store.delegations.findRefreshToken('r1');
      expect(rotated?.token.replacedById).toBe(next?.id);
      expect(rotated?.token.revokedAt).not.toBeNull();
      expect(rotated?.delegation.id).toBe(d.id);
      expect((await store.delegations.findRefreshToken('r2'))?.token.replacedById).toBeNull();
      expect(await store.delegations.findRefreshToken('unknown')).toBeNull();
    });
  });

  describe('sweep of expired codes and tokens', () => {
    const count = (table: string): number =>
      store.db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;

    it('deletes what expired before the cutoff and nothing else', async () => {
      const c = await client('c');
      const d = await store.delegations.create({ userId: user, clientId: c.id, scope: 'mgmt' });
      await store.delegations.createCode({
        delegationId: d.id,
        codeHash: 'old-code',
        redirectUri: LOOPBACK,
        codeChallenge: 'x',
        codeChallengeMethod: 'S256',
        expiresAt: at(60_000),
      });
      await store.delegations.createAccessToken({
        delegationId: d.id,
        tokenHash: 'old-access',
        expiresAt: at(60_000),
      });
      await store.delegations.createAccessToken({
        delegationId: d.id,
        tokenHash: 'live-access',
        expiresAt: at(3 * DAY_MS),
      });
      t.clock.advance(2 * DAY_MS);
      expect(await store.delegations.purgeExpired(at(-DAY_MS))).toBe(2);
      expect(count('oauth_codes')).toBe(0);
      expect(count('oauth_access_tokens')).toBe(1);
      expect(await store.delegations.purgeExpired(at(-DAY_MS))).toBe(0);
    });

    it('keeps a rotated refresh token while its successor lives, so a replay is still seen', async () => {
      const c = await client('c');
      const d = await store.delegations.create({ userId: user, clientId: c.id, scope: 'mgmt' });
      await store.delegations.createRefreshToken({
        delegationId: d.id,
        tokenHash: 'r1',
        expiresAt: at(DAY_MS),
      });
      await store.delegations.rotateRefreshToken('r1', {
        tokenHash: 'r2',
        expiresAt: at(10 * DAY_MS),
      });
      t.clock.advance(3 * DAY_MS);
      // r1 expired two days ago, r2 is live: both stay.
      expect(await store.delegations.purgeExpired(at(-DAY_MS))).toBe(0);
      expect((await store.delegations.findRefreshToken('r1'))?.token.replacedById).not.toBeNull();

      t.clock.advance(10 * DAY_MS);
      // The whole chain is expired now: it goes in one sweep.
      expect(await store.delegations.purgeExpired(at(-DAY_MS))).toBe(2);
      expect(count('oauth_refresh_tokens')).toBe(0);
    });

    it('keeps a successor that expired before the token still pointing at it', async () => {
      const c = await client('c');
      const d = await store.delegations.create({ userId: user, clientId: c.id, scope: 'mgmt' });
      // The refresh lifetime was shortened between the two: the successor expires first.
      await store.delegations.createRefreshToken({
        delegationId: d.id,
        tokenHash: 'r1',
        expiresAt: at(30 * DAY_MS),
      });
      await store.delegations.rotateRefreshToken('r1', {
        tokenHash: 'r2',
        expiresAt: at(DAY_MS),
      });
      t.clock.advance(5 * DAY_MS);
      expect(await store.delegations.purgeExpired(at(-DAY_MS))).toBe(0);
      expect(count('oauth_refresh_tokens')).toBe(2);
    });
  });

  describe('audit scope', () => {
    it('shows a user the administrative entries of their own delegations only', async () => {
      const other = (await store.users.upsertFromIdp({ subject: 'o', email: 'o@example.com' })).id;
      const c = await client('c');
      const mine = await store.delegations.create({ userId: user, clientId: c.id, scope: 'mgmt' });
      const theirs = await store.delegations.create({
        userId: other,
        clientId: c.id,
        scope: 'mgmt',
      });
      for (const [actor, delegation] of [
        [user, mine],
        [other, theirs],
      ] as const) {
        await store.auditWriter.write({
          kind: 'admin',
          ts: t.clock.now().toISOString(),
          user_id: actor,
          act: 'delegation-granted',
          object: { type: 'delegation', id: delegation.id },
          before: null,
          after: { client_id: 'c' },
          delegated_client_id: null,
        });
      }
      const scopeOf = (userId: string | null, allAdmin: boolean) => ({
        scope: { missionCreatorUserId: userId, connectionOwners: [], allAdmin },
        limit: 10,
      });
      const seenBy = async (userId: string | null, allAdmin = false): Promise<string[]> =>
        (await store.audit.search(scopeOf(userId, allAdmin)))
          .map((entry) => (entry.kind === 'admin' ? entry.object.id : ''))
          .sort();

      expect(await seenBy(user)).toEqual([mine.id]);
      expect(await seenBy(other)).toEqual([theirs.id]);
      expect(await seenBy(null)).toEqual([]);
      expect(await seenBy(null, true)).toEqual([mine.id, theirs.id].sort());
    });
  });
});
