/**
 * A revoked account removes only its part of a mission (ADR
 * orphaned-missions-and-ownerless-connections, amendment 2026-10-21; spec §2.3,
 * §4.1, §7.8): the mission keeps serving through its other accounts, a call
 * through the revoked one is refused `account-revoked`, `tools/list` drops its
 * tools, the mission page and the management door say which account is gone, and
 * the audit names the owner who revoked. Nothing widens.
 *
 * Real composition root on the `:memory:` store, two services: the Depot fixture
 * and Acme (`fakePlugin`).
 */
import type { AdminAuditEntry } from '@vaubaan/gateway-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fakePlugin } from '../../support/compose/testing';
import { serializeSecret } from '../../../src/server/accounts';
import type { MissionCatalog } from '../../../src/server/execution';
import {
  executionInstance,
  line,
  TEST_PUBLIC_URL,
  type ExecutionInstance,
  type IssuedMission,
} from '../../support/execution/testing';
import { missionView } from '../../../src/server/vaubaan/views';
import type { AccountRecord, UserRecord } from '../../../src/server/store/types';

const DEPOT_READ = 'depot.read';
const ACME_READ = 'acme.read-things';

describe('a revoked account removes only its part of a mission', () => {
  let instance: ExecutionInstance;
  let acme: AccountRecord;
  let bob: UserRecord;

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
      // Labelled: Acme's catalog has env-qualified risks, so an unlabelled resource enters no set.
      { ref: 'main', displayName: 'main', env: 'prod' },
    ]);
    bob = await root.store.users.upsertFromIdp({
      issuer: 'http://idp.test',
      subject: 'idp|bob',
      email: 'bob@example.com',
      displayName: 'Bob',
    });
  });
  afterEach(async () => {
    await instance.close();
  });

  async function issueBoth(creator: UserRecord = instance.ada): Promise<IssuedMission> {
    const result = await instance.root.missions.service.issue(creator, {
      name: 'Everything I hold',
      accounts: [
        {
          account_id: instance.account.id,
          // The staging spaces: one environment, so one resource set.
          resources: { scope: 'selected', resource_refs: ['app-staging', 'scratch'] },
          policy: [line(DEPOT_READ)],
        },
        { account_id: acme.id, resources: { scope: 'all' }, policy: [line(ACME_READ)] },
      ],
      period: { kind: 'recurring', length_seconds: 86_400 },
      expires_at: null,
    });
    if (!result.ok) throw new Error(`issue refused: ${JSON.stringify(result)}`);
    return { mission: result.mission, token: result.token.secret, prefix: result.token.prefix };
  }

  const actorOf = async (user: UserRecord) => ({
    user,
    groups: await instance.root.store.groups.groupsOf(user.id),
  });

  async function toolNames(mission: IssuedMission): Promise<string[]> {
    const { body } = await instance.rpc(mission.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    return (body.result?.tools as { name: string }[]).map((t) => t.name);
  }

  async function adminEntries(act: AdminAuditEntry['act']): Promise<AdminAuditEntry[]> {
    const entries = await instance.root.store.audit.list({ kind: 'admin' });
    return entries.filter(
      (e): e is typeof e & AdminAuditEntry => e.kind === 'admin' && e.act === act,
    );
  }

  it('the other account keeps serving; the revoked one is refused account-revoked', async () => {
    const mission = await issueBoth();
    await instance.root.accounts.service.revoke(await actorOf(instance.ada), instance.account.id);

    const refused = await instance.call(mission, 'depot__read_item', { space: 'scratch' });
    expect(refused.error?.data).toMatchObject({
      code: 'account-revoked',
      cause: 'account-revoked',
      final: true,
      account: { id: instance.account.id, name: 'Depot main' },
    });
    expect(refused.error?.data?.hint).toMatch(/other accounts/);
    expect(instance.depot.calls).toHaveLength(0);

    const served = await instance.call(mission, 'acme__list_things', { space: 'main' });
    expect(served.error).toBeUndefined();

    // tools/list drops the revoked account's tools, keeps the others.
    const names = await toolNames(mission);
    expect(names).toContain('acme__list_things');
    expect(names.some((name) => name.startsWith('depot__'))).toBe(false);

    // The catalog says which account is lost.
    const response = await instance.root.execution.handlers.catalog(
      new Request(`${TEST_PUBLIC_URL}/mcp/catalog`, {
        headers: { authorization: `Bearer ${mission.token}` },
      }),
    );
    const catalog = (await response.json()) as MissionCatalog;
    expect(catalog.mission.state).toBe('active');
    expect(catalog.accounts.find((c) => c.id === instance.account.id)?.lost).toBe(
      'account-revoked',
    );
    expect(catalog.accounts.find((c) => c.id === acme.id)?.lost).toBeUndefined();
  });

  it('the mission page and the management door say which account is gone, for good', async () => {
    const mission = await issueBoth();
    await instance.root.accounts.service.revoke(await actorOf(instance.ada), instance.account.id);

    const detail = await instance.root.missions.service.get(instance.ada, mission.mission.id);
    expect(detail?.mission.status).toBe('active');
    expect(detail?.orphan).toBeNull();
    expect(detail?.lost).toEqual([
      { account_id: instance.account.id, cause: 'account-revoked', final: true },
    ]);
    expect(detail?.accounts.find((c) => c.id === instance.account.id)?.lost).toBe(
      'account-revoked',
    );
    // The kit handed to agents no longer names the lost account.
    expect(detail?.kit?.agent_instructions).toContain('Acme main');
    expect(detail?.kit?.agent_instructions).not.toContain('Depot main');

    const view = missionView(detail!, { missionId: 'calling-mission' }, (prefix) => prefix);
    expect(view.state).toBe('active');
    expect(view.lost_accounts).toEqual([
      { account_id: instance.account.id, cause: 'account-revoked', final: true },
    ]);
  });

  it('the audit names the owner who revoked and which mission lost which account', async () => {
    const mission = await issueBoth();
    await instance.root.accounts.service.revoke(await actorOf(instance.ada), instance.account.id);
    expect(await adminEntries('mission-orphaned')).toEqual([]);
    expect(await adminEntries('mission-account-lost')).toEqual([
      expect.objectContaining({
        user_id: instance.ada.id,
        object: { type: 'mission', id: mission.mission.id },
        after: expect.objectContaining({
          status: 'active',
          newly_lost: [{ account_id: instance.account.id, cause: 'account-revoked' }],
        }) as unknown,
      }),
    ]);
  });

  it('nothing widens on a lost account: no permission is added there', async () => {
    const mission = await issueBoth();
    await instance.root.accounts.service.revoke(await actorOf(instance.ada), instance.account.id);
    const detail = await instance.root.missions.service.get(instance.ada, mission.mission.id);
    const expected = detail!.policy.map(({ risk_id, quota, rate_limit, gate }) => ({
      risk_id,
      quota,
      rate_limit,
      gate,
    }));
    const changed = await instance.root.missions.service.changePermissions(
      instance.ada,
      mission.mission.id,
      { expected_policy: expected, policy: [...expected, line('depot.purge')] },
    );
    expect(changed).toMatchObject({ ok: false, reason: 'refused' });
    const options = await instance.root.missions.service.permissionOptions(
      instance.ada,
      mission.mission.id,
    );
    expect(options?.candidates.some((c) => c.risk_id.startsWith('depot'))).toBe(false);
  });

  it('a mission whose every account is revoked is orphaned, as before', async () => {
    const mission = await issueBoth();
    const ada = await actorOf(instance.ada);
    await instance.root.accounts.service.revoke(ada, instance.account.id);
    await instance.root.accounts.service.revoke(ada, acme.id);

    const refused = await instance.call(mission, 'acme__list_things', { space: 'main' });
    expect(refused.error?.data).toMatchObject({ code: 'mission-inactive', status: 'orphaned' });
    expect((await adminEntries('mission-orphaned')).map((e) => e.object.id)).toEqual([
      mission.mission.id,
    ]);
  });

  it('a share withdrawn on one account takes that part only, and gives it back when shared again', async () => {
    const owner = await actorOf(instance.ada);
    for (const [account, risk] of [
      [instance.account, DEPOT_READ],
      [acme, ACME_READ],
    ] as const) {
      await instance.root.shares.service.share(owner, account.id, {
        target: { kind: 'user', email: 'bob@example.com' },
        riskIds: [risk],
      });
    }
    const mission = await issueBoth(bob);
    const [depotShare] = await instance.root.store.shares.listForAccount(instance.account.id);
    const withdrawn = await instance.root.shares.service.revoke(
      owner,
      depotShare!.id,
      depotShare!.accountId,
    );
    expect(withdrawn).toMatchObject({ orphaned: 0, partsLost: 1 });

    const refused = await instance.call(mission, 'depot__read_item', { space: 'scratch' });
    expect(refused.error?.data).toMatchObject({
      code: 'account-revoked',
      cause: 'access-withdrawn',
      final: false,
    });
    expect(
      (await instance.call(mission, 'acme__list_things', { space: 'main' })).error,
    ).toBeUndefined();

    const again = await instance.root.shares.service.share(owner, instance.account.id, {
      target: { kind: 'user', email: 'bob@example.com' },
      riskIds: [DEPOT_READ],
    });
    expect(again.restored).toBe(1);
    expect(
      (await instance.call(mission, 'depot__read_item', { space: 'scratch' })).error,
    ).toBeUndefined();
    expect((await adminEntries('mission-account-restored')).map((e) => e.user_id)).toEqual([
      instance.ada.id,
    ]);
  });
});
