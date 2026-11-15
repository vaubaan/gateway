/**
 * Migration 0039 — the versions of a mission's configuration. Its backfill writes every
 * existing mission's version 1 from its current state (`before-versions`, by the
 * gateway), in SQL: what it writes must be the configuration the store's own writer
 * (`recordSync`) reads, or the first write after the upgrade would leave a version that
 * moved nothing, and its changes would be wrong.
 *
 * The backfill's statement is run here, from the shipped file, over missions written by
 * the repositories (two accounts, two resource sets, trust levels, an end, a one-off
 * period), after their own versions are set aside.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_MIGRATIONS_DIR, type Store } from '../../../src/server/store/index.ts';
import { sameConfig } from '../../../src/lib/missions/versions.ts';
import { openTestStore } from '../../support/store/testing.ts';

/** The INSERT … SELECT of migration 0039, as shipped. */
function backfillStatement(): string {
  const sql = readFileSync(join(DEFAULT_MIGRATIONS_DIR, '0039_mission_versions.sql'), 'utf8');
  const start = sql.indexOf('INSERT INTO mission_versions');
  if (start < 0) throw new Error('no backfill in 0039');
  return sql.slice(start);
}

describe('migration 0039: version 1 of every existing mission', () => {
  let store: Store;
  let missionIds: string[];

  beforeEach(async () => {
    store = openTestStore().store;
    const creator = (
      await store.users.upsertFromIdp({ issuer: 'http://idp.test', subject: 'c', email: 'c@x' })
    ).id;
    const github = await store.accounts.create({
      service: 'github',
      owner: { kind: 'user', id: creator },
      displayName: 'gh',
      credential: null,
    });
    const [a, b] = await store.accounts.syncDiscoveredResources(github.id, [
      { ref: 'acme/a', displayName: 'A', env: 'prod' },
      { ref: 'acme/b', displayName: 'B', env: 'staging' },
    ]);
    const supabase = await store.accounts.create({
      service: 'supabase',
      owner: { kind: 'user', id: creator },
      displayName: 'sb',
      credential: null,
    });
    const line = (riskId: string, quota: number, gate: 'auto' | 'approval' = 'auto') => ({
      riskId,
      quota,
      rateLimit: 3,
      rateWindowSeconds: 60,
      gate,
    });
    const rich = await store.missions.create({
      name: 'Rich',
      creatorUserId: creator,
      periodSeconds: null,
      expiresAt: '2099-01-01T00:00:00.000Z',
      accounts: [
        {
          accountId: github.id,
          resourceSets: [
            {
              resourceIds: [a?.id ?? ''],
              trustLevels: { read: 'careful' },
              policy: [line('github.code-read', 5), line('github.merge-protected', 1, 'approval')],
            },
            { resourceIds: [b?.id ?? ''], future: true, policy: [line('github.code-read', 9)] },
          ],
        },
        {
          accountId: supabase.id,
          resourceSets: [{ resourceIds: [], future: true, env: 'staging', policy: [] }],
        },
      ],
    });
    const plain = await store.missions.create({
      name: 'Plain',
      creatorUserId: creator,
      periodSeconds: 86_400,
      accounts: [{ accountId: github.id, resourceIds: [] }],
      policy: [line('github.code-read', 1)],
    });
    missionIds = [rich.id, plain.id];
  });
  afterEach(() => store.close());

  it('writes the configuration the store reads, so the next write moves only what moves', async () => {
    const written = new Map<string, unknown>();
    for (const id of missionIds) {
      const [v1] = await store.missionVersions.list(id);
      written.set(id, v1?.config);
    }
    // As before the upgrade: no version yet. The trigger is lifted for the test alone.
    store.db.exec('DROP TRIGGER mission_versions_no_delete');
    store.db.exec('DELETE FROM mission_versions');
    store.db.exec(backfillStatement());

    for (const id of missionIds) {
      const versions = await store.missionVersions.list(id);
      expect(versions).toHaveLength(1);
      const [v1] = versions;
      expect(v1).toMatchObject({
        number: 1,
        cause: 'before-versions',
        author: { kind: 'gateway' },
        restoredFrom: null,
        changes: null,
      });
      if (!v1) throw new Error('no version');
      expect(sameConfig(v1.config, written.get(id) as typeof v1.config)).toBe(true);
    }

    const [rich] = missionIds;
    if (!rich) throw new Error('fixture');
    // A write that moves nothing leaves no version.
    const mission = await store.missions.getById(rich);
    const first = mission?.policy[0];
    if (!mission || !first) throw new Error('fixture');
    await store.missions.setLimits(
      rich,
      [
        {
          resourceSetId: first.resourceSetId,
          riskId: first.riskId,
          quota: first.quota,
          rateLimit: first.rateLimit,
        },
      ],
      mission.creatorUserId,
    );
    expect(await store.missionVersions.list(rich)).toHaveLength(1);
    // One that moves leaves version 2, whose changes name only what moved.
    await store.missions.setLimits(
      rich,
      [{ resourceSetId: first.resourceSetId, riskId: first.riskId, quota: 42, rateLimit: 3 }],
      mission.creatorUserId,
    );
    const [v2] = await store.missionVersions.list(rich);
    expect(v2).toMatchObject({
      number: 2,
      cause: 'edit',
      changes: {
        name_changed: false,
        expiry_changed: false,
        resources_added: 0,
        resources_removed: 0,
        permissions_added: [],
        permissions_removed: [],
        limits: [{ risk_id: first.riskId, quota: 42 }],
        gates: [],
      },
    });
  });
});
