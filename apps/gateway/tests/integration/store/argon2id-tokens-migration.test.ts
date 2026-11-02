/**
 * Migration 0028: a mission token still stored as argon2id (never presented since
 * the upgrade to the SHA-256 digest) is revoked; every other row is left as it is.
 */
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { openStore, SetCatalogIndex } from '../../../src/server/store';
import { DEFAULT_MIGRATIONS_DIR } from '../../../src/server/store/migrate';
import { StubEncryptor, TEST_RISK_IDS } from '../../support/store/testing';

const MIGRATION = 28;
const RESOURCE_SETS = 29;

it('revokes the active argon2id tokens, and only them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'argon2id-migration-'));
  const before = mkdtempSync(join(tmpdir(), 'argon2id-before-'));
  for (const file of readdirSync(DEFAULT_MIGRATIONS_DIR)) {
    // 0029 (resource sets) and later are independent of 0028 and are what the repositories
    // write through (or prepare their statements on): the store before 0028 is given them.
    const version = Number(file.slice(0, 4));
    if (/^\d{4}_/.test(file) && (version < MIGRATION || version >= RESOURCE_SETS)) {
      copyFileSync(join(DEFAULT_MIGRATIONS_DIR, file), join(before, file));
    }
  }
  const options = {
    path: join(dir, 'store.sqlite'),
    encryptor: new StubEncryptor(),
    catalog: new SetCatalogIndex(TEST_RISK_IDS),
  };
  let store = openStore({ ...options, migrationsDir: before });
  try {
    const user = await store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'owner',
      email: 'owner@example.com',
    });
    const connection = await store.connections.create({
      provider: 'github',
      displayName: 'GitHub',
      owner: { kind: 'user', id: user.id },
      credential: null,
    });
    const mission = await store.missions.create({
      name: 'Existing mission',
      creatorUserId: user.id,
      periodSeconds: null,
      connections: [{ connectionId: connection.id, resourceScope: 'all', resourceIds: [] }],
      policy: [
        {
          riskId: 'github.code-read',
          quota: 10,
          rateLimit: 10,
          rateWindowSeconds: 60,
          gate: 'auto',
        },
      ],
    });
    const issue = (prefix: string, hashAlg: string, name: string) =>
      store.missions.issueToken({
        missionId: mission.id,
        prefix,
        hash: `hash-of-${prefix}`,
        hashAlg,
        holder: { kind: 'named', name },
        createdBy: user.id,
      });
    const legacy = await issue('p-legacy', 'argon2id', 'old agent');
    const moved = await issue('p-moved', 'sha256', 'moved agent');
    const retired = await issue('p-retired', 'argon2id', 'retired agent');
    await store.missions.revokeToken({ missionId: mission.id, tokenId: retired.token.id });
    const retiredAt = (
      await store.missions.getToken({ missionId: mission.id, tokenId: retired.token.id })
    )?.retiredAt;
    await store.close();

    store = openStore(options);
    const key = (tokenId: string) => ({ missionId: mission.id, tokenId });
    const revoked = await store.missions.getToken(key(legacy.token.id));
    expect(revoked).toMatchObject({ status: 'revoked', hashAlg: 'argon2id' });
    expect(revoked?.retiredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(await store.missions.getToken(key(moved.token.id))).toMatchObject({
      status: 'active',
      retiredAt: null,
    });
    // Already retired: untouched, its date kept.
    expect(await store.missions.getToken(key(retired.token.id))).toMatchObject({
      status: 'revoked',
      retiredAt,
    });
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(before, { recursive: true, force: true });
  }
});
