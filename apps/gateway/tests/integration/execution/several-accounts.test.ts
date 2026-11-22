/**
 * A mission with several accounts of one service (spec §3.1, risk model §4.7
 * "The account of a call"; ADR one-place-to-authorize-services-token-first,
 * amendment 2026-11-22): issued as any other, `tools/list` shows the service
 * once, a call runs with the account holding the resource it names — its key,
 * its resources, its audit line — or with the one `vaubaan_account` names, and
 * a call naming neither is `account-ambiguous`, with nothing reaching the plugin.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { serializeSecret } from '../../../src/server/accounts';
import type { AccountRecord } from '../../../src/server/store/types';
import {
  DEPOT,
  depotSecret,
  executionInstance,
  line,
  type ExecutionInstance,
  type IssuedMission,
} from '../../support/execution/testing';

const SECOND_KEY = 'sk-depot-second-account';

describe('a mission with two accounts of one service', () => {
  let instance: ExecutionInstance;
  let second: AccountRecord;
  let issued: IssuedMission;

  beforeEach(async () => {
    instance = await executionInstance({ spaces: [{ ref: 'alpha', env: 'staging' }] });
    second = await instance.root.store.accounts.create({
      service: DEPOT,
      owner: { kind: 'user', id: instance.ada.id },
      displayName: 'Depot second',
      credential: serializeSecret(depotSecret(SECOND_KEY)),
    });
    await instance.root.store.accounts.syncDiscoveredResources(second.id, [
      { ref: 'beta', displayName: 'beta', env: 'staging' },
    ]);
    const result = await instance.root.missions.service.issue(instance.ada, {
      name: 'Two depots',
      accounts: [
        {
          account_id: instance.account.id,
          resources: { scope: 'all' },
          policy: [line('depot.read')],
        },
        { account_id: second.id, resources: { scope: 'all' }, policy: [line('depot.read')] },
      ],
      period: { kind: 'recurring', length_seconds: 86_400 },
      expires_at: null,
    });
    if (!result.ok) throw new Error(`issue refused: ${JSON.stringify(result)}`);
    issued = { mission: result.mission, token: result.token.secret, prefix: result.token.prefix };
  });

  afterEach(async () => {
    await instance.close();
  });

  it('is issued, and tools/list shows the service tools once', async () => {
    const { body } = await instance.rpc(issued.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    const names = ((body.result?.tools ?? []) as { name: string }[]).map((t) => t.name);
    expect(names).toContain('depot__read_item');
    expect(new Set(names).size).toBe(names.length);
    const tools = (body.result?.tools ?? []) as {
      name: string;
      inputSchema: { properties?: Record<string, unknown> };
    }[];
    const read = tools.find((t) => t.name === 'depot__read_item');
    expect(read?.inputSchema.properties).toHaveProperty('vaubaan_account');
  });

  it('runs a call naming no resource on the account vaubaan_account names, never passing it on', async () => {
    const body = await instance.call(issued, 'depot__read_item', {
      vaubaan_account: 'Depot second',
    });
    expect(body.error).toBeUndefined();
    const [run] = instance.depot.calls;
    expect(run?.ctx.credential).toEqual(depotSecret(SECOND_KEY));
    expect(run?.args).not.toHaveProperty('vaubaan_account');
  });

  it('runs each call with the account holding the resource it names', async () => {
    const first = await instance.call(issued, 'depot__read_item', { space: 'alpha' });
    const other = await instance.call(issued, 'depot__read_item', { space: 'beta' });
    expect(first.error).toBeUndefined();
    expect(other.error).toBeUndefined();

    const [onFirst, onSecond] = instance.depot.calls;
    expect(onFirst?.ctx.credential).toEqual(depotSecret());
    expect(onFirst?.ctx.resources.map((r) => r.ref)).toEqual(['alpha']);
    expect(onSecond?.ctx.credential).toEqual(depotSecret(SECOND_KEY));
    expect(onSecond?.ctx.resources.map((r) => r.ref)).toEqual(['beta']);

    const entries = await instance.root.store.audit.list({ missionId: issued.mission.id });
    const accounts = entries
      .filter((e) => e.kind === 'call' && e.decision === 'allowed')
      .map((e) => (e.kind === 'call' ? e.account_id : null));
    expect(accounts.sort()).toEqual([instance.account.id, second.id].sort());
  });

  it('refuses account-ambiguous a call that names no resource, and runs nothing', async () => {
    const body = await instance.call(issued, 'depot__read_item');
    expect(body.error?.data).toMatchObject({
      code: 'account-ambiguous',
      service: DEPOT,
      accounts: [
        { id: instance.account.id, name: 'Depot main', resources: [{ ref: 'alpha' }] },
        { id: second.id, name: 'Depot second', resources: [{ ref: 'beta' }] },
      ],
    });
    expect(instance.depot.calls).toHaveLength(0);
  });
});
