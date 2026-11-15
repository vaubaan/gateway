/**
 * Store boot and schema v1 — the process boots against an empty file and creates the
 * schema; WAL and pragmas are set; every table is STRICT; backups are consistent copies.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { StoreLiveness } from '../../../src/server/compose/ports.ts';
import {
  journalMode,
  openStore,
  SetCatalogIndex,
  type Store,
} from '../../../src/server/store/index.ts';
import { openTestStore, StubEncryptor, TEST_RISK_IDS } from '../../support/store/testing.ts';

const EXPECTED_TABLES = [
  'account_resources',
  'accounts',
  'administrators',
  'approvals',
  'audit',
  'audit_purge_guard',
  'audit_resource_sets',
  'audit_risk_set_members',
  'audit_risk_sets',
  'audit_risks',
  'delegations',
  'events',
  'git_pending_refs',
  'group_members',
  'groups',
  'instance_config',
  'invitations',
  'local_links',
  'local_secrets',
  'mission_accounts',
  'mission_members',
  'mission_policy',
  'mission_resource_sets',
  'mission_resources',
  'mission_tokens',
  'mission_trust_marks',
  'missions',
  'notification_addresses',
  'notification_devices',
  'notification_mail',
  'permission_refusal_lines',
  'permission_refusals',
  'permission_requests',
  'request_lines',
  'requests',
  'schema_migrations',
  'session_counters',
  'sessions',
  'share_restrictions',
  'shares',
  'sign_in_accounts',
  'user_second_factor_secrets',
  'user_second_factors',
  'users',
  'web_sessions',
];

function tableNames(store: Store): string[] {
  return store.db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((t) => t.name);
}

describe('store schema v1', () => {
  const opened: Store[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((s) => s.close()));
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function fileStore(path: string, busyTimeoutMs?: number): Store {
    const store = openStore({
      path,
      encryptor: new StubEncryptor(),
      catalog: new SetCatalogIndex(TEST_RISK_IDS),
      busyTimeoutMs,
    });
    opened.push(store);
    return store;
  }

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'vbn-store-'));
    dirs.push(dir);
    return dir;
  }

  it('creates every table of the plan on an in-memory database', () => {
    const { store } = openTestStore();
    opened.push(store);
    expect(store.schemaVersion).toBe(37);
    expect(tableNames(store)).toEqual(EXPECTED_TABLES);
  });

  it('declares every table STRICT', () => {
    const { store } = openTestStore();
    opened.push(store);
    const nonStrict = store.db
      .prepare<[], { name: string }>(
        "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%' AND strict = 0",
      )
      .all()
      .map((t) => t.name);
    expect(nonStrict).toEqual([]);
  });

  it('satisfies the composition root Store port (kind, ping, close)', async () => {
    const { store } = openTestStore();
    opened.push(store);
    const port: StoreLiveness = store;
    expect(port.kind).toBe('memory');
    await expect(port.ping()).resolves.toBeUndefined();
    await port.close();
    opened.splice(opened.indexOf(store), 1);
    await expect(port.ping()).rejects.toThrow();
  });

  it('boots against an empty file, enables WAL and foreign keys, and reopens without re-migrating', async () => {
    const path = join(tempDir(), 'gateway.sqlite');
    const first = fileStore(path);
    expect(first.kind).toBe('sqlite');
    expect(existsSync(path)).toBe(true);
    expect(journalMode(first.db)).toBe('wal');
    expect(first.db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(first.db.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
    await first.close();
    opened.splice(opened.indexOf(first), 1);

    const second = fileStore(path);
    expect(second.schemaVersion).toBe(37);
    expect(
      second.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM schema_migrations').get()?.n,
    ).toBe(37);
  });

  it('serializes two writers on the same file with BEGIN IMMEDIATE', async () => {
    const path = join(tempDir(), 'gateway.sqlite');
    const a = fileStore(path);
    const b = fileStore(path, 50);

    // Writer A holds the reserved lock; writer B must wait and then fail with SQLITE_BUSY.
    a.db.prepare('BEGIN IMMEDIATE').run();
    await expect(
      b.users.upsertFromIdp({ issuer: 'http://idp.test', subject: 'u', email: 'u@x' }),
    ).rejects.toMatchObject({
      code: 'SQLITE_BUSY',
    });
    a.db.prepare('COMMIT').run();

    // Once A releases the lock, B's write goes through and A observes it.
    const user = await b.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'u',
      email: 'u@x',
    });
    expect(await a.users.getByIdentity('http://idp.test', 'u')).toMatchObject({
      id: user.id,
    });
  });

  it('backs up to a consistent single file with VACUUM INTO', async () => {
    const dir = tempDir();
    const store = fileStore(join(dir, 'gateway.sqlite'));
    await store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 's',
      email: 's@x',
    });
    const backupPath = join(dir, 'backup.sqlite');
    store.backupTo(backupPath);

    const copy = new BetterSqlite3(backupPath, { readonly: true });
    try {
      expect(copy.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM users').get()?.n).toBe(1);
      expect(existsSync(`${backupPath}-wal`)).toBe(false);
    } finally {
      copy.close();
    }
  });
});
