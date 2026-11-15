/**
 * A backup written before migration 0037 (ADR one-word-per-thing-account-service-plugin,
 * rename R2) restores, and the boot that follows renames it: its accounts still say
 * `provider` and `provider_grant`, its groups, administrators, sign-in accounts and links
 * `provider` for the sign-in provider, its audit and web sessions the old JSON fields. The
 * copy is a store migrated to 0036 only, seeded through SQL as that version wrote it, its
 * credential sealed by the real encryptor under the account id as associated data.
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
const AT = '2026-11-14T08:00:00.000Z';
const LATER = '2099-01-01T00:00:00.000Z';
const ACCOUNT_ID = '0193a4f2-0000-7000-8000-0000000005e7';
const CREDENTIAL = '{"token":"ghp_0123456789-pre-service"}';

describe('a backup written before the rename of provider to service', () => {
  let dir: string;
  let backup: string;
  let target: string;
  let encryptor: Encryptor;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vaubaan-pre-service-'));
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
      loadMigrations().filter((m) => m.version < 37),
      new ManualClock(),
    );
    const run = (sql: string, ...params: unknown[]) => db.prepare(sql).run(...params);
    run(
      "INSERT INTO users (id, subject, identity_key, email, status, created_at) VALUES ('ada', 's', 'k', 'ada@example.com', 'active', ?)",
      AT,
    );
    const sealed = await encryptor.encrypt(ACCOUNT_ID, CREDENTIAL);
    run(
      `INSERT INTO accounts (id, provider, owner_kind, owner_user_id, display_name, status,
         credential_blob, key_version, provider_grant, created_at, updated_at)
       VALUES (?, 'github', 'user', 'ada', 'acme', 'revoked', ?, ?, 'manual', ?, ?)`,
      ACCOUNT_ID,
      Buffer.from(sealed.blob),
      sealed.keyVersion,
      AT,
      AT,
    );
    run(
      "INSERT INTO groups (id, name, source, provider, created_at) VALUES ('g1', 'platform', 'idp', 'idp', ?)",
      AT,
    );
    run(
      `INSERT INTO administrators (id, kind, email, provider, granted_by, origin, created_at)
       VALUES ('d1', 'email', 'bob@example.com', 'idp', 'ada', 'granted', ?)`,
      AT,
    );
    run(
      `INSERT INTO sign_in_accounts (id, provider, email, created_at, updated_at)
       VALUES ('sa', 'local', 'carol@example.com', ?, ?)`,
      AT,
      AT,
    );
    run(
      `INSERT INTO local_links (id, kind, provider, email, token_sha256, created_by, created_at, expires_at)
       VALUES ('l1', 'invite', 'local', 'dan@example.com', ?, 'ada', ?, ?)`,
      'e'.repeat(64),
      AT,
      LATER,
    );
    run(
      `INSERT INTO audit (id, ts, kind, user_id, act, object_type, object_id, before_json, after_json)
       VALUES ('a1', ?, 'admin', 'ada', 'account-revoked', 'account', ?, ?, ?)`,
      AT,
      ACCOUNT_ID,
      JSON.stringify({ status: 'active' }),
      JSON.stringify({ provider: 'github', display_name: 'acme', provider_grant: 'manual' }),
    );
    run(
      `INSERT INTO audit (id, ts, kind, user_id, act, object_type, object_id, after_json)
       VALUES ('a2', ?, 'admin', 'ada', 'administrator-granted', 'administrators', 'd1', ?)`,
      AT,
      JSON.stringify({ kind: 'email', email: 'bob@example.com', provider: 'idp' }),
    );
    run(
      `INSERT INTO audit (id, ts, kind, user_id, act, object_type, object_id, after_json)
       VALUES ('a3', ?, 'admin', 'ada', 'sign-in-provider-tested', 'instance-config', 'sign-in:idp', ?)`,
      AT,
      JSON.stringify({ outcome: 'refused', error: 'provider-disabled' }),
    );
    run(
      `INSERT INTO audit (id, ts, kind, user_id, act, object_type, object_id, after_json)
       VALUES ('a4', ?, 'admin', 'ada', 'config-changed', 'instance-config', 'oauth-broker:main', ?)`,
      AT,
      JSON.stringify({ url: 'https://broker.example.com', providers: ['google'] }),
    );
    run(
      "INSERT INTO web_sessions (id, value_json, expires_at) VALUES ('s1', ?, ?)",
      JSON.stringify({
        kind: 'user',
        userId: 'ada',
        login: { email: 'ada@example.com', groups: [], provider: 'idp' },
        createdAt: AT,
      }),
      LATER,
    );
    run(
      "INSERT INTO web_sessions (id, value_json, expires_at) VALUES ('s2', ?, ?)",
      JSON.stringify({
        providerId: 'idp',
        state: 's',
        nonce: 'n',
        codeVerifier: 'v',
        returnTo: '/',
        createdAt: AT,
      }),
      LATER,
    );
    db.close();

    backup = join(dir, 'old', 'backup.sqlite');
    const readonly = openReadonlyDb(source);
    backupTo(readonly, backup);
    readonly.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('restores, and once booted every name says service or sign-in provider', async () => {
    const report = await restoreStore({
      source: { kind: 'file', path: backup },
      sha256: null,
      maxBytes: 64 * 1024 * 1024,
      storePath: target,
      encryptor,
      keyVersions: [1],
    });
    expect(report.installed).toBe(true);
    expect(report.schemaVersion).toBe(36);

    const store = openStore({ path: target, encryptor, catalog: new SetCatalogIndex([]) });
    try {
      expect(store.schemaVersion).toBe(38);
      // The credential still opens: neither the id nor the associated data moved.
      expect(await store.accounts.getCredential(ACCOUNT_ID)).toBe(CREDENTIAL);
      const account = await store.accounts.getById(ACCOUNT_ID);
      expect(account).toMatchObject({ service: 'github', serviceGrant: 'manual' });
      expect(await store.accounts.countByService()).toEqual({});

      const row = (sql: string) => store.db.prepare(sql).all();
      expect(row('SELECT id, sign_in_provider FROM groups')).toEqual([
        { id: 'g1', sign_in_provider: 'idp' },
      ]);
      expect(row('SELECT id, sign_in_provider FROM administrators')).toEqual([
        { id: 'd1', sign_in_provider: 'idp' },
      ]);
      expect((await store.signInAccounts.getByEmail('local', 'carol@example.com'))?.id).toBe('sa');
      expect(await store.signInAccounts.pendingLinks('local', 'dan@example.com')).toHaveLength(1);

      // History reads with the new names, each in its sense.
      expect(row('SELECT id, before_json, after_json FROM audit ORDER BY id')).toEqual([
        {
          id: 'a1',
          before_json: JSON.stringify({ status: 'active' }),
          after_json: JSON.stringify({
            service: 'github',
            display_name: 'acme',
            service_grant: 'manual',
          }),
        },
        {
          id: 'a2',
          before_json: null,
          after_json: JSON.stringify({
            kind: 'email',
            email: 'bob@example.com',
            sign_in_provider: 'idp',
          }),
        },
        {
          id: 'a3',
          before_json: null,
          after_json: JSON.stringify({ outcome: 'refused', error: 'sign-in-provider-disabled' }),
        },
        {
          // The broker's own word stays: `providers` of an OAuth broker are not services.
          id: 'a4',
          before_json: null,
          after_json: JSON.stringify({ url: 'https://broker.example.com', providers: ['google'] }),
        },
      ]);
      // Nobody is signed out, no sign-in in progress is lost.
      const sessions = row('SELECT id, value_json FROM web_sessions ORDER BY id') as {
        id: string;
        value_json: string;
      }[];
      expect(JSON.parse(sessions[0]?.value_json ?? '{}')).toMatchObject({
        login: { signInProvider: 'idp' },
      });
      expect(JSON.parse(sessions[1]?.value_json ?? '{}')).toMatchObject({
        signInProviderId: 'idp',
      });
      expect(() => store.db.prepare("UPDATE audit SET act = 'x' WHERE id = 'a1'").run()).toThrow(
        /append-only/,
      );
      expect(store.db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      await store.close();
    }
  });
});
