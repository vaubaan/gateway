/**
 * Migration 0040 — one Vaubaan (`host`) account per person, held by the store.
 *
 * An instance at 0039 may hold duplicates (two connects at once). The shipped file runs
 * over a store whose index is set aside, as such an instance is: per person and service it
 * keeps the oldest active account, revokes the others as a disconnect does, leaves their
 * missions where they are, writes one `account-revoked` entry each by the actor
 * `migration`, then creates the index. After it, the repository refuses a second one.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATION_ACTOR_ID } from '@vaubaan/gateway-core';

import {
  DEFAULT_MIGRATIONS_DIR,
  HostAccountTakenError,
  isUuidV7,
  type Store,
} from '../../../src/server/store/index.ts';
import type { ManualClock } from '../../../src/server/store/clock.ts';
import { openTestStore } from '../../support/store/testing.ts';

const MIGRATION = readFileSync(
  join(DEFAULT_MIGRATIONS_DIR, '0040_one_vaubaan_account_per_person.sql'),
  'utf8',
);
const HOST = { credential_kind: 'host' } as const;

describe('migration 0040: one Vaubaan account per person', () => {
  let store: Store;
  let clock: ManualClock;
  let ada: string;
  let bob: string;

  beforeEach(async () => {
    ({ store, clock } = openTestStore());
    ada = (
      await store.users.upsertFromIdp({ issuer: 'http://idp.test', subject: 'a', email: 'a@x' })
    ).id;
    bob = (
      await store.users.upsertFromIdp({ issuer: 'http://idp.test', subject: 'b', email: 'b@x' })
    ).id;
  });
  afterEach(async () => {
    await store.close();
  });

  /** A Vaubaan account of the person, created a minute after the previous one. */
  async function vaubaan(owner: string, name: string) {
    clock.advance(60_000);
    return store.accounts.create({
      service: 'vaubaan',
      owner: { kind: 'user', id: owner },
      displayName: name,
      credential: null,
      metadata: HOST,
    });
  }

  function statusOf(id: string): { status: string; revoked_at: string | null } | undefined {
    return store.db
      .prepare<[string], { status: string; revoked_at: string | null }>(
        'SELECT status, revoked_at FROM accounts WHERE id = ?',
      )
      .get(id);
  }

  it('keeps the oldest active account, revokes the others, leaves their missions and audits each', async () => {
    // An instance at 0039: the index is not there yet.
    store.db.exec('DROP INDEX accounts_one_host_per_person');
    const expired = await vaubaan(ada, 'oldest, expired');
    const kept = await vaubaan(ada, 'oldest active');
    const second = await vaubaan(ada, 'second');
    const third = await vaubaan(ada, 'third');
    const gone = await vaubaan(ada, 'revoked before');
    const bobs = await vaubaan(bob, 'bob');
    await store.accounts.markExpired(expired.id);
    await store.accounts.revoke(gone.id);
    const mission = await store.missions.create({
      name: 'Platform management',
      creatorUserId: ada,
      periodSeconds: null,
      accounts: [{ accountId: second.id, resourceIds: [] }],
      policy: [],
    });

    store.db.exec(MIGRATION);

    expect(statusOf(kept.id)?.status).toBe('active');
    expect(statusOf(bobs.id)?.status).toBe('active');
    for (const id of [expired.id, second.id, third.id, gone.id]) {
      expect(statusOf(id)?.status, id).toBe('revoked');
      expect(statusOf(id)?.revoked_at, id).not.toBeNull();
    }
    // Not moved: the mission still names the account it was issued on.
    const after = await store.missions.getById(mission.id);
    expect(after?.accounts.map((a) => a.accountId)).toEqual([second.id]);

    const entries = store.db
      .prepare<
        [],
        {
          id: string;
          user_id: string;
          act: string;
          object_id: string;
          before_json: string;
          after_json: string;
        }
      >(
        `SELECT id, user_id, act, object_id, before_json, after_json FROM audit
         WHERE user_id = 'migration' ORDER BY object_id`,
      )
      .all();
    expect(entries.map((e) => e.object_id)).toEqual([expired.id, second.id, third.id].sort());
    for (const entry of entries) {
      expect(isUuidV7(entry.id), entry.id).toBe(true);
      expect(entry).toMatchObject({ user_id: MIGRATION_ACTOR_ID, act: 'account-revoked' });
      expect(JSON.parse(entry.after_json)).toMatchObject({
        service: 'vaubaan',
        status: 'revoked',
        owner: { kind: 'user', id: ada },
        cause: 'duplicate-host-account',
        kept_account_id: kept.id,
      });
    }
    const bySecond = entries.find((e) => e.object_id === second.id);
    expect(JSON.parse(bySecond?.after_json ?? '{}')).toMatchObject({ mission_ids: [mission.id] });
    expect(JSON.parse(bySecond?.before_json ?? '{}')).toEqual({ status: 'active' });
    const byExpired = entries.find((e) => e.object_id === expired.id);
    expect(JSON.parse(byExpired?.before_json ?? '{}')).toEqual({ status: 'expired' });
    expect(JSON.parse(byExpired?.after_json ?? '{}')).toMatchObject({ mission_ids: [] });

    // The store reads the entries it did not write itself, in the owner's account activity.
    const read = await store.audit.search({
      scope: {
        missionCreatorUserId: null,
        missionMemberUserId: null,
        accountOwners: [{ kind: 'user', id: ada }],
        allAdmin: false,
        allCalls: false,
      },
      accountId: second.id,
      limit: 10,
    });
    expect(read).toEqual([
      expect.objectContaining({
        kind: 'admin',
        user_id: MIGRATION_ACTOR_ID,
        act: 'account-revoked',
        object: { type: 'account', id: second.id },
      }),
    ]);
  });

  it('keeps the oldest account when none of them is active', async () => {
    store.db.exec('DROP INDEX accounts_one_host_per_person');
    const first = await vaubaan(ada, 'first');
    const second = await vaubaan(ada, 'second');
    await store.accounts.markExpired(first.id);
    await store.accounts.markExpired(second.id);

    store.db.exec(MIGRATION);

    expect(statusOf(first.id)?.status).toBe('expired');
    expect(statusOf(second.id)?.status).toBe('revoked');
  });

  it('changes nothing on an instance without duplicates', async () => {
    store.db.exec('DROP INDEX accounts_one_host_per_person');
    const one = await vaubaan(ada, 'one');
    await vaubaan(bob, 'bob');
    const github = await store.accounts.create({
      service: 'github',
      owner: { kind: 'user', id: ada },
      displayName: 'gh',
      credential: null,
    });
    await store.accounts.create({
      service: 'github',
      owner: { kind: 'user', id: ada },
      displayName: 'gh 2',
      credential: null,
    });

    store.db.exec(MIGRATION);

    expect(statusOf(one.id)?.status).toBe('active');
    expect(statusOf(github.id)?.status).toBe('active');
    const count = store.db
      .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM audit WHERE user_id = 'migration'")
      .get();
    expect(count?.n).toBe(0);
  });

  it('after it, the store refuses a second Vaubaan account of the same person', async () => {
    const first = await vaubaan(ada, 'first');
    await expect(vaubaan(ada, 'second')).rejects.toBeInstanceOf(HostAccountTakenError);
    await expect(vaubaan(ada, 'second')).rejects.toMatchObject({
      service: 'vaubaan',
      ownerUserId: ada,
    });
    // Another person, and another kind of account of the same person, pass.
    await vaubaan(bob, 'bob');
    await store.accounts.create({
      service: 'github',
      owner: { kind: 'user', id: ada },
      displayName: 'gh',
      credential: null,
    });
    // Once the first is revoked, the person may connect again.
    await store.accounts.revoke(first.id);
    const again = await vaubaan(ada, 'again');
    expect(again.status).toBe('active');
    const accounts = await store.accounts.list({ service: 'vaubaan' });
    expect(accounts.filter((a) => a.owner.id === ada && a.status !== 'revoked')).toHaveLength(1);
  });
});
