import { mkdtempSync, copyFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openStore, SetCatalogIndex } from '../../../src/server/store';
import { systemClock } from '../../../src/server/store/clock';
import { openDb } from '../../../src/server/store/db';
import {
  DEFAULT_MIGRATIONS_DIR,
  loadMigrations,
  runMigrations,
} from '../../../src/server/store/migrate';
import { heldArguments, StubEncryptor, TEST_RISK_IDS } from '../../support/store/testing';

it('upgrades existing requests and approvals without losing encrypted arguments or grants', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'permission-migration-'));
  const oldDir = mkdtempSync(join(tmpdir(), 'permission-old-schema-'));
  for (const file of readdirSync(DEFAULT_MIGRATIONS_DIR)) {
    // Every migration but 0016, the one under test: the repositories of this build
    // read the columns later migrations add (0017 `accounts.default_env`), and the
    // migrator applies a missing version whatever was applied after it. 0043 renames
    // the columns 0016 copies, so it waits too: its statements run by hand for the
    // repositories, and are undone before the upgrade.
    if (/^\d{4}_/.test(file) && ![16, MISSION_LOGS].includes(Number(file.slice(0, 4))))
      copyFileSync(join(DEFAULT_MIGRATIONS_DIR, file), join(oldDir, file));
  }
  const options = {
    path: join(dir, 'store.sqlite'),
    encryptor: new StubEncryptor(),
    catalog: new SetCatalogIndex(TEST_RISK_IDS),
  };
  // The old schema, under the names the repositories of this build read.
  const db = openDb({ path: options.path });
  runMigrations(db, loadMigrations(oldDir), systemClock);
  db.exec(missionLogsMigration());
  db.close();
  let store = openStore({ ...options, migrationsDir: oldDir });
  try {
    const user = await store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'owner',
      email: 'owner@example.com',
    });
    const account = await store.accounts.create({
      service: 'github',
      displayName: 'GitHub',
      owner: { kind: 'user', id: user.id },
      credential: null,
    });
    const mission = await store.missions.create({
      name: 'Existing mission',
      creatorUserId: user.id,
      periodSeconds: null,
      accounts: [{ accountId: account.id, resourceIds: [] }],
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
    store.db.exec(UNDO_MISSION_LOGS);
    await store.close();
    store = openStore(options);
    expect(store.schemaVersion).toBe(43);
    expect(await store.requests.getById(request.id)).toEqual(request);
    expect(await heldArguments(store, request.id)).toEqual({
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

/** Migration 0043, the mission logs: names the 0016 rebuild of `requests` does not know. */
const MISSION_LOGS = 43;

function missionLogsMigration(): string {
  const file = readdirSync(DEFAULT_MIGRATIONS_DIR).find((f) => f.startsWith('0043_'));
  if (!file) throw new Error('migration 0043 not shipped');
  return readFileSync(join(DEFAULT_MIGRATIONS_DIR, file), 'utf8');
}

/** The schema before 0043, so that 0016 then 0043 run at the upgrade as an image runs them. */
const UNDO_MISSION_LOGS = `
  ALTER TABLE mission_logs RENAME TO sessions;
  ALTER TABLE mission_log_counters RENAME TO session_counters;
  ALTER TABLE session_counters RENAME COLUMN mission_log_id TO session_id;
  ALTER TABLE events RENAME COLUMN mission_log_id TO session_id;
  ALTER TABLE requests RENAME COLUMN mission_log_id TO session_id;
  ALTER TABLE audit RENAME COLUMN mission_log_id TO session_id;
  DROP INDEX events_mission_log_ts;
  CREATE INDEX events_session_ts ON events (session_id, ts);
  DROP INDEX events_mission_log_label_ts;
  CREATE INDEX events_session_label_ts ON events (session_id, agent_label, ts, id);
  DROP INDEX events_mission_log_holder_ts;
  CREATE INDEX events_session_holder_ts ON events (session_id, token_kind, token_holder, ts, id);
`;
