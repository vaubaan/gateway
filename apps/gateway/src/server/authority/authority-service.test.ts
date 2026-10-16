import { PluginRegistry } from '@vaubaan/plugin-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RegistryCatalogIndex } from '../compose/registry';
import { fakePlugin } from '../compose/testing';
import { openMemoryStore, type Store } from '../store';
import { StubEncryptor } from '../store/testing';
import type { ConnectionRecord, Principal, UserRecord } from '../store/types';
import { ConnectionAuthorityService } from './authority-service';
import { explicitRiskIdsOf, fullCatalogRiskIds, uncoveredRisks } from './catalog-authority';

/** The fake plugin's catalog as explicit ids: `acme.thing-write` is env-scoped. */
const ACME_FULL = [
  'acme.read-things',
  'acme[staging].thing-write',
  'acme[prod].thing-write',
  'acme.uncategorized-write',
];
const READ = 'acme.read-things';
const WRITE_STAGING = 'acme[staging].thing-write';
const WRITE_PROD = 'acme[prod].thing-write';

describe('ConnectionAuthorityService', () => {
  let store: Store;
  let registry: PluginRegistry;
  let authority: ConnectionAuthorityService;
  let ada: UserRecord;
  let bob: UserRecord;

  beforeEach(async () => {
    registry = new PluginRegistry([fakePlugin()]);
    store = openMemoryStore({
      encryptor: new StubEncryptor(),
      catalog: new RegistryCatalogIndex(registry),
    });
    authority = new ConnectionAuthorityService({
      registry,
      users: store.users,
      groups: store.groups,
      connections: store.connections,
      shares: store.shares,
    });
    ada = await store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'idp|ada',
      email: 'ada@example.com',
    });
    bob = await store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'idp|bob',
      email: 'bob@example.com',
    });
  });
  afterEach(async () => {
    await store.close();
  });

  function connect(owner: ConnectionRecord['owner'], provider = 'acme'): Promise<ConnectionRecord> {
    return store.connections.create({ provider, owner, displayName: 'Acme', credential: null });
  }

  function share(connection: ConnectionRecord, target: Principal, restriction: string[]) {
    return store.shares.create({
      connectionId: connection.id,
      target,
      restriction,
      createdByUserId: ada.id,
    });
  }

  describe('owner', () => {
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

    it('holds nothing once the user was removed from the IdP, even on their own connection', async () => {
      const connection = await connect({ kind: 'user', id: ada.id });
      await store.users.markRemoved(ada.id);
      expect(await authority.authorityOf(ada, connection)).toMatchObject({ basis: 'none' });
      expect(await authority.connectionsOf(ada)).toEqual([]);
      expect(await authority.authorityOf({ id: 'nobody' }, connection)).toMatchObject({
        basis: 'none',
      });
    });
  });

  describe('shares', () => {
    it('gives the beneficiary exactly the restriction, in catalog order', async () => {
      const connection = await connect({ kind: 'user', id: ada.id });
      await share(connection, { kind: 'user', id: bob.id }, [WRITE_STAGING, READ]);
      expect(await authority.authorityOf(bob, connection)).toEqual({
        connectionId: connection.id,
        provider: 'acme',
        basis: 'share',
        riskIds: [READ, WRITE_STAGING],
      });
    });

    it('unions a direct share and the shares made to the groups of the user', async () => {
      const connection = await connect({ kind: 'user', id: ada.id });
      const team = await store.groups.getOrCreate('team', 'local');
      const other = await store.groups.getOrCreate('other', 'local');
      await store.groups.addMember(team.id, bob.id);
      await share(connection, { kind: 'user', id: bob.id }, [READ]);
      await share(connection, { kind: 'group', id: team.id }, [WRITE_STAGING]);
      // A group bob is not in adds nothing.
      await share(connection, { kind: 'group', id: other.id }, [WRITE_PROD]);

      const held = await authority.authorityOf(bob, connection);
      expect(held.basis).toBe('share');
      expect(held.riskIds).toEqual([READ, WRITE_STAGING]);
    });

    it('keeps the shares of each connection apart', async () => {
      const first = await connect({ kind: 'user', id: ada.id });
      const second = await connect({ kind: 'user', id: ada.id });
      await share(first, { kind: 'user', id: bob.id }, [READ]);
      await share(second, { kind: 'user', id: bob.id }, [WRITE_PROD]);
      expect((await authority.authorityOf(bob, first)).riskIds).toEqual([READ]);
      expect((await authority.authorityOf(bob, second)).riskIds).toEqual([WRITE_PROD]);
    });

    it('drops a revoked share from the next answer', async () => {
      const connection = await connect({ kind: 'user', id: ada.id });
      const direct = await share(connection, { kind: 'user', id: bob.id }, [READ, WRITE_PROD]);
      expect((await authority.authorityOf(bob, connection)).riskIds).toEqual([READ, WRITE_PROD]);
      await store.shares.revoke(direct.id);
      expect(await authority.authorityOf(bob, connection)).toMatchObject({
        basis: 'none',
        riskIds: [],
      });
    });

    it('is recomputed from the current membership, never from a snapshot', async () => {
      const connection = await connect({ kind: 'user', id: ada.id });
      const team = await store.groups.getOrCreate('team', 'local');
      await share(connection, { kind: 'group', id: team.id }, [READ]);
      // The same service instance, asked three times around two membership changes.
      expect((await authority.authorityOf(bob, connection)).riskIds).toEqual([]);
      await store.groups.addMember(team.id, bob.id);
      expect((await authority.authorityOf(bob, connection)).riskIds).toEqual([READ]);
      await store.groups.removeMember(team.id, bob.id);
      expect((await authority.authorityOf(bob, connection)).riskIds).toEqual([]);
    });

    it('lets the owner keep the full catalog whatever is shared', async () => {
      const connection = await connect({ kind: 'user', id: ada.id });
      await share(connection, { kind: 'user', id: bob.id }, [READ]);
      expect((await authority.authorityOf(ada, connection)).riskIds).toEqual(ACME_FULL);
    });

    it('lists the connections a user owns or received, once each', async () => {
      const group = await store.groups.getOrCreate('platform', 'local');
      await store.groups.addMember(group.id, ada.id);
      const own = await connect({ kind: 'user', id: ada.id });
      const viaGroup = await connect({ kind: 'group', id: group.id });
      const shared = await connect({ kind: 'user', id: bob.id });
      const notMine = await connect({ kind: 'user', id: bob.id });
      await store.shares.create({
        connectionId: shared.id,
        target: { kind: 'user', id: ada.id },
        restriction: [READ],
        createdByUserId: bob.id,
      });
      await store.shares.create({
        connectionId: shared.id,
        target: { kind: 'group', id: group.id },
        restriction: [WRITE_PROD],
        createdByUserId: bob.id,
      });
      const mine = await authority.connectionsOf(ada);
      expect(mine.map((c) => c.id).sort()).toEqual([own.id, viaGroup.id, shared.id].sort());
      expect(mine.map((c) => c.id)).not.toContain(notMine.id);
    });
  });

  describe('gapsOf — the re-check of an authority already granted', () => {
    it('finds no gap for the owner and reads neither groups nor shares for a user-owned connection', async () => {
      const connection = await connect({ kind: 'user', id: ada.id });
      const reads: string[] = [];
      const counting = new ConnectionAuthorityService({
        registry,
        users: store.users,
        connections: store.connections,
        groups: {
          groupsOf: (id) => {
            reads.push('groups');
            return store.groups.groupsOf(id);
          },
        },
        shares: {
          listActiveForTargets: (principals, connectionId) => {
            reads.push('shares');
            return store.shares.listActiveForTargets(principals, connectionId);
          },
        },
      });
      expect(await counting.gapsOf(ada, [{ connection, riskIds: [READ, WRITE_PROD] }])).toEqual({
        subjectRemoved: false,
        gaps: [],
      });
      expect(reads).toEqual([]);
    });

    it('reads the groups once for several group-owned connections', async () => {
      const group = await store.groups.getOrCreate('platform', 'local');
      await store.groups.addMember(group.id, ada.id);
      const first = await connect({ kind: 'group', id: group.id });
      const second = await connect({ kind: 'group', id: group.id });
      let groupReads = 0;
      const counting = new ConnectionAuthorityService({
        registry,
        users: store.users,
        connections: store.connections,
        shares: store.shares,
        groups: {
          groupsOf: (id) => {
            groupReads += 1;
            return store.groups.groupsOf(id);
          },
        },
      });
      const { gaps } = await counting.gapsOf(ada, [
        { connection: first, riskIds: [READ] },
        { connection: second, riskIds: [READ] },
      ]);
      expect(gaps).toEqual([]);
      expect(groupReads).toBe(1);
    });

    it('names, per connection, what a share does not cover', async () => {
      const covered = await connect({ kind: 'user', id: ada.id });
      const partial = await connect({ kind: 'user', id: ada.id });
      const unshared = await connect({ kind: 'user', id: ada.id });
      await share(covered, { kind: 'user', id: bob.id }, [READ, WRITE_STAGING]);
      await share(partial, { kind: 'user', id: bob.id }, [READ]);
      expect(
        await authority.gapsOf(bob, [
          { connection: covered, riskIds: [WRITE_STAGING, READ] },
          { connection: partial, riskIds: [WRITE_PROD, READ, WRITE_STAGING] },
          { connection: unshared, riskIds: [READ] },
        ]),
      ).toEqual({
        subjectRemoved: false,
        gaps: [
          { connectionId: partial.id, basis: 'share', uncovered: [WRITE_PROD, WRITE_STAGING] },
          { connectionId: unshared.id, basis: 'none', uncovered: [READ] },
        ],
      });
    });

    it('asks nothing of a connection on which nothing was accepted', async () => {
      const connection = await connect({ kind: 'user', id: ada.id });
      expect((await authority.gapsOf(bob, [{ connection, riskIds: [] }])).gaps).toEqual([]);
    });

    it('reports a removed user as holding nothing anywhere', async () => {
      const connection = await connect({ kind: 'user', id: ada.id });
      await store.users.markRemoved(ada.id);
      expect(await authority.gapsOf(ada, [{ connection, riskIds: [READ] }])).toEqual({
        subjectRemoved: true,
        gaps: [{ connectionId: connection.id, basis: 'none', uncovered: [READ] }],
      });
    });

    it('observes a membership change on the very next check', async () => {
      const group = await store.groups.getOrCreate('platform', 'local');
      await store.groups.addMember(group.id, bob.id);
      const connection = await connect({ kind: 'group', id: group.id });
      const question = [{ connection, riskIds: [READ] }];
      expect((await authority.gapsOf(bob, question)).gaps).toEqual([]);
      await store.groups.removeMember(group.id, bob.id);
      expect((await authority.gapsOf(bob, question)).gaps).toHaveLength(1);
      await store.groups.addMember(group.id, bob.id);
      expect((await authority.gapsOf(bob, question)).gaps).toEqual([]);
    });
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
