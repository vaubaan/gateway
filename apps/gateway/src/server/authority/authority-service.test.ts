import { PluginRegistry } from '@vaubaan/plugin-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RegistryCatalogIndex } from '../compose/registry';
import { fakePlugin } from '../compose/testing';
import { openMemoryStore, type Store } from '../store';
import { StubEncryptor } from '../store/testing';
import type { ConnectionRecord, UserRecord } from '../store/types';
import { OwnerAuthorityService, uncoveredRisks } from './authority-service';
import { explicitRiskIdsOf, fullCatalogRiskIds } from './catalog-authority';

/** The fake plugin's catalog as explicit ids: `acme.thing-write` is env-scoped. */
const ACME_FULL = [
  'acme.read-things',
  'acme[staging].thing-write',
  'acme[prod].thing-write',
  'acme.uncategorized-write',
];

describe('OwnerAuthorityService', () => {
  let store: Store;
  let registry: PluginRegistry;
  let authority: OwnerAuthorityService;
  let ada: UserRecord;
  let bob: UserRecord;

  beforeEach(async () => {
    registry = new PluginRegistry([fakePlugin()]);
    store = openMemoryStore({
      encryptor: new StubEncryptor(),
      catalog: new RegistryCatalogIndex(registry),
    });
    authority = new OwnerAuthorityService({
      registry,
      groups: store.groups,
      connections: store.connections,
    });
    ada = await store.users.upsertFromIdp({ subject: 'idp|ada', email: 'ada@example.com' });
    bob = await store.users.upsertFromIdp({ subject: 'idp|bob', email: 'bob@example.com' });
  });
  afterEach(async () => {
    await store.close();
  });

  function connect(owner: ConnectionRecord['owner'], provider = 'acme'): Promise<ConnectionRecord> {
    return store.connections.create({ provider, owner, displayName: 'Acme', credential: null });
  }

  it('gives the owner the full catalog as an explicit enumeration, with no share', async () => {
    const connection = await connect({ kind: 'user', id: ada.id });
    const held = await authority.authorityOf(ada, connection);
    expect(held).toEqual({
      connectionId: connection.id,
      provider: 'acme',
      basis: 'owner',
      riskIds: ACME_FULL,
    });
    expect(held.riskIds.every((id) => !/[*?]/.test(id))).toBe(true);
  });

  it('gives nobody else anything', async () => {
    const connection = await connect({ kind: 'user', id: ada.id });
    expect(await authority.authorityOf(bob, connection)).toMatchObject({
      basis: 'none',
      riskIds: [],
    });
  });

  it('treats every current member of an owner group as an owner, recomputed on each call', async () => {
    const group = await store.groups.getOrCreate('github-admins', 'local');
    await store.groups.addMember(group.id, bob.id);
    const connection = await connect({ kind: 'group', id: group.id });
    expect((await authority.authorityOf(bob, connection)).basis).toBe('owner');
    expect((await authority.authorityOf(ada, connection)).basis).toBe('none');

    await store.groups.removeMember(group.id, bob.id);
    await store.groups.addMember(group.id, ada.id);
    expect((await authority.authorityOf(bob, connection)).riskIds).toEqual([]);
    expect((await authority.authorityOf(ada, connection)).riskIds).toEqual(ACME_FULL);
  });

  it('holds nothing on a connection whose provider has no registered plugin', async () => {
    const connection = await connect({ kind: 'user', id: ada.id }, 'ghost');
    expect(await authority.authorityOf(ada, connection)).toMatchObject({
      basis: 'none',
      riskIds: [],
    });
  });

  it('lists the connections a user owns directly or through a group', async () => {
    const group = await store.groups.getOrCreate('platform', 'local');
    await store.groups.addMember(group.id, ada.id);
    const own = await connect({ kind: 'user', id: ada.id });
    const viaGroup = await connect({ kind: 'group', id: group.id });
    await connect({ kind: 'user', id: bob.id });
    const mine = await authority.connectionsOf(ada);
    expect(mine.map((c) => c.id).sort()).toEqual([own.id, viaGroup.id].sort());
  });
});

describe('explicit enumeration', () => {
  it('expands an env-scoped entry into one id per acceptable env', () => {
    const catalog = fakePlugin().catalog;
    expect(fullCatalogRiskIds(catalog)).toEqual(ACME_FULL);
    const write = catalog.risks.find((r) => r.id === 'acme.thing-write');
    if (!write) throw new Error('fixture risk missing');
    expect(explicitRiskIdsOf(write)).toEqual([
      'acme[staging].thing-write',
      'acme[prod].thing-write',
    ]);
  });

  it('names what an authority does not cover, in request order', () => {
    expect(
      uncoveredRisks({ riskIds: ['a.read', 'a[staging].write'] }, [
        'a[prod].write',
        'a.read',
        'a.admin',
      ]),
    ).toEqual(['a[prod].write', 'a.admin']);
    expect(uncoveredRisks({ riskIds: [] }, [])).toEqual([]);
  });
});
