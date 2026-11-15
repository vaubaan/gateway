/**
 * The stored states of the authority chain (spec §2.3): an account that
 * lost its owner (`unowned`) and its reassignment, the replacement of a
 * target's share, local groups. Every transition is one conditional statement
 * or one transaction. A mission that lost its grounds is *not* a stored state:
 * `orphaned` is derived on every read, and migration 0007 keeps it out of the
 * table.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MEMORY_PATH, openDb } from '../../../src/server/store/db.ts';
import type { Store } from '../../../src/server/store/index.ts';
import { loadMigrations, runMigrations } from '../../../src/server/store/migrate.ts';
import { STORED_MISSION_STATUSES } from '../../../src/server/store/repositories/enums.ts';
import { openTestStore, type TestStore } from '../../support/store/testing.ts';
import type { AccountRecord, Principal } from '../../../src/server/store/types.ts';

describe('ownership and orphan states in the store', () => {
  let t: TestStore;
  let store: Store;
  let ada: string;
  let bob: string;
  let group: string;

  beforeEach(async () => {
    t = openTestStore();
    store = t.store;
    ada = (
      await store.users.upsertFromIdp({
        issuer: 'http://idp.test',
        subject: 'a',
        email: 'ada@x',
      })
    ).id;
    bob = (
      await store.users.upsertFromIdp({
        issuer: 'http://idp.test',
        subject: 'b',
        email: 'bob@x',
      })
    ).id;
    group = (await store.groups.getOrCreate('github-admins', 'local', null)).id;
  });
  afterEach(() => store.close());

  const connect = (owner: Principal, credential: string | null = 'secret') =>
    store.accounts.create({ service: 'github', owner, displayName: 'GitHub', credential });
  const statusOf = async (c: AccountRecord) => (await store.accounts.getById(c.id))?.status;
  const byGroup: Principal = { kind: 'group', id: '' };

  describe('accounts: unowned', () => {
    beforeEach(() => {
      Object.assign(byGroup, { id: group });
    });

    it('marks unowned exactly the active accounts whose owner group has no member', async () => {
      const empty = await connect(byGroup);
      const users = await connect({ kind: 'user', id: ada });
      const populated = await store.groups.getOrCreate('populated', 'local', null);
      await store.groups.addMember(populated.id, bob);
      const owned = await connect({ kind: 'group', id: populated.id });
      const revoked = await connect(byGroup);
      await store.accounts.revoke(revoked.id);
      const expired = await connect(byGroup);
      await store.accounts.markExpired(expired.id);

      const changed = await store.accounts.markOwnerlessUnowned();

      expect(changed.map((c) => [c.id, c.status])).toEqual([[empty.id, 'unowned']]);
      expect(await statusOf(users)).toBe('active');
      expect(await statusOf(owned)).toBe('active');
      expect(await statusOf(revoked)).toBe('revoked');
      expect(await statusOf(expired)).toBe('expired');
      // Idempotent: nothing left to change.
      expect(await store.accounts.markOwnerlessUnowned()).toEqual([]);
    });

    it('lists the ownerless accounts: unowned, or expired with an empty owner group; never a revoked one', async () => {
      const unowned = await connect(byGroup);
      const expired = await connect(byGroup);
      await store.accounts.markExpired(expired.id);
      const revoked = await connect(byGroup);
      await store.accounts.revoke(revoked.id);
      await connect({ kind: 'user', id: ada });
      await store.accounts.markOwnerlessUnowned();

      expect((await store.accounts.listOwnerless()).map((c) => c.id).sort()).toEqual(
        [unowned.id, expired.id].sort(),
      );
      // A member joins: the unowned one stays listed (the operator decides), the expired one no longer is.
      await store.groups.addMember(group, bob);
      expect((await store.accounts.listOwnerless()).map((c) => c.id)).toEqual([unowned.id]);
    });

    it('assignOwnerlessTo gives an owner and makes an unowned account active again, keeping its credential', async () => {
      const c = await connect(byGroup);
      await store.accounts.markOwnerlessUnowned();
      const reassigned = await store.accounts.assignOwnerlessTo(c.id, { kind: 'user', id: bob });
      expect(reassigned).toMatchObject({
        outcome: 'assigned',
        previous: { status: 'unowned', owner: byGroup },
        account: { status: 'active', owner: { kind: 'user', id: bob } },
      });
      expect(await store.accounts.getCredential(c.id)).toBe('secret');
      expect(await store.accounts.listOwnerless()).toEqual([]);
    });

    it('assignOwnerlessTo leaves an expired account expired and never touches a revoked one', async () => {
      const expired = await connect(byGroup);
      await store.accounts.markExpired(expired.id);
      expect(
        await store.accounts.assignOwnerlessTo(expired.id, { kind: 'user', id: bob }),
      ).toMatchObject({
        outcome: 'assigned',
        account: { status: 'expired', owner: { kind: 'user', id: bob } },
      });

      // A revoked account is not ownerless, whatever its owner group holds.
      const revoked = await connect(byGroup);
      await store.accounts.revoke(revoked.id);
      expect(await store.accounts.assignOwnerlessTo(revoked.id, { kind: 'user', id: bob })).toEqual(
        { outcome: 'not-ownerless' },
      );
      expect(await store.accounts.getById(revoked.id)).toMatchObject({
        status: 'revoked',
        owner: byGroup,
      });
    });

    it('markExpired expires a serving account, unowned included, and never a revoked one', async () => {
      const unowned = await connect(byGroup);
      await store.accounts.markOwnerlessUnowned();
      expect(await store.accounts.markExpired(unowned.id)).toBe(true);
      expect(await statusOf(unowned)).toBe('expired');
      expect(await store.accounts.markExpired(unowned.id)).toBe(false);

      const revoked = await connect({ kind: 'user', id: ada });
      await store.accounts.revoke(revoked.id);
      expect(await store.accounts.markExpired(revoked.id)).toBe(false);
      expect(await statusOf(revoked)).toBe('revoked');
    });
  });

  describe('missions: `orphaned` is never stored (migration 0007)', () => {
    const mission = async () => {
      const c = await connect({ kind: 'user', id: ada });
      return store.missions.create({
        name: 'm',
        creatorUserId: ada,
        periodSeconds: null,
        accounts: [{ accountId: c.id, resourceIds: [] }],
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
    };
    const REFUSED = /orphaned is derived from the creator's current authority, never stored/;

    it('the repository has no way to write it', () => {
      expect(Object.keys(store.missions)).not.toContain('markOrphaned');
      // `setStatus` takes a `StoredMissionStatus`: the cast is what a caller would need.
      expect(STORED_MISSION_STATUSES).toEqual(['active', 'expired', 'revoked']);
    });

    it('the table refuses the value on update and on insert, whoever writes it', async () => {
      const m = await mission();
      expect(() =>
        store.db.prepare("UPDATE missions SET status = 'orphaned' WHERE id = ?").run(m.id),
      ).toThrow(REFUSED);
      await expect(store.missions.setStatus(m.id, 'orphaned' as never)).rejects.toThrow(REFUSED);
      expect(() =>
        store.db
          .prepare(
            `INSERT INTO missions (id, name, creator_user_id, status, period_anchor, created_at, updated_at)
             VALUES ('raw', 'raw', ?, 'orphaned', '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z')`,
          )
          .run(ada),
      ).toThrow(REFUSED);
      expect((await store.missions.getById(m.id))?.status).toBe('active');
      // The other statuses are written as before.
      expect((await store.missions.setStatus(m.id, 'revoked')).status).toBe('revoked');
    });

    it('resets the verdicts an earlier image stored, and leaves the other missions alone', () => {
      const db = openDb({ path: MEMORY_PATH });
      try {
        const shipped = loadMigrations();
        runMigrations(
          db,
          shipped.filter((m) => m.version < 7),
          t.clock,
        );
        const at = '2026-10-13T08:00:00.000Z';
        db.prepare(
          "INSERT INTO users (id, subject, email, status, created_at) VALUES ('u', 's', 'u@x', 'active', ?)",
        ).run(at);
        const insert = db.prepare(
          `INSERT INTO missions (id, name, creator_user_id, status, period_anchor, created_at, updated_at, closed_at)
           VALUES (?, ?, 'u', ?, ?, ?, ?, ?)`,
        );
        insert.run('m-orphaned', 'orphaned by an earlier build', 'orphaned', at, at, at, at);
        insert.run('m-revoked', 'revoked', 'revoked', at, at, at, at);
        insert.run('m-expired', 'expired', 'expired', at, at, at, at);
        insert.run('m-active', 'active', 'active', at, at, at, null);

        runMigrations(db, shipped, t.clock);

        const rows = db
          .prepare<[], { id: string; status: string; closed_at: string | null }>(
            'SELECT id, status, closed_at FROM missions ORDER BY id',
          )
          .all();
        expect(rows).toEqual([
          { id: 'm-active', status: 'active', closed_at: null },
          { id: 'm-expired', status: 'expired', closed_at: at },
          // Back to `active`: every reader derives `orphaned` again if the grounds are still gone.
          { id: 'm-orphaned', status: 'active', closed_at: null },
          { id: 'm-revoked', status: 'revoked', closed_at: at },
        ]);
      } finally {
        db.close();
      }
    });
  });

  describe('shares: one active share per target', () => {
    it('replaceForTarget revokes the active share of the same target and creates the new one atomically', async () => {
      const c = await connect({ kind: 'user', id: ada });
      const target: Principal = { kind: 'user', id: bob };
      const input = { accountId: c.id, target, createdByUserId: ada };
      const first = await store.shares.replaceForTarget({
        ...input,
        restriction: ['github.code-read', 'github.merge-protected'],
      });
      expect(first.replaced).toBeNull();
      // Another target and another account are not touched by a replacement.
      const toGroup = await store.shares.create({
        ...input,
        target: { kind: 'group', id: group },
        restriction: ['github.code-read'],
      });
      const elsewhere = await connect({ kind: 'user', id: ada });
      const other = await store.shares.create({
        ...input,
        accountId: elsewhere.id,
        restriction: ['github.code-read'],
      });

      const second = await store.shares.replaceForTarget({
        ...input,
        restriction: ['github.code-read'],
      });

      expect(second.replaced?.id).toBe(first.created.id);
      expect(
        (
          await store.shares.get({
            accountId: first.created.accountId,
            shareId: first.created.id,
          })
        )?.status,
      ).toBe('revoked');
      expect(second.created).toMatchObject({ status: 'active', restriction: ['github.code-read'] });
      expect(
        (await store.shares.get({ accountId: toGroup.accountId, shareId: toGroup.id }))?.status,
      ).toBe('active');
      expect(
        (await store.shares.get({ accountId: other.accountId, shareId: other.id }))?.status,
      ).toBe('active');
    });

    it('replaceForTarget writes nothing when a risk is unknown: the previous share stays active', async () => {
      const c = await connect({ kind: 'user', id: ada });
      const input = {
        accountId: c.id,
        target: { kind: 'user', id: bob } as const,
        createdByUserId: ada,
      };
      const first = await store.shares.replaceForTarget({
        ...input,
        restriction: ['github.code-read'],
      });
      await expect(
        store.shares.replaceForTarget({ ...input, restriction: ['github.*'] }),
      ).rejects.toThrow();
      expect((await store.shares.listForAccount(c.id)).map((s) => [s.id, s.status])).toEqual([
        [first.created.id, 'active'],
      ]);
    });

    it('listActiveForTargets narrows to one account when asked', async () => {
      const one = await connect({ kind: 'user', id: ada });
      const two = await connect({ kind: 'user', id: ada });
      const target: Principal = { kind: 'user', id: bob };
      for (const c of [one, two]) {
        await store.shares.create({
          accountId: c.id,
          target,
          restriction: ['github.code-read'],
          createdByUserId: ada,
        });
      }
      expect(await store.shares.listActiveForTargets([target])).toHaveLength(2);
      expect(
        (await store.shares.listActiveForTargets([target], two.id)).map((s) => s.accountId),
      ).toEqual([two.id]);
      expect(await store.shares.listActiveForTargets([], two.id)).toEqual([]);
    });
  });

  describe('groups: local groups', () => {
    it('createLocal creates a local group, and answers null for a name already held', async () => {
      const created = await store.groups.createLocal('platform');
      expect(created).toMatchObject({ name: 'platform', source: 'local' });
      expect(await store.groups.createLocal('platform')).toBeNull();
      await store.groups.getOrCreate('claimed', 'idp', 'idp');
      expect(await store.groups.createLocal('claimed')).toBeNull();
      expect((await store.groups.getByName('claimed'))?.source).toBe('idp');
    });

    it('a user’s groups are the IdP-sourced and the local ones together; a claim sync touches only the first', async () => {
      await store.groups.addMember(group, bob);
      await store.groups.syncIdpMemberships(bob, ['dev', 'github-admins'], 'idp');
      const names = async () =>
        (await store.groups.groupsOf(bob)).map((g) => `${g.source}:${g.name}`);
      expect(await names()).toEqual(['idp:dev', 'local:github-admins']);
      await store.groups.syncIdpMemberships(bob, [], 'idp');
      expect(await names()).toEqual(['local:github-admins']);
    });
  });
});
