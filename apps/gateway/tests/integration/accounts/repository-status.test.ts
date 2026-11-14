/**
 * Account statuses at the repository (spec §2.3): `revoked` is terminal
 * whatever writer is called, and an `unowned` account keeps serving (its
 * refreshed credential is persisted) while it cannot be reconnected.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Store } from '../../../src/server/store/index.ts';
import { makeUnowned, openTestStore, type TestStore } from '../../support/store/testing.ts';

describe('account statuses at the repository', () => {
  let t: TestStore;
  let store: Store;
  let accountId: string;

  beforeEach(async () => {
    t = openTestStore();
    store = t.store;
    const owner = await store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'o',
      email: 'o@example.com',
    });
    const account = await store.accounts.create({
      provider: 'github',
      owner: { kind: 'user', id: owner.id },
      displayName: 'GitHub',
      credential: 'token-1',
    });
    accountId = account.id;
  });
  afterEach(() => store.close());

  describe('revoked is terminal', () => {
    beforeEach(async () => {
      await store.accounts.revoke(accountId);
    });

    it('no credential writer touches a revoked account: nothing is written', async () => {
      expect(await store.accounts.reconnect(accountId, 'token-2')).toBe(false);
      expect(await store.accounts.refreshCredential(accountId, 'token-2')).toBe(false);
      expect(await store.accounts.getCredential(accountId)).toBeNull();
      expect(await store.accounts.getById(accountId)).toMatchObject({
        status: 'revoked',
        keyVersion: null,
      });
    });

    it('no status writer moves a revoked account', async () => {
      expect(await store.accounts.markExpired(accountId)).toBe(false);
      await expect(makeUnowned(store, accountId)).rejects.toThrow(/revoked/);
      expect(await store.accounts.getById(accountId)).toMatchObject({
        status: 'revoked',
        owner: { kind: 'user' },
      });
    });

    it('revoking again stays idempotent and keeps the first revocation date', async () => {
      const before = await store.accounts.getById(accountId);
      t.clock.advance(60_000);
      const after = await store.accounts.revoke(accountId);
      expect(after.status).toBe('revoked');
      expect(after.revokedAt).toBe(before?.revokedAt);
    });
  });

  describe('unowned keeps serving and cannot be reconnected', () => {
    beforeEach(async () => {
      await makeUnowned(store, accountId);
    });

    it('persists a refreshed credential and leaves the status alone', async () => {
      expect(
        await store.accounts.refreshCredential(accountId, 'token-2', '2027-01-01T00:00:00.000Z'),
      ).toBe(true);
      expect(await store.accounts.getCredential(accountId)).toBe('token-2');
      expect(await store.accounts.getById(accountId)).toMatchObject({
        status: 'unowned',
        credentialExpiresAt: '2027-01-01T00:00:00.000Z',
      });
    });

    it('refuses a reconnection: nothing is written and the status stays unowned', async () => {
      expect(await store.accounts.reconnect(accountId, 'token-2')).toBe(false);
      expect(await store.accounts.getCredential(accountId)).toBe('token-1');
      expect((await store.accounts.getById(accountId))?.status).toBe('unowned');
    });

    it('can still be revoked', async () => {
      expect((await store.accounts.revoke(accountId)).status).toBe('revoked');
    });
  });
});
