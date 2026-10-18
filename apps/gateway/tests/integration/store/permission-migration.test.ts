import { mkdtempSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openStore, SetCatalogIndex } from '../../../src/server/store';
import { DEFAULT_MIGRATIONS_DIR } from '../../../src/server/store/migrate';
import { StubEncryptor, TEST_RISK_IDS } from '../../../src/server/store/testing';

it('upgrades existing requests and approvals without losing encrypted arguments or grants', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'permission-migration-'));
  const oldDir = mkdtempSync(join(tmpdir(), 'permission-old-schema-'));
  for (const file of readdirSync(DEFAULT_MIGRATIONS_DIR)) {
    // Every migration but 0016, the one under test: the repositories of this build
    // read the columns later migrations add (0017 `connections.default_env`), and the
    // migrator applies a missing version whatever was applied after it.
    if (/^\d{4}_/.test(file) && Number(file.slice(0, 4)) !== 16)
      copyFileSync(join(DEFAULT_MIGRATIONS_DIR, file), join(oldDir, file));
  }
  const options = {
    path: join(dir, 'store.sqlite'),
    encryptor: new StubEncryptor(),
    catalog: new SetCatalogIndex(TEST_RISK_IDS),
  };
  let store = openStore({ ...options, migrationsDir: oldDir });
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
          gate: 'approval',
        },
      ],
    });
    const request = await store.requests.create({
      missionId: mission.id,
      kind: 'approval',
      riskId: 'github.code-read',
      tool: 'github__read',
      fingerprint: 'fingerprint',
      arguments: { marker: 'preserved encrypted content' },
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const granted = await store.requests.create({
      missionId: mission.id,
      kind: 'approval',
      riskId: 'github.code-read',
      tool: 'github__read',
      fingerprint: 'granted-fingerprint',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    await store.requests.decideApproval(granted.id, user.id, (ctx) => {
      ctx.createApproval('2099-01-01T00:00:00.000Z');
      return { state: 'granted', decision: { resolution: 'grant' } };
    });
    const approvalBefore = store.db.prepare('SELECT * FROM approvals').all();
    await store.close();
    store = openStore(options);
    expect(store.schemaVersion).toBe(17);
    expect(await store.requests.getById(request.id)).toEqual(request);
    expect(await store.requests.getArguments(request.id)).toEqual({
      marker: 'preserved encrypted content',
    });
    expect(store.db.prepare('SELECT * FROM approvals').all()).toEqual(approvalBefore);
    expect(store.db.pragma('foreign_key_check')).toEqual([]);
    expect(await store.requests.getById(granted.id)).toMatchObject({ state: 'granted' });
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(oldDir, { recursive: true, force: true });
  }
});
