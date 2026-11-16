/**
 * A lost account stays on its mission until the creator removes it (ADR
 * orphaned-missions-and-ownerless-connections, amendment 2026-11-16; handbook missions):
 * nothing removes or hides it on its own, "Remove from mission" is an ordinary edit that
 * leaves a version, and a restore never brings a lost account back nor takes one out.
 *
 * Real composition root on the `:memory:` store, two services: the Depot fixture and
 * Acme (`fakePlugin`). Depot is the account lost: its owner disconnects it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fakePlugin } from '../../support/compose/testing';
import { serializeSecret } from '../../../src/server/accounts';
import {
  executionInstance,
  line,
  type ExecutionInstance,
  type IssuedMission,
} from '../../support/execution/testing';
import type { AccountRecord } from '../../../src/server/store/types';

const DEPOT_READ = 'depot.read';
const ACME_READ = 'acme.read-things';

describe('a lost account on its mission', () => {
  let instance: ExecutionInstance;
  let acme: AccountRecord;
  let mission: IssuedMission;

  beforeEach(async () => {
    instance = await executionInstance({ plugins: [fakePlugin()] });
    const { root, ada } = instance;
    acme = await root.store.accounts.create({
      service: 'acme',
      owner: { kind: 'user', id: ada.id },
      displayName: 'Acme main',
      credential: serializeSecret({ kind: 'api-key', fields: { api_key: 'k' }, metadata: {} }),
    });
    await root.store.accounts.syncDiscoveredResources(acme.id, [
      { ref: 'main', displayName: 'main', env: 'prod' },
    ]);
    const issued = await root.missions.service.issue(ada, {
      name: 'Two accounts',
      accounts: [
        {
          account_id: instance.account.id,
          resources: { scope: 'selected', resource_refs: ['app-staging', 'scratch'] },
          policy: [line(DEPOT_READ)],
        },
        { account_id: acme.id, resources: { scope: 'all' }, policy: [line(ACME_READ, 5)] },
      ],
      period: { kind: 'recurring', length_seconds: 86_400 },
      expires_at: null,
    });
    if (!issued.ok) throw new Error(`issue refused: ${JSON.stringify(issued)}`);
    mission = { mission: issued.mission, token: issued.token.secret, prefix: issued.token.prefix };
  });
  afterEach(async () => {
    await instance.close();
  });

  const service = () => instance.root.missions.service;
  const disconnectDepot = async () => {
    const { ada, root } = instance;
    await root.accounts.service.revoke(
      { user: ada, groups: await root.store.groups.groupsOf(ada.id) },
      instance.account.id,
    );
  };
  const accountIds = async () =>
    (await instance.root.store.missions.getById(mission.mission.id))?.accounts.map(
      (c) => c.accountId,
    );
  const view = async () => {
    const found = await service().editView(instance.ada, mission.mission.id);
    if (!found) throw new Error('no edit view');
    return found;
  };
  /** "Remove from mission" then "Save changes": the draft without the lost account. */
  const removeLost = async () => {
    const current = await view();
    return service().edit(instance.ada, mission.mission.id, {
      draft: {
        ...current.draft,
        accounts: current.draft.accounts.filter((c) => c.account_id !== instance.account.id),
      },
      revision: current.revision,
    });
  };

  it('stays on the mission, lost, and the edit view still carries it', async () => {
    await disconnectDepot();
    const detail = await service().get(instance.ada, mission.mission.id);
    expect(detail?.lost).toEqual([
      expect.objectContaining({ account_id: instance.account.id, cause: 'account-revoked' }),
    ]);
    const current = await view();
    expect(current.blocked).toBeNull();
    expect(current.snapshot.accounts.map((c) => c.account_id)).toContain(instance.account.id);
    expect(await accountIds()).toEqual([instance.account.id, acme.id]);
  });

  it('"Remove from mission" is an edit: the account leaves, one version records it, the rest is untouched', async () => {
    await disconnectDepot();
    const before = await instance.root.store.missionVersions.list(mission.mission.id);

    const removed = await removeLost();
    expect(removed).toMatchObject({ ok: true });
    if (!removed.ok) throw new Error('refused');
    expect(removed.changes.accounts_removed.map((c) => c.account_id)).toEqual([
      instance.account.id,
    ]);
    expect(await accountIds()).toEqual([acme.id]);

    const versions = await instance.root.store.missionVersions.list(mission.mission.id);
    expect(versions).toHaveLength(before.length + 1);
    expect(versions[0]).toMatchObject({
      cause: 'edit',
      author: { kind: 'person', userId: instance.ada.id },
    });
    expect(versions[0]?.config.accounts.map((c) => c.account_id)).toEqual([acme.id]);

    const detail = await service().get(instance.ada, mission.mission.id);
    expect(detail?.lost).toEqual([]);
    expect(detail?.state.kind).toBe('active');
    // The other account serves as before, with the same key.
    const served = await instance.call(mission, 'acme__list_things', { space: 'main' });
    expect(served.error).toBeUndefined();
  });

  it('is the creator’s act alone', async () => {
    await disconnectDepot();
    const bob = await instance.root.store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'idp|bob',
      email: 'bob@example.com',
    });
    const current = await view();
    expect(
      await service().edit(bob, mission.mission.id, {
        draft: current.draft,
        revision: current.revision,
      }),
    ).toEqual({ ok: false, reason: 'not-found' });
    expect(await accountIds()).toEqual([instance.account.id, acme.id]);
  });

  it('restoring a version that held the removed account does not bring it back', async () => {
    await disconnectDepot();
    await removeLost();

    const restored = await service().restore(instance.ada, mission.mission.id, 1);
    expect(restored).toMatchObject({ ok: true });
    if (!restored.ok) throw new Error('refused');
    expect(restored.dropped).toEqual([
      'Depot main is left out: you no longer hold it, or it was revoked.',
    ]);
    expect(await accountIds()).toEqual([acme.id]);
    const refused = await instance.call(mission, 'depot__read_item', { space: 'scratch' });
    expect(refused.error).toBeDefined();
    expect(instance.depot.calls).toHaveLength(0);
  });

  it('restoring a version neither removes a lost account still on the mission nor changes it', async () => {
    // v2: Acme's limit raised.
    const current = await view();
    const edited = await service().edit(instance.ada, mission.mission.id, {
      draft: {
        ...current.draft,
        accounts: current.draft.accounts.map((c) =>
          c.account_id === acme.id ? { ...c, policy: [line(ACME_READ, 9)] } : c,
        ),
      },
      revision: current.revision,
    });
    expect(edited).toMatchObject({ ok: true });
    await disconnectDepot();
    const lostBefore = (await view()).snapshot.accounts.find(
      (c) => c.account_id === instance.account.id,
    );

    const restored = await service().restore(instance.ada, mission.mission.id, 1);
    expect(restored).toMatchObject({ ok: true, dropped: [] });

    expect(await accountIds()).toEqual([instance.account.id, acme.id]);
    const after = await view();
    expect(after.snapshot.accounts.find((c) => c.account_id === instance.account.id)).toEqual(
      lostBefore,
    );
    expect(
      after.snapshot.accounts
        .find((c) => c.account_id === acme.id)
        ?.resource_sets[0]?.policy.map((p) => p.quota),
    ).toEqual([5]);
    const detail = await service().get(instance.ada, mission.mission.id);
    expect(detail?.lost.map((p) => p.account_id)).toEqual([instance.account.id]);
  });
});
