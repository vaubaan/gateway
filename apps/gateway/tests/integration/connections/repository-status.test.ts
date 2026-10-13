/**
 * Connection statuses at the repository (spec §2.3): `revoked` is terminal
 * whatever method is called, and an `unowned` connection keeps serving (its
 * refreshed credential is persisted) while it cannot be reconnected.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Store } from '../../../src/server/store/index.ts';
import { openTestStore, type TestStore } from '../../../src/server/store/testing.ts';

describe('connection statuses at the repository', () => {
  let t: TestStore;
  let store: Store;
  let connectionId: string;

  beforeEach(async () => {
    t = openTestStore();
    store = t.store;
    const owner = await store.users.upsertFromIdp({ subject: 'o', email: 'o@example.com' });
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

    it('setCredential refuses a revoked connection and writes nothing', async () => {
      await expect(store.connections.setCredential(connectionId, 'token-2')).rejects.toThrow(
        /revoked/,
      );
      expect(await store.connections.getCredential(connectionId)).toBeNull();
      expect(await store.connections.getById(connectionId)).toMatchObject({
        status: 'revoked',
        keyVersion: null,
      });
    });

    it.each(['active', 'expired', 'unowned'] as const)(
      'setStatus refuses to move a revoked connection to %s',
      async (status) => {
        await expect(store.connections.setStatus(connectionId, status)).rejects.toThrow(/revoked/);
        expect((await store.connections.getById(connectionId))?.status).toBe('revoked');
      },
    );

    it('setStatus to revoked stays idempotent and keeps the first revocation date', async () => {
      const before = await store.connections.getById(connectionId);
      t.clock.advance(60_000);
      const after = await store.connections.setStatus(connectionId, 'revoked');
      expect(after.status).toBe('revoked');
      expect(after.revokedAt).toBe(before?.revokedAt);
    });

    it('setCredential and setStatus still report a missing connection as not found', async () => {
      await expect(store.connections.setCredential('missing', 'x')).rejects.toThrow(/not found/);
      await expect(store.connections.setStatus('missing', 'expired')).rejects.toThrow(/not found/);
    });
  });

  describe('unowned keeps serving and cannot be reconnected', () => {
    beforeEach(async () => {
      await store.connections.setStatus(connectionId, 'unowned');
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
