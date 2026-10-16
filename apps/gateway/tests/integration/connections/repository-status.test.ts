/**
 * Connection statuses at the repository (spec §2.3): `revoked` is terminal
 * whatever writer is called, and an `unowned` connection keeps serving (its
 * refreshed credential is persisted) while it cannot be reconnected.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Store } from '../../../src/server/store/index.ts';
import { makeUnowned, openTestStore, type TestStore } from '../../../src/server/store/testing.ts';

describe('connection statuses at the repository', () => {
  let t: TestStore;
  let store: Store;
  let connectionId: string;

  beforeEach(async () => {
    t = openTestStore();
    store = t.store;
    const owner = await store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'o',
      email: 'o@example.com',
    });
    const connection = await store.connections.create({
      provider: 'github',
      owner: { kind: 'user', id: owner.id },
      displayName: 'GitHub',
      credential: 'token-1',
    });
    connectionId = connection.id;
  });
  afterEach(() => store.close());

  describe('revoked is terminal', () => {
    beforeEach(async () => {
      await store.connections.revoke(connectionId);
    });

    it('no credential writer touches a revoked connection: nothing is written', async () => {
      expect(await store.connections.reconnect(connectionId, 'token-2')).toBe(false);
      expect(await store.connections.refreshCredential(connectionId, 'token-2')).toBe(false);
      expect(await store.connections.getCredential(connectionId)).toBeNull();
      expect(await store.connections.getById(connectionId)).toMatchObject({
        status: 'revoked',
        keyVersion: null,
      });
    });

    it('no status writer moves a revoked connection', async () => {
      expect(await store.connections.markExpired(connectionId)).toBe(false);
      await expect(makeUnowned(store, connectionId)).rejects.toThrow(/revoked/);
      expect(await store.connections.getById(connectionId)).toMatchObject({
        status: 'revoked',
        owner: { kind: 'user' },
      });
    });

    it('revoking again stays idempotent and keeps the first revocation date', async () => {
      const before = await store.connections.getById(connectionId);
      t.clock.advance(60_000);
      const after = await store.connections.revoke(connectionId);
      expect(after.status).toBe('revoked');
      expect(after.revokedAt).toBe(before?.revokedAt);
    });
  });

  describe('unowned keeps serving and cannot be reconnected', () => {
    beforeEach(async () => {
      await makeUnowned(store, connectionId);
    });

    it('persists a refreshed credential and leaves the status alone', async () => {
      expect(
        await store.connections.refreshCredential(
          connectionId,
          'token-2',
          '2027-01-01T00:00:00.000Z',
        ),
      ).toBe(true);
      expect(await store.connections.getCredential(connectionId)).toBe('token-2');
      expect(await store.connections.getById(connectionId)).toMatchObject({
        status: 'unowned',
        credentialExpiresAt: '2027-01-01T00:00:00.000Z',
      });
    });

    it('refuses a reconnection: nothing is written and the status stays unowned', async () => {
      expect(await store.connections.reconnect(connectionId, 'token-2')).toBe(false);
      expect(await store.connections.getCredential(connectionId)).toBe('token-1');
      expect((await store.connections.getById(connectionId))?.status).toBe('unowned');
    });

    it('can still be revoked', async () => {
      expect((await store.connections.revoke(connectionId)).status).toBe('revoked');
    });
  });
});
