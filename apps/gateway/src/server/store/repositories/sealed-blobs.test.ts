import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { createEncryptor, type EncryptedBlob, type Encryptor } from '../../crypto';
import { SetCatalogIndex } from '../catalog-index.ts';
import { openMemoryStore, type Store } from '../index.ts';

const KEY_1 = new Uint8Array(randomBytes(32));
const KEY_2 = new Uint8Array(randomBytes(32));

/** The store keeps the encryptor it was opened with; the test swaps what is behind it. */
class SwitchableEncryptor implements Encryptor {
  constructor(public inner: Encryptor) {}
  get currentKeyVersion(): number {
    return this.inner.currentKeyVersion;
  }
  encrypt(ad: string, plain: string): Promise<EncryptedBlob> {
    return this.inner.encrypt(ad, plain);
  }
  decrypt(ad: string, sealed: EncryptedBlob): Promise<string> {
    return this.inner.decrypt(ad, sealed);
  }
}

const v1 = (): Promise<Encryptor> =>
  createEncryptor({ masterKey: KEY_1, keyVersion: 1, previousKeys: new Map() });
const v2WithPrevious = (): Promise<Encryptor> =>
  createEncryptor({ masterKey: KEY_2, keyVersion: 2, previousKeys: new Map([[1, KEY_1]]) });
const v2Alone = (): Promise<Encryptor> =>
  createEncryptor({ masterKey: KEY_2, keyVersion: 2, previousKeys: new Map() });

async function seeded(): Promise<{ store: Store; encryptor: SwitchableEncryptor; ids: string[] }> {
  const encryptor = new SwitchableEncryptor(await v1());
  const store = openMemoryStore({ encryptor, catalog: new SetCatalogIndex([]) });
  const user = await store.users.upsertFromIdp({
    issuer: 'https://idp.example.com',
    subject: 'u1',
    email: 'u1@example.com',
  });
  const ids: string[] = [];
  for (const credential of ['first-credential', 'second-credential']) {
    const connection = await store.connections.create({
      provider: 'github',
      owner: { kind: 'user', id: user.id },
      displayName: credential,
      credential,
    });
    ids.push(connection.id);
  }
  await store.config.setSecret('idp.client_secret', 'company-secret');
  await store.config.set('telemetry', '{"enabled":false}');
  const account = await store.localAccounts.create({ provider: 'local', email: 'u2@example.com' });
  if (!account) throw new Error('no account');
  await store.localAccounts.writeSecret(account.id, 'password', '$argon2id$stand-in');
  ids.push(account.id);
  return { store, encryptor, ids };
}

function versionsOf(rows: { table: string; keyVersion: number; count: number }[]): string[] {
  return rows.map((r) => `${r.table}@${r.keyVersion}=${r.count}`);
}

describe('sealed blobs: the master-key re-seal', () => {
  it('counts the blobs per table and version', async () => {
    const { store } = await seeded();
    expect(versionsOf(await store.sealedBlobs.versions())).toEqual([
      'connections@1=2',
      'instance_config@1=1',
      'local_secrets@1=1',
    ]);
  });

  it('a dry run opens every blob and writes nothing', async () => {
    const { store, encryptor } = await seeded();
    encryptor.inner = await v2WithPrevious();
    const report = await store.sealedBlobs.reseal({ apply: false });
    expect(report.apply).toBe(false);
    expect(report.tables).toEqual([
      {
        table: 'connections',
        current: 0,
        currentUnreadable: 0,
        resealed: 2,
        unreadable: 0,
        changed: 0,
      },
      {
        table: 'instance_config',
        current: 0,
        currentUnreadable: 0,
        resealed: 1,
        unreadable: 0,
        changed: 0,
      },
      {
        table: 'requests',
        current: 0,
        currentUnreadable: 0,
        resealed: 0,
        unreadable: 0,
        changed: 0,
      },
      {
        table: 'local_secrets',
        current: 0,
        currentUnreadable: 0,
        resealed: 1,
        unreadable: 0,
        changed: 0,
      },
    ]);
    expect(versionsOf(await store.sealedBlobs.versions())).toEqual([
      'connections@1=2',
      'instance_config@1=1',
      'local_secrets@1=1',
    ]);
  });

  it('applied, it moves every blob to the current version; the old key is then not needed', async () => {
    const { store, encryptor, ids } = await seeded();
    encryptor.inner = await v2WithPrevious();
    const report = await store.sealedBlobs.reseal({ apply: true });
    expect(report.tables.map((t) => t.resealed)).toEqual([2, 1, 0, 1]);
    expect(versionsOf(await store.sealedBlobs.versions())).toEqual([
      'connections@2=2',
      'instance_config@2=1',
      'local_secrets@2=1',
    ]);

    // Without the previous key, everything still opens: it was sealed again.
    encryptor.inner = await v2Alone();
    expect(await store.connections.getCredential(ids[0] ?? '')).toBe('first-credential');
    expect(await store.connections.getCredential(ids[1] ?? '')).toBe('second-credential');
    expect(await store.config.getSecret('idp.client_secret')).toBe('company-secret');
    expect(await store.localAccounts.readSecret(ids[2] ?? '', 'password')).toBe(
      '$argon2id$stand-in',
    );
  });

  it('is idempotent: a second run finds the blobs current', async () => {
    const { store, encryptor } = await seeded();
    encryptor.inner = await v2WithPrevious();
    await store.sealedBlobs.reseal({ apply: true });
    const again = await store.sealedBlobs.reseal({ apply: true });
    expect(again.tables).toEqual([
      {
        table: 'connections',
        current: 2,
        currentUnreadable: 0,
        resealed: 0,
        unreadable: 0,
        changed: 0,
      },
      {
        table: 'instance_config',
        current: 1,
        currentUnreadable: 0,
        resealed: 0,
        unreadable: 0,
        changed: 0,
      },
      {
        table: 'requests',
        current: 0,
        currentUnreadable: 0,
        resealed: 0,
        unreadable: 0,
        changed: 0,
      },
      {
        table: 'local_secrets',
        current: 1,
        currentUnreadable: 0,
        resealed: 0,
        unreadable: 0,
        changed: 0,
      },
    ]);
  });

  it('a blob whose version has no key is counted unreadable and left as it is', async () => {
    const { store, encryptor } = await seeded();
    encryptor.inner = await v2Alone();
    const report = await store.sealedBlobs.reseal({ apply: true });
    expect(report.tables.map((t) => [t.resealed, t.unreadable])).toEqual([
      [0, 2],
      [0, 1],
      [0, 0],
      [0, 1],
    ]);
    expect(versionsOf(await store.sealedBlobs.versions())).toEqual([
      'connections@1=2',
      'instance_config@1=1',
      'local_secrets@1=1',
    ]);
  });

  it('a wrong key under the right version is unreadable too, never a crash', async () => {
    const { store, encryptor } = await seeded();
    encryptor.inner = await createEncryptor({
      masterKey: KEY_2,
      keyVersion: 2,
      previousKeys: new Map([[1, new Uint8Array(randomBytes(32))]]),
    });
    const report = await store.sealedBlobs.reseal({ apply: true });
    expect(report.tables.map((t) => t.unreadable)).toEqual([2, 1, 0, 1]);
  });

  it('a row the gateway rewrites during the run is left as the gateway wrote it', async () => {
    const { store, encryptor, ids } = await seeded();
    const v2 = await v2WithPrevious();
    let rewritten = false;
    // The gateway refreshes the first credential right after the command opened it.
    encryptor.inner = {
      currentKeyVersion: 2,
      encrypt: (ad, plain) => v2.encrypt(ad, plain),
      async decrypt(ad, sealed) {
        const plain = await v2.decrypt(ad, sealed);
        if (!rewritten && ad === ids[0]) {
          rewritten = true;
          await store.connections.refreshCredential(ids[0], 'refreshed-credential');
        }
        return plain;
      },
    };
    const report = await store.sealedBlobs.reseal({ apply: true });
    expect(report.tables[0]).toEqual({
      table: 'connections',
      current: 0,
      currentUnreadable: 0,
      resealed: 1,
      unreadable: 0,
      changed: 1,
    });
    encryptor.inner = await v2Alone();
    expect(await store.connections.getCredential(ids[0] ?? '')).toBe('refreshed-credential');
  });
});
