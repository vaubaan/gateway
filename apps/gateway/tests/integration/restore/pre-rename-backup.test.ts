/**
 * A backup written before migration 0036 (ADR one-word-per-thing-account-service-plugin)
 * restores, and the boot that follows renames it: its tables still say `connections`,
 * `connection_resources`, `mission_connections` and `local_accounts`, its audit the old
 * act names, refusal codes and JSON fields. The copy is a store migrated to 0035 only,
 * seeded through SQL as that version wrote it, its credential sealed by the real
 * encryptor under the account id as associated data.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadInstanceConfig } from '../../../src/server/config';
import { createEncryptor, type Encryptor } from '../../../src/server/crypto';
import { restoreStore } from '../../../src/server/restore/restore';
import { openStore, SetCatalogIndex } from '../../../src/server/store';
import { backupTo, openDb, openReadonlyDb } from '../../../src/server/store/db';
import { loadMigrations, runMigrations } from '../../../src/server/store/migrate';
import { ManualClock } from '../../../src/server/store/clock';
import { validEnv } from '../../support/config/testing';

const KEY = randomBytes(32).toString('base64');
const AT = '2026-11-13T08:00:00.000Z';
const ACCOUNT_ID = '0193a4f2-0000-7000-8000-00000000c0de';
const CREDENTIAL = '{"token":"ghp_0123456789-pre-rename"}';

describe('a backup written before the rename of connection to account', () => {
  let dir: string;
  let backup: string;
  let target: string;
  let encryptor: Encryptor;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vaubaan-pre-rename-'));
    mkdirSync(join(dir, 'old'));
    mkdirSync(join(dir, 'new'));
    target = join(dir, 'new', 'gateway.db');
    encryptor = await createEncryptor(
      loadInstanceConfig({
        env: validEnv({
          VAUBAAN_STORE_PATH: target,
          VAUBAAN_MASTER_KEY: KEY,
          VAUBAAN_MASTER_KEY_VERSION: '1',
        }),
      }).config.encryption,
    );

    const source = join(dir, 'old', 'gateway.db');
    const db = openDb({ path: source });
    runMigrations(
      db,
      loadMigrations().filter((m) => m.version < 36),
      new ManualClock(),
    );
    const run = (sql: string, ...params: unknown[]) => db.prepare(sql).run(...params);
    run(
      "INSERT INTO users (id, subject, identity_key, email, status, created_at) VALUES ('ada', 's', 'k', 'ada@example.com', 'active', ?)",
      AT,
    );
    const sealed = await encryptor.encrypt(ACCOUNT_ID, CREDENTIAL);
    run(
      `INSERT INTO connections (id, provider, owner_kind, owner_user_id, display_name, status,
         credential_blob, key_version, created_at, updated_at)
       VALUES (?, 'github', 'user', 'ada', 'acme', 'active', ?, ?, ?, ?)`,
      ACCOUNT_ID,
      Buffer.from(sealed.blob),
      sealed.keyVersion,
      AT,
      AT,
    );
    run(
      `INSERT INTO connection_resources (id, connection_id, ref, display_name, discovered_at)
       VALUES ('r-app', ?, 'acme/app', 'app', ?)`,
      ACCOUNT_ID,
      AT,
    );
    run(
      `INSERT INTO missions (id, name, creator_user_id, status, period_anchor, created_at, updated_at)
       VALUES ('m', 'Ship it', 'ada', 'active', ?, ?, ?)`,
      AT,
      AT,
      AT,
    );
    run("INSERT INTO mission_connections (mission_id, connection_id) VALUES ('m', ?)", ACCOUNT_ID);
    run(
      "INSERT INTO mission_resource_sets (id, mission_id, connection_id, position) VALUES ('m:set', 'm', ?, 1)",
      ACCOUNT_ID,
    );
    run(
      `INSERT INTO mission_resources (mission_id, connection_id, resource_id, resource_set_id, source)
       VALUES ('m', ?, 'r-app', 'm:set', 'issuance')`,
      ACCOUNT_ID,
    );
    run(
      `INSERT INTO audit (id, ts, kind, user_id, act, object_type, object_id, after_json)
       VALUES ('a1', ?, 'admin', 'ada', 'connection-created', 'connection', ?, ?)`,
      AT,
      ACCOUNT_ID,
      JSON.stringify({ connection_id: ACCOUNT_ID, provider: 'github' }),
    );
    run(
      `INSERT INTO audit (id, ts, kind, mission_id, connection_id, tool, arguments_hash, decision, refusal_code)
       VALUES ('a2', ?, 'call', 'm', ?, 'github__get_repo', ?, 'refused', 'connection-revoked')`,
      AT,
      ACCOUNT_ID,
      'f'.repeat(64),
    );
    run(
      `INSERT INTO audit (id, ts, kind, user_id, act, object_type, object_id, after_json)
       VALUES ('a3', ?, 'admin', 'ada', 'local-account-created', 'sign-in-provider', 'local-account:local', '{}')`,
      AT,
    );
    run(
      `INSERT INTO local_accounts (id, provider, email, created_at, updated_at)
       VALUES ('la', 'local', 'ada@example.com', ?, ?)`,
      AT,
      AT,
    );
    db.close();

    backup = join(dir, 'old', 'backup.sqlite');
    const readonly = openReadonlyDb(source);
    backupTo(readonly, backup);
    readonly.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('restores: the sealed credential opens on the copy, then under its new table once booted', async () => {
    const report = await restoreStore({
      source: { kind: 'file', path: backup },
      sha256: null,
      maxBytes: 64 * 1024 * 1024,
      storePath: target,
      encryptor,
      keyVersions: [1],
    });
    expect(report.installed).toBe(true);
    expect(report.schemaVersion).toBe(35);
    expect(report.keyVersions).toEqual([
      { keyVersion: 1, blobs: 1, unreadable: 0, configured: true },
    ]);

    const store = openStore({ path: target, encryptor, catalog: new SetCatalogIndex([]) });
    try {
      expect(store.schemaVersion).toBe(42);
      expect(await store.accounts.getCredential(ACCOUNT_ID)).toBe(CREDENTIAL);
      expect((await store.accounts.getById(ACCOUNT_ID))?.displayName).toBe('acme');
      // The mission still reaches its account and its resource.
      expect(
        store.db
          .prepare(
            'SELECT mission_id, account_id, resource_id, resource_set_id FROM mission_resources',
          )
          .all(),
      ).toEqual([
        { mission_id: 'm', account_id: ACCOUNT_ID, resource_id: 'r-app', resource_set_id: 'm:set' },
      ]);
      expect(store.db.prepare('SELECT account_id FROM mission_accounts').all()).toEqual([
        { account_id: ACCOUNT_ID },
      ]);
      // History reads with the new names.
      const audit = store.db
        .prepare(
          'SELECT id, act, object_type, object_id, account_id, refusal_code, after_json FROM audit ORDER BY id',
        )
        .all();
      expect(audit).toEqual([
        {
          id: 'a1',
          act: 'account-created',
          object_type: 'account',
          object_id: ACCOUNT_ID,
          account_id: null,
          refusal_code: null,
          after_json: JSON.stringify({ account_id: ACCOUNT_ID, service: 'github' }),
        },
        {
          id: 'a2',
          act: null,
          object_type: null,
          object_id: null,
          account_id: ACCOUNT_ID,
          refusal_code: 'account-revoked',
          after_json: null,
        },
        {
          id: 'a3',
          act: 'sign-in-account-created',
          object_type: 'sign-in-provider',
          object_id: 'sign-in-account:local',
          account_id: null,
          refusal_code: null,
          after_json: '{}',
        },
      ]);
      expect((await store.signInAccounts.getById('la'))?.email).toBe('ada@example.com');
      // The audit is append-only again once the rewrite is done.
      expect(() => store.db.prepare("UPDATE audit SET act = 'x' WHERE id = 'a1'").run()).toThrow(
        /append-only/,
      );
      expect(store.db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      await store.close();
    }
  });
});
