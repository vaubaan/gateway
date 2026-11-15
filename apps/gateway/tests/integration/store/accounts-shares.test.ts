/**
 * Accounts (encrypted credentials, resources) and shares (enumerated restrictions
 * checked against the catalog at write time). Spec §2.2, §6, §10 structural rule
 * "every persisted restriction is an enumerated list, never a wildcard".
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError, UnknownRiskIdError, type Store } from '../../../src/server/store/index.ts';
import { makeUnowned, openTestStore, type TestStore } from '../../support/store/testing.ts';

describe('accounts repository', () => {
  let t: TestStore;
  let store: Store;
  let owner: string;
  let group: string;

  beforeEach(async () => {
    t = openTestStore();
    store = t.store;
    owner = (
      await store.users.upsertFromIdp({
        issuer: 'http://idp.test',
        subject: 'o',
        email: 'o@x',
      })
    ).id;
    group = (await store.groups.getOrCreate('github-admins', 'idp', 'idp')).id;
  });
  afterEach(() => store.close());

  it('creates a user-owned account and seals the credential with the account id', async () => {
    const c = await store.accounts.create({
      service: 'github',
      owner: { kind: 'user', id: owner },
      displayName: 'GitHub (acme)',
      credential: 'ghp_secret',
      credentialExpiresAt: '2027-01-01T00:00:00.000Z',
      metadata: { installation_id: 42 },
    });
    expect(c).toMatchObject({
      service: 'github',
      owner: { kind: 'user', id: owner },
      status: 'active',
      keyVersion: 1,
      credentialExpiresAt: '2027-01-01T00:00:00.000Z',
      metadata: { installation_id: 42 },
    });
    expect(t.encryptor.sealCalls).toEqual([{ associatedData: c.id }]);
    expect(await store.accounts.getCredential(c.id)).toBe('ghp_secret');

    // The blob is bound to the account id: moving it to another row fails to open.
    const other = await store.accounts.create({
      service: 'github',
      owner: { kind: 'user', id: owner },
      displayName: 'other',
      credential: null,
    });
    const blob = store.db
      .prepare<[string], { credential_blob: Buffer }>(
        'SELECT credential_blob FROM accounts WHERE id = ?',
      )
      .get(c.id)?.credential_blob;
    store.db
      .prepare('UPDATE accounts SET credential_blob = ?, key_version = 1 WHERE id = ?')
      .run(blob, other.id);
    await expect(store.accounts.getCredential(other.id)).rejects.toThrow(/associated data/);
  });

  it('never exposes the ciphertext on the record', async () => {
    const c = await store.accounts.create({
      service: 'github',
      owner: { kind: 'user', id: owner },
      displayName: 'x',
      credential: 'ghp_plain_secret_value',
    });
    expect(Object.keys(c)).not.toContain('credentialBlob');
    expect(JSON.stringify(c)).not.toContain('ghp_plain_secret_value');
    expect(JSON.stringify(c)).not.toContain('credential_blob');
  });

  it('supports group ownership, transfer and the unowned state', async () => {
    const c = await store.accounts.create({
      service: 'github',
      owner: { kind: 'group', id: group },
      displayName: 'x',
      credential: null,
    });
    expect(c.owner).toEqual({ kind: 'group', id: group });
    const transferred = await store.accounts.transferOwner(c.id, { kind: 'user', id: owner });
    expect(transferred.owner).toEqual({ kind: 'user', id: owner });
    // `unowned` the way production reaches it: an owner group without member, then the sweep.
    const emptied = await makeUnowned(store, c.id);
    expect(await store.accounts.getById(c.id)).toMatchObject({
      status: 'unowned',
      owner: { kind: 'group', id: emptied.id },
    });
    const revoked = await store.accounts.revoke(c.id);
    expect(revoked.status).toBe('revoked');
    expect(revoked.revokedAt).toBe(t.clock.now().toISOString());
    await expect(store.accounts.transferOwner(c.id, { kind: 'group', id: group })).rejects.toThrow(
      /revoked/,
    );
  });

  it('reconnection replaces the credential and reactivates an expired account', async () => {
    const c = await store.accounts.create({
      service: 'vercel',
      owner: { kind: 'user', id: owner },
      displayName: 'x',
      credential: 'old',
    });
    expect(await store.accounts.markExpired(c.id)).toBe(true);
    expect((await store.accounts.getById(c.id))?.status).toBe('expired');
    expect(await store.accounts.reconnect(c.id, 'new', null)).toBe(true);
    expect((await store.accounts.getById(c.id))?.status).toBe('active');
    expect(await store.accounts.getCredential(c.id)).toBe('new');
  });

  it('lists by service, status and owning principals', async () => {
    const mine = await store.accounts.create({
      service: 'github',
      owner: { kind: 'user', id: owner },
      displayName: 'mine',
      credential: null,
    });
    const theirs = await store.accounts.create({
      service: 'supabase',
      owner: { kind: 'group', id: group },
      displayName: 'group',
      credential: null,
    });
    expect((await store.accounts.list({ service: 'github' })).map((c) => c.id)).toEqual([mine.id]);
    expect((await store.accounts.list({ status: 'active' })).map((c) => c.id)).toEqual([
      mine.id,
      theirs.id,
    ]);
    expect(
      (
        await store.accounts.listOwnedBy([
          { kind: 'user', id: owner },
          { kind: 'group', id: group },
        ])
      ).map((c) => c.id),
    ).toEqual([mine.id, theirs.id]);
    expect(await store.accounts.listOwnedBy([])).toEqual([]);
  });

  it('syncs discovered resources by ref, keeping ids and owner labels', async () => {
    const c = await store.accounts.create({
      service: 'supabase',
      owner: { kind: 'user', id: owner },
      displayName: 'x',
      credential: null,
    });
    const first = await store.accounts.syncDiscoveredResources(c.id, [
      { ref: 'proj-a', displayName: 'Project A' },
      { ref: 'proj-b', displayName: 'Project B' },
    ]);
    expect(first.map((r) => r.ref)).toEqual(['proj-a', 'proj-b']);
    const a = first[0];
    if (!a) throw new Error('expected a resource');
    await store.accounts.setResourceEnv(a.id, 'prod');

    // Past the grace a fresh row has (FRESH_RESOURCE_STALE_GRACE_MS).
    t.clock.advance(16 * 60_000);
    const second = await store.accounts.syncDiscoveredResources(c.id, [
      { ref: 'proj-a', displayName: 'Project A (renamed)' },
      { ref: 'proj-c', displayName: 'Project C', env: 'staging' },
    ]);
    // `proj-b` is no longer discovered: it is kept and marked stale, never deleted.
    expect(second.map((r) => [r.ref, r.env, r.displayName, r.staleSince !== null])).toEqual([
      ['proj-a', 'prod', 'Project A (renamed)', false],
      ['proj-b', null, 'Project B', true],
      ['proj-c', 'staging', 'Project C', false],
    ]);
    expect(second[0]?.id).toBe(a.id);
    expect(await store.accounts.listResources(c.id)).toEqual(second);
    expect(await store.accounts.getResource(a.id)).toEqual(second[0]);
    await expect(store.accounts.setResourceEnv('missing', null)).rejects.toThrow(/not found/);
  });

  it('reads every unlabelled resource under the account default, never stores it, and lets own labels win', async () => {
    const c = await store.accounts.create({
      service: 'stripe',
      owner: { kind: 'user', id: owner },
      displayName: 'x',
      credential: null,
    });
    expect(c.defaultEnv).toBeNull();
    await store.accounts.syncDiscoveredResources(c.id, [
      { ref: 'acct:live', displayName: 'Live', env: 'live' },
      { ref: 'app-a', displayName: 'A' },
      { ref: 'app-b', displayName: 'B' },
    ]);
    const [, a] = await store.accounts.listResources(c.id);
    await store.accounts.setResourceEnv(a!.id, 'prod');

    const updated = await store.accounts.setDefaultEnv(c.id, 'staging');
    expect(updated.defaultEnv).toBe('staging');
    expect((await store.accounts.getById(c.id))?.defaultEnv).toBe('staging');
    const read = await store.accounts.listResources(c.id);
    expect(read.map((r) => [r.ref, r.env, r.envSource])).toEqual([
      ['acct:live', 'live', 'plugin'],
      ['app-a', 'prod', 'owner'],
      ['app-b', 'staging', 'account-default'],
    ]);
    // `getResource` and the answer of a discovery read the same way; a new ref inherits it.
    const b = read[2]!;
    expect(await store.accounts.getResource(b.id)).toMatchObject({
      env: 'staging',
      envSource: 'account-default',
    });
    const synced = await store.accounts.syncDiscoveredResources(c.id, [
      { ref: 'acct:live', displayName: 'Live', env: 'live' },
      { ref: 'app-a', displayName: 'A' },
      { ref: 'app-b', displayName: 'B' },
      { ref: 'app-c', displayName: 'C, created since' },
    ]);
    expect(synced.find((r) => r.ref === 'app-c')).toMatchObject({
      env: 'staging',
      envSource: 'account-default',
    });
    // The default is never written on the resource: the stored label stays the resource's own.
    const stored = store.db
      .prepare<[string], { ref: string; env: string | null }>(
        'SELECT ref, env FROM account_resources WHERE account_id = ? ORDER BY ref',
      )
      .all(c.id);
    expect(stored).toEqual([
      { ref: 'acct:live', env: 'live' },
      { ref: 'app-a', env: 'prod' },
      { ref: 'app-b', env: null },
      { ref: 'app-c', env: null },
    ]);

    // Cleared: every inheriting resource is unlabelled again.
    await store.accounts.setDefaultEnv(c.id, null);
    expect(
      (await store.accounts.listResources(c.id)).map((r) => [r.ref, r.env, r.envSource]),
    ).toEqual([
      ['acct:live', 'live', 'plugin'],
      ['app-a', 'prod', 'owner'],
      ['app-b', null, 'owner'],
      ['app-c', null, 'owner'],
    ]);
    await expect(store.accounts.setDefaultEnv('missing', 'prod')).rejects.toThrow(/not found/);
  });

  it('merges a discovery without touching owner edits, and never deletes', async () => {
    const c = await store.accounts.create({
      service: 'resend',
      owner: { kind: 'user', id: owner },
      displayName: 'x',
      credential: null,
    });
    const first = await store.accounts.syncDiscoveredResources(c.id, [
      {
        ref: 'mail.acme.com',
        displayName: 'mail.acme.com (pending)',
        metadata: { kind: 'domain', status: 'pending', internal_domains: [] },
      },
      { ref: 'acct:live', displayName: 'Acme (live)', env: 'live' },
      { ref: 'gone', displayName: 'Gone soon' },
      { ref: 'gone', displayName: 'listed twice: the first wins' },
    ]);
    expect(first.map((r) => [r.ref, r.env, r.envSource, r.hidden, r.staleSince])).toEqual([
      ['acct:live', 'live', 'plugin', false, null],
      ['gone', null, 'owner', false, null],
      ['mail.acme.com', null, 'owner', false, null],
    ]);
    const live = first[0]!;
    const gone = first[1]!;
    const domain = first[2]!;
    expect(gone.displayName).toBe('Gone soon');
    expect(domain.metadata).toEqual({ kind: 'domain', status: 'pending', internal_domains: [] });
    expect(domain.ownerMetadata).toBeNull();

    await store.accounts.setResourceEnv(domain.id, 'prod');
    await store.accounts.setResourceDisplayName(domain.id, 'Transactional');
    await store.accounts.setResourceHidden(gone.id, true);
    await store.accounts.setResourceOwnerMetadata(domain.id, { internal_domains: ['acme.com'] });

    t.clock.advance(16 * 60_000); // past the grace of a fresh row
    const second = await store.accounts.syncDiscoveredResources(c.id, [
      {
        ref: 'mail.acme.com',
        displayName: 'mail.acme.com',
        metadata: { kind: 'domain', status: 'verified', internal_domains: [] },
      },
      { ref: 'acct:live', displayName: 'Acme Inc (live)', env: 'live' },
    ]);
    expect(second).toHaveLength(3);
    expect(second.find((r) => r.id === domain.id)).toMatchObject({
      env: 'prod',
      envSource: 'owner',
      displayName: 'Transactional',
      displayNameEdited: true,
      metadata: { kind: 'domain', status: 'verified', internal_domains: ['acme.com'] },
      ownerMetadata: { internal_domains: ['acme.com'] },
      discoveredAt: '2026-10-13T09:16:00.000Z',
      staleSince: null,
    });
    expect(second.find((r) => r.id === live.id)).toMatchObject({
      env: 'live',
      envSource: 'plugin',
      displayName: 'Acme Inc (live)',
    });
    expect(second.find((r) => r.id === gone.id)).toMatchObject({
      hidden: true,
      staleSince: '2026-10-13T09:16:00.000Z',
      discoveredAt: '2026-10-13T09:00:00.000Z',
    });

    // The plugin stops labelling: the label stays and becomes the owner's to edit.
    const third = await store.accounts.syncDiscoveredResources(c.id, [
      { ref: 'acct:live', displayName: 'Acme Inc' },
      { ref: 'gone', displayName: 'Back again' },
    ]);
    expect(third.find((r) => r.id === live.id)).toMatchObject({ env: 'live', envSource: 'owner' });
    expect(third.find((r) => r.id === gone.id)).toMatchObject({ staleSince: null, hidden: true });

    // Handing the name back to discovery, and clearing the owner metadata.
    await store.accounts.setResourceDisplayName(domain.id, null);
    await store.accounts.setResourceOwnerMetadata(domain.id, null);
    const fourth = await store.accounts.syncDiscoveredResources(c.id, [
      { ref: 'mail.acme.com', displayName: 'mail.acme.com', metadata: { status: 'verified' } },
    ]);
    expect(fourth.find((r) => r.id === domain.id)).toMatchObject({
      displayName: 'mail.acme.com',
      displayNameEdited: false,
      metadata: { status: 'verified' },
      ownerMetadata: null,
    });
    await expect(store.accounts.setResourceHidden('missing', true)).rejects.toThrow(/not found/);
    await expect(store.accounts.setResourceDisplayName('missing', 'x')).rejects.toThrow(
      /not found/,
    );
    await expect(store.accounts.syncDiscoveredResources('missing', [])).rejects.toThrow(
      /not found/,
    );
  });

  it('follows the plugin’s hidden hint until the owner hides or shows the resource', async () => {
    const c = await store.accounts.create({
      service: 'github',
      owner: { kind: 'user', id: owner },
      displayName: 'x',
      credential: null,
    });
    const hiddenOf = async () =>
      Object.fromEntries(
        (await store.accounts.listResources(c.id)).map((r) => [r.ref, [r.hidden, r.hiddenEdited]]),
      );
    const first = await store.accounts.syncDiscoveredResources(c.id, [
      { ref: 'acme/app', displayName: 'acme/app' },
      { ref: 'acme/site', displayName: 'acme/site', hidden: true },
      { ref: 'octo/docs', displayName: 'octo/docs', hidden: true },
    ]);
    expect(await hiddenOf()).toEqual({
      'acme/app': [false, false],
      'acme/site': [true, false],
      'octo/docs': [true, false],
    });
    // The owner shows one hinted resource: discovery never hides it again.
    const site = first.find((r) => r.ref === 'acme/site')!;
    await store.accounts.setResourceHidden(site.id, false);
    await store.accounts.syncDiscoveredResources(c.id, [
      { ref: 'acme/app', displayName: 'acme/app', hidden: true },
      { ref: 'acme/site', displayName: 'acme/site', hidden: true },
      { ref: 'octo/docs', displayName: 'octo/docs' },
    ]);
    // An untouched row follows the hint both ways; the owner's choice stays.
    expect(await hiddenOf()).toEqual({
      'acme/app': [true, false],
      'acme/site': [false, true],
      'octo/docs': [false, false],
    });
    // A creating call's answer says nothing of the hint: a known row keeps its mark.
    await store.accounts.upsertDiscoveredResources(c.id, [
      { ref: 'acme/app', displayName: 'acme/app' },
    ]);
    expect((await hiddenOf())['acme/app']).toEqual([true, false]);
  });

  it('refreshes, expires, reconnects and revokes without ever resurrecting a revoked account', async () => {
    const c = await store.accounts.create({
      service: 'supabase',
      owner: { kind: 'user', id: owner },
      displayName: 'x',
      credential: 'token-1',
    });

    expect(
      await store.accounts.refreshCredential(c.id, 'token-2', '2027-01-01T00:00:00.000Z'),
    ).toBe(true);
    expect(await store.accounts.getCredential(c.id)).toBe('token-2');
    expect((await store.accounts.getById(c.id))?.credentialExpiresAt).toBe(
      '2027-01-01T00:00:00.000Z',
    );

    expect(await store.accounts.markExpired(c.id)).toBe(true);
    expect(await store.accounts.markExpired(c.id)).toBe(false);
    // An expired account is not refreshed behind the owner's back…
    expect(await store.accounts.refreshCredential(c.id, 'token-3')).toBe(false);
    expect(await store.accounts.getCredential(c.id)).toBe('token-2');
    // …the owner reconnects it.
    expect(await store.accounts.reconnect(c.id, 'token-4')).toBe(true);
    expect(await store.accounts.getById(c.id)).toMatchObject({ status: 'active' });

    const revoked = await store.accounts.revoke(c.id);
    expect(revoked).toMatchObject({
      status: 'revoked',
      keyVersion: null,
      credentialExpiresAt: null,
    });
    expect(revoked.revokedAt).not.toBeNull();
    expect(await store.accounts.getCredential(c.id)).toBeNull();
    expect(await store.accounts.reconnect(c.id, 'token-5')).toBe(false);
    expect(await store.accounts.refreshCredential(c.id, 'token-5')).toBe(false);
    expect(await store.accounts.markExpired(c.id)).toBe(false);
    expect((await store.accounts.getById(c.id))?.status).toBe('revoked');
    await expect(store.accounts.revoke('missing')).rejects.toThrow(/not found/);
  });
});

describe('shares repository', () => {
  let store: Store;
  let owner: string;
  let target: string;
  let group: string;
  let account: string;

  beforeEach(async () => {
    store = openTestStore().store;
    owner = (
      await store.users.upsertFromIdp({
        issuer: 'http://idp.test',
        subject: 'o',
        email: 'o@x',
      })
    ).id;
    target = (
      await store.users.upsertFromIdp({
        issuer: 'http://idp.test',
        subject: 't',
        email: 't@x',
      })
    ).id;
    group = (await store.groups.getOrCreate('devs', 'idp', 'idp')).id;
    account = (
      await store.accounts.create({
        service: 'github',
        owner: { kind: 'user', id: owner },
        displayName: 'gh',
        credential: null,
      })
    ).id;
  });
  afterEach(() => store.close());

  it('stores the restriction as one row per risk', async () => {
    const share = await store.shares.create({
      accountId: account,
      target: { kind: 'user', id: target },
      restriction: ['github.write-feature-branch', 'github.code-read', 'github.code-read'],
      createdByUserId: owner,
    });
    expect(share.restriction).toEqual(['github.code-read', 'github.write-feature-branch']);
    const rows = store.db
      .prepare<[string], { risk_id: string }>(
        'SELECT risk_id FROM share_restrictions WHERE share_id = ? ORDER BY risk_id',
      )
      .all(share.id);
    expect(rows).toHaveLength(2);
  });

  it('refuses a risk id that is not in the loaded catalog (no wildcard can be persisted)', async () => {
    for (const bad of [['*'], ['github.*'], ['github.unknown-risk'], ['github.code-read', '']]) {
      await expect(
        store.shares.create({
          accountId: account,
          target: { kind: 'user', id: target },
          restriction: bad,
          createdByUserId: owner,
        }),
      ).rejects.toThrow(UnknownRiskIdError);
    }
    expect(await store.shares.listForAccount(account)).toEqual([]);
  });

  it('the schema itself rejects a wildcard even if the catalog check were bypassed', () => {
    store.db
      .prepare(
        `INSERT INTO shares (id, account_id, target_kind, target_user_id, status, created_by_user_id, created_at)
         VALUES ('s1', ?, 'user', ?, 'active', ?, '2026-10-13T00:00:00.000Z')`,
      )
      .run(account, target, owner);
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
      accountId: account,
      target: { kind: 'group', id: group },
      restriction: [],
      createdByUserId: owner,
    });
    expect(share.restriction).toEqual([]);
    expect(share.target).toEqual({ kind: 'group', id: group });
  });

  it('lists active shares for a user and their groups, and revokes', async () => {
    const direct = await store.shares.create({
      accountId: account,
      target: { kind: 'user', id: target },
      restriction: ['github.code-read'],
      createdByUserId: owner,
    });
    const viaGroup = await store.shares.create({
      accountId: account,
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
    // Named with another account, the share is not there: nothing is written.
    await expect(
      store.shares.revoke({ accountId: 'another-account', shareId: direct.id }),
    ).rejects.toThrow(NotFoundError);
    expect(await store.shares.get({ accountId: 'another-account', shareId: direct.id })).toBeNull();
    const revoked = await store.shares.revoke({ accountId: account, shareId: direct.id });
    expect(revoked.status).toBe('revoked');
    expect(revoked.revokedAt).not.toBeNull();
    expect((await store.shares.listActiveForTargets(principals)).map((s) => s.id)).toEqual([
      viaGroup.id,
    ]);
    expect(await store.shares.listForAccount(account)).toHaveLength(2);
    await expect(store.shares.revoke({ accountId: account, shareId: direct.id })).rejects.toThrow(
      /already revoked/,
    );
    expect(await store.shares.get({ accountId: account, shareId: 'missing' })).toBeNull();
  });
});
