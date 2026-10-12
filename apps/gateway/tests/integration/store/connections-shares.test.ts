/**
 * Connections (encrypted credentials, resources) and shares (enumerated restrictions
 * checked against the catalog at write time). Spec §2.2, §6, §10 structural rule
 * "every persisted restriction is an enumerated list, never a wildcard".
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UnknownRiskIdError, type Store } from '../../../src/server/store/index.ts';
import { openTestStore, type TestStore } from '../../../src/server/store/testing.ts';

describe('connections repository', () => {
  let t: TestStore;
  let store: Store;
  let owner: string;
  let group: string;

  beforeEach(async () => {
    t = openTestStore();
    store = t.store;
    owner = (await store.users.upsertFromIdp({ subject: 'o', email: 'o@x' })).id;
    group = (await store.groups.getOrCreate('github-admins', 'idp')).id;
  });
  afterEach(() => store.close());

  it('creates a user-owned connection and seals the credential with the connection id', async () => {
    const c = await store.connections.create({
      provider: 'github',
      owner: { kind: 'user', id: owner },
      displayName: 'GitHub (acme)',
      credential: 'ghp_secret',
      credentialExpiresAt: '2027-01-01T00:00:00.000Z',
      metadata: { installation_id: 42 },
    });
    expect(c).toMatchObject({
      provider: 'github',
      owner: { kind: 'user', id: owner },
      status: 'active',
      keyVersion: 1,
      credentialExpiresAt: '2027-01-01T00:00:00.000Z',
      metadata: { installation_id: 42 },
    });
    expect(t.encryptor.sealCalls).toEqual([{ associatedData: c.id }]);
    expect(await store.connections.getCredential(c.id)).toBe('ghp_secret');

    // The blob is bound to the connection id: moving it to another row fails to open.
    const other = await store.connections.create({
      provider: 'github',
      owner: { kind: 'user', id: owner },
      displayName: 'other',
      credential: null,
    });
    const blob = store.db
      .prepare<
        [string],
        { credential_blob: Buffer }
      >('SELECT credential_blob FROM connections WHERE id = ?')
      .get(c.id)?.credential_blob;
    store.db
      .prepare('UPDATE connections SET credential_blob = ?, key_version = 1 WHERE id = ?')
      .run(blob, other.id);
    await expect(store.connections.getCredential(other.id)).rejects.toThrow(/associated data/);
  });

  it('never exposes the ciphertext on the record', async () => {
    const c = await store.connections.create({
      provider: 'github',
      owner: { kind: 'user', id: owner },
      displayName: 'x',
      credential: 'ghp_plain_secret_value',
    });
    expect(Object.keys(c)).not.toContain('credentialBlob');
    expect(JSON.stringify(c)).not.toContain('ghp_plain_secret_value');
    expect(JSON.stringify(c)).not.toContain('credential_blob');
  });

  it('supports group ownership, transfer and the unowned state', async () => {
    const c = await store.connections.create({
      provider: 'github',
      owner: { kind: 'group', id: group },
      displayName: 'x',
      credential: null,
    });
    expect(c.owner).toEqual({ kind: 'group', id: group });
    const transferred = await store.connections.transferOwner(c.id, { kind: 'user', id: owner });
    expect(transferred.owner).toEqual({ kind: 'user', id: owner });
    const unowned = await store.connections.setStatus(c.id, 'unowned');
    expect(unowned.status).toBe('unowned');
    const revoked = await store.connections.setStatus(c.id, 'revoked');
    expect(revoked.revokedAt).toBe(t.clock.now().toISOString());
    await expect(
      store.connections.transferOwner(c.id, { kind: 'group', id: group }),
    ).rejects.toThrow(/revoked/);
  });

  it('reconnection replaces the credential and reactivates an expired connection', async () => {
    const c = await store.connections.create({
      provider: 'vercel',
      owner: { kind: 'user', id: owner },
      displayName: 'x',
      credential: 'old',
    });
    await store.connections.setStatus(c.id, 'expired');
    const fresh = await store.connections.setCredential(c.id, 'new', null);
    expect(fresh.status).toBe('active');
    expect(await store.connections.getCredential(c.id)).toBe('new');
  });

  it('lists by provider, status and owning principals', async () => {
    const mine = await store.connections.create({
      provider: 'github',
      owner: { kind: 'user', id: owner },
      displayName: 'mine',
      credential: null,
    });
    const theirs = await store.connections.create({
      provider: 'supabase',
      owner: { kind: 'group', id: group },
      displayName: 'group',
      credential: null,
    });
    expect((await store.connections.list({ provider: 'github' })).map((c) => c.id)).toEqual([
      mine.id,
    ]);
    expect((await store.connections.list({ status: 'active' })).map((c) => c.id)).toEqual([
      mine.id,
      theirs.id,
    ]);
    expect(
      (
        await store.connections.listOwnedBy([
          { kind: 'user', id: owner },
          { kind: 'group', id: group },
        ])
      ).map((c) => c.id),
    ).toEqual([mine.id, theirs.id]);
    expect(await store.connections.listOwnedBy([])).toEqual([]);
  });

  it('syncs discovered resources by ref, keeping ids and owner labels', async () => {
    const c = await store.connections.create({
      provider: 'supabase',
      owner: { kind: 'user', id: owner },
      displayName: 'x',
      credential: null,
    });
    const first = await store.connections.replaceResources(c.id, [
      { ref: 'proj-a', displayName: 'Project A' },
      { ref: 'proj-b', displayName: 'Project B' },
    ]);
    expect(first.map((r) => r.ref)).toEqual(['proj-a', 'proj-b']);
    const a = first[0];
    if (!a) throw new Error('expected a resource');
    await store.connections.setResourceEnv(a.id, 'prod');

    const second = await store.connections.replaceResources(c.id, [
      { ref: 'proj-a', displayName: 'Project A (renamed)' },
      { ref: 'proj-c', displayName: 'Project C', env: 'staging' },
    ]);
    expect(second.map((r) => [r.ref, r.env, r.displayName])).toEqual([
      ['proj-a', 'prod', 'Project A (renamed)'],
      ['proj-c', 'staging', 'Project C'],
    ]);
    expect(second[0]?.id).toBe(a.id);
    expect(await store.connections.listResources(c.id)).toEqual(second);
    expect(await store.connections.getResource(a.id)).toEqual(second[0]);
    await expect(store.connections.setResourceEnv('missing', null)).rejects.toThrow(/not found/);
  });
});

describe('shares repository', () => {
  let store: Store;
  let owner: string;
  let target: string;
  let group: string;
  let connection: string;

  beforeEach(async () => {
    store = openTestStore().store;
    owner = (await store.users.upsertFromIdp({ subject: 'o', email: 'o@x' })).id;
    target = (await store.users.upsertFromIdp({ subject: 't', email: 't@x' })).id;
    group = (await store.groups.getOrCreate('devs', 'idp')).id;
    connection = (
      await store.connections.create({
        provider: 'github',
        owner: { kind: 'user', id: owner },
        displayName: 'gh',
        credential: null,
      })
    ).id;
  });
  afterEach(() => store.close());

  it('stores the restriction as one row per risk', async () => {
    const share = await store.shares.create({
      connectionId: connection,
      target: { kind: 'user', id: target },
      restriction: ['github.write-feature-branch', 'github.code-read', 'github.code-read'],
      createdByUserId: owner,
    });
    expect(share.restriction).toEqual(['github.code-read', 'github.write-feature-branch']);
    const rows = store.db
      .prepare<
        [string],
        { risk_id: string }
      >('SELECT risk_id FROM share_restrictions WHERE share_id = ? ORDER BY risk_id')
      .all(share.id);
    expect(rows).toHaveLength(2);
  });

  it('refuses a risk id that is not in the loaded catalog (no wildcard can be persisted)', async () => {
    for (const bad of [['*'], ['github.*'], ['github.unknown-risk'], ['github.code-read', '']]) {
      await expect(
        store.shares.create({
          connectionId: connection,
          target: { kind: 'user', id: target },
          restriction: bad,
          createdByUserId: owner,
        }),
      ).rejects.toThrow(UnknownRiskIdError);
    }
    expect(await store.shares.listForConnection(connection)).toEqual([]);
  });

  it('the schema itself rejects a wildcard even if the catalog check were bypassed', () => {
    store.db
      .prepare(
        `INSERT INTO shares (id, connection_id, target_kind, target_user_id, status, created_by_user_id, created_at)
         VALUES ('s1', ?, 'user', ?, 'active', ?, '2026-10-13T00:00:00.000Z')`,
      )
      .run(connection, target, owner);
    expect(() =>
      store.db
        .prepare('INSERT INTO share_restrictions (share_id, risk_id) VALUES (?, ?)')
        .run('s1', '*'),
    ).toThrow(/CHECK/);
    expect(() =>
      store.db
        .prepare('INSERT INTO share_restrictions (share_id, risk_id) VALUES (?, ?)')
        .run('s1', ''),
    ).toThrow(/CHECK/);
  });

  it('an empty restriction is valid and authorizes nothing', async () => {
    const share = await store.shares.create({
      connectionId: connection,
      target: { kind: 'group', id: group },
      restriction: [],
      createdByUserId: owner,
    });
    expect(share.restriction).toEqual([]);
    expect(share.target).toEqual({ kind: 'group', id: group });
  });

  it('lists active shares for a user and their groups, and revokes', async () => {
    const direct = await store.shares.create({
      connectionId: connection,
      target: { kind: 'user', id: target },
      restriction: ['github.code-read'],
      createdByUserId: owner,
    });
    const viaGroup = await store.shares.create({
      connectionId: connection,
      target: { kind: 'group', id: group },
      restriction: ['github.merge-protected'],
      createdByUserId: owner,
    });
    const principals = [
      { kind: 'user' as const, id: target },
      { kind: 'group' as const, id: group },
    ];
    expect((await store.shares.listActiveForTargets(principals)).map((s) => s.id)).toEqual([
      direct.id,
      viaGroup.id,
    ]);
    const revoked = await store.shares.revoke(direct.id);
    expect(revoked.status).toBe('revoked');
    expect(revoked.revokedAt).not.toBeNull();
    expect((await store.shares.listActiveForTargets(principals)).map((s) => s.id)).toEqual([
      viaGroup.id,
    ]);
    expect(await store.shares.listForConnection(connection)).toHaveLength(2);
    await expect(store.shares.revoke(direct.id)).rejects.toThrow(/already revoked/);
    expect(await store.shares.getById('missing')).toBeNull();
  });
});
