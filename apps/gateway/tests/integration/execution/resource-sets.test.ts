/**
 * Resource sets through the execution door (risk model §4.7; ADR
 * resource-sets-partition-a-mission-connection): one account of a mission split in
 * two sets, each with its own policy and budget.
 *
 *   - a call naming a resource is judged, gated and counted by that resource's set;
 *   - a call naming no resource is judged against every set of the account: each
 *     touched risk must be accepted in each, the strictest gate applies, each set's
 *     budget is charged;
 *   - a call naming resources of two sets is judged against both, the same way;
 *   - what a call creates joins the set the call was judged against;
 *   - the audit names the sets each call was charged on, and the counters agree with it.
 *
 * The fixture provider `twin` has a `copy` tool that names two resources in one call,
 * which the shared `depot` fixture has not.
 */
import {
  createRegistry,
  definePlugin,
  jsonObjectsOf,
  type ProviderPlugin,
} from '@vaubaan/plugin-sdk';
import { apiKeyCredentialFixture } from '@vaubaan/plugin-sdk/testing';
import { parseSlice } from '@vaubaan/policy-engine';
import type { MissionPolicyEntry } from '@vaubaan/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { budgetMissionOf, countersAgreeWithAudit } from '../../../src/server/budget';
import { serializeSecret } from '../../../src/server/connections';
import type { MissionDraft } from '../../../src/server/missions';
import type { ConnectionRecord, MissionRecord } from '../../../src/server/store/types';
import {
  depotSecret,
  executionInstance,
  line,
  type ExecutionInstance,
  type IssuedMission,
} from '../../support/execution/testing';

const TWIN = 'twin';
const READ = `${TWIN}.read`;
const WRITE = `${TWIN}.write`;
const PROFILE = `${TWIN}.profile`;

const VECTOR = {
  reversibility: 'reversible',
  blast: 'single',
  data: 'data',
  cost: 'free',
  visibility: 'internal',
} as const;

/** Spaces `alpha`, `beta`, `gamma`; `copy` reads one and writes another; `fork` creates one. */
function twinPlugin(): ProviderPlugin {
  const tool = (name: string, description: string) => ({
    name: `${TWIN}__${name}`,
    description,
    inputSchema: {
      type: 'object' as const,
      properties: { space: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } },
    },
  });
  return definePlugin({
    id: TWIN,
    displayName: 'Twin',
    version: '0.0.1',
    description: 'Fixture provider of the resource sets tests.',
    tools: [
      tool('read', 'Read an item of a space.'),
      tool('copy', 'Copy an item from one space to another.'),
      tool('whoami', 'The account behind the connection.'),
      tool('fork', 'Fork a space into a new one.'),
    ],
    resourceCreatingTools: [`${TWIN}__fork`],
    dataModel: {
      provider: TWIN,
      planes: [
        {
          slug: 'space',
          entities: [
            {
              name: 'space',
              parent: null,
              cardinalities: ['one'],
              description: 'A space.',
              envScopable: true,
            },
            {
              name: 'item',
              parent: 'space',
              cardinalities: ['one', 'unbounded'],
              description: 'An item.',
            },
            {
              name: 'account',
              parent: null,
              cardinalities: ['one'],
              description: 'The account.',
            },
          ],
        },
      ],
    },
    catalog: {
      provider: TWIN,
      risks: [
        {
          id: READ,
          label: 'Read items',
          reason: 'Reads.',
          matches: `${TWIN}.space[**].item[**].R`,
          vector: VECTOR,
        },
        {
          id: WRITE,
          label: 'Write an item',
          reason: 'Reversible edit.',
          matches: `${TWIN}.space[**].item[**].W`,
          vector: { ...VECTOR },
        },
        {
          id: PROFILE,
          label: 'Read the account profile',
          reason: 'Account-level read.',
          matches: `${TWIN}.account.profile.R`,
          vector: VECTOR,
        },
        {
          id: `${TWIN}.uncategorized-write`,
          label: 'Uncategorized write',
          reason: 'Catch-all.',
          matches: `${TWIN}.**.W`,
          fallback: true,
          vector: { ...VECTOR, reversibility: 'costly', blast: 'env' },
        },
      ],
      macro_actions: [
        {
          id: 'read',
          label: 'Read',
          description: 'Read items and the profile.',
          entries: [
            { risk_id: READ, quota: 100, rate_limit: { max: 60, window_seconds: 60 } },
            { risk_id: PROFILE, quota: 100, rate_limit: { max: 60, window_seconds: 60 } },
          ],
        },
        {
          id: 'change',
          label: 'Change',
          description: 'Write items.',
          entries: [{ risk_id: WRITE, quota: 100, rate_limit: { max: 60, window_seconds: 60 } }],
        },
      ],
    },
    credential: apiKeyCredentialFixture([{ name: 'token', label: 'Token', secret: true }]),
    classify(name, args, resources) {
      const refs = new Set(resources.filter((r) => r.provider === TWIN).map((r) => r.ref));
      const known = (value: unknown): value is string =>
        typeof value === 'string' && refs.has(value);
      switch (name) {
        case `${TWIN}__whoami`:
          return { slices: [parseSlice(`${TWIN}.account.profile.R`)] };
        case `${TWIN}__read`:
          if (!known(args.space)) return { denied: 'unknown space' };
          return { slices: [parseSlice(`${TWIN}.space[${args.space}].item[*].R`)] };
        case `${TWIN}__copy`:
          if (!known(args.from) || !known(args.to)) return { denied: 'unknown space' };
          return {
            slices: [
              parseSlice(`${TWIN}.space[${args.from}].item[*].R`),
              parseSlice(`${TWIN}.space[${args.to}].item[*].W`),
            ],
          };
        case `${TWIN}__fork`:
          if (!known(args.space)) return { denied: 'unknown space' };
          return { slices: [parseSlice(`${TWIN}.space[${args.space}].item[*].W`)] };
        default:
          return { denied: `unknown tool ${name}` };
      }
    },
    async execute(_ctx, name, args) {
      if (name === `${TWIN}__fork`) {
        const ref = `${String(args.space)}-fork`;
        return { content: [{ type: 'text', text: JSON.stringify({ created: { ref } }) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ tool: name, args }) }] };
    },
    async discoverResources() {
      return [];
    },
    createdResources(name, _args, result) {
      if (name !== `${TWIN}__fork`) return [];
      return jsonObjectsOf(result).flatMap((answer) => {
        const created = answer.created as { ref?: unknown } | undefined;
        return typeof created?.ref === 'string'
          ? [{ provider: TWIN, ref: created.ref, displayName: created.ref }]
          : [];
      });
    },
  });
}

/** A line of a set: `line` of the depot rig, gated when asked. */
const ask = (riskId: string, quota = 100): MissionPolicyEntry =>
  line(riskId, quota, { gate: 'approval' });

describe('resource sets through the execution door', () => {
  let instance: ExecutionInstance;
  let twin: ConnectionRecord;
  const idOf = new Map<string, string>();

  beforeEach(async () => {
    instance = await executionInstance({
      deps: { buildRegistry: async () => createRegistry([twinPlugin()]) },
    });
    const { root, ada } = instance;
    twin = await root.store.connections.create({
      provider: TWIN,
      owner: { kind: 'user', id: ada.id },
      displayName: 'Twin main',
      credential: serializeSecret(depotSecret()),
    });
    const rows = await root.store.connections.syncDiscoveredResources(twin.id, [
      { ref: 'alpha', displayName: 'alpha' },
      { ref: 'beta', displayName: 'beta' },
      { ref: 'gamma', displayName: 'gamma' },
    ]);
    for (const row of rows) idOf.set(row.ref, row.id);
  });
  afterEach(() => instance.close());

  /** A mission on the twin account: set 1 holds alpha and gamma, set 2 beta. */
  async function issue(
    first: readonly MissionPolicyEntry[],
    second: readonly MissionPolicyEntry[],
  ): Promise<IssuedMission> {
    const draft: MissionDraft = {
      name: 'Two sets',
      connections: [
        {
          connection_id: twin.id,
          resource_sets: [
            {
              resources: { scope: 'selected', resource_refs: ['alpha', 'gamma'] },
              policy: [...first],
            },
            { resources: { scope: 'selected', resource_refs: ['beta'] }, policy: [...second] },
          ],
        },
      ],
      period: { kind: 'recurring', length_seconds: 86_400 },
      expires_at: null,
    };
    const result = await instance.root.missions.service.issue(instance.ada, draft);
    if (!result.ok) throw new Error(`issue refused: ${JSON.stringify(result)}`);
    return { mission: result.mission, token: result.token.secret, prefix: result.token.prefix };
  }

  const setsOf = (mission: MissionRecord): [string, string] => {
    const sets = mission.connections[0]?.resourceSets ?? [];
    return [sets[0]?.id ?? '', sets[1]?.id ?? ''];
  };

  /** What each line consumed this period, keyed `<position>:<risk>`. */
  async function consumed(issued: IssuedMission): Promise<Record<string, number>> {
    const record = await instance.root.store.missions.getById(issued.mission.id);
    if (!record) throw new Error('mission vanished');
    const [first, second] = setsOf(record);
    const usage = await instance.root.budget.usageOf(budgetMissionOf(record), new Date());
    const out: Record<string, number> = {};
    for (const [key, n] of usage.consumed) {
      const [set, risk] = key.split('::');
      out[`${set === first ? 1 : set === second ? 2 : '?'}:${risk}`] = n;
    }
    return out;
  }

  async function grantFrom(body: { error?: { data?: Record<string, unknown> } }) {
    const id = String(body.error?.data?.approval_url).split('/').at(-1) ?? '';
    const decided = await instance.root.requests.service.decide(instance.ada, id, {
      resolution: 'grant',
    });
    expect(decided).toMatchObject({ ok: true });
    return id;
  }

  it('a call naming a resource is judged and counted by its set alone', async () => {
    const issued = await issue([line(READ, 10)], [line(READ, 2)]);
    for (let i = 0; i < 3; i++) {
      expect((await instance.call(issued, 'twin__read', { space: 'alpha' })).error).toBeUndefined();
    }
    for (let i = 0; i < 2; i++) {
      expect((await instance.call(issued, 'twin__read', { space: 'beta' })).error).toBeUndefined();
    }
    const spent = await instance.call(issued, 'twin__read', { space: 'beta' });
    expect(spent.error?.data).toMatchObject({
      code: 'budget-exhausted',
      risk_id: READ,
      quota: 2,
      resource_set: 'resource set 2',
    });
    expect(String(spent.error?.data?.hint)).toContain(`'${READ}' in resource set 2`);
    // The other set keeps its own budget.
    expect((await instance.call(issued, 'twin__read', { space: 'gamma' })).error).toBeUndefined();
    expect(await consumed(issued)).toEqual({ [`1:${READ}`]: 4, [`2:${READ}`]: 2 });
  });

  it('a call naming no resource needs every set: refused where one set lacks the risk', async () => {
    const issued = await issue([line(READ), line(PROFILE)], [line(READ)]);
    const refused = await instance.call(issued, 'twin__whoami');
    expect(refused.error?.data).toMatchObject({
      code: 'risk-not-accepted',
      missing_risks: [PROFILE],
    });
    expect(String(refused.error?.data?.hint)).toContain(
      'This call cannot be placed in one resource set of this account, so it is judged against resource sets 1 and 2',
    );
    // What cannot be placed in one set never gets the wider set's rights.
    expect(await consumed(issued)).toEqual({});
  });

  it('a call naming no resource takes the strictest gate and is charged in every set', async () => {
    const issued = await issue([line(READ), line(PROFILE)], [line(READ), ask(PROFILE)]);
    const asked = await instance.call(issued, 'twin__whoami');
    expect(asked.error?.data).toMatchObject({ code: 'approval-required', risk_ids: [PROFILE] });
    const requestId = await grantFrom(asked);
    const request = await instance.root.store.requests.getById(requestId);
    const [first, second] = setsOf(issued.mission);
    // The request is about the gated line: the profile in set 2 only.
    expect(request?.lines).toEqual([{ resourceSetId: second, riskId: PROFILE }]);
    expect(first).not.toBe(second);

    expect((await instance.call(issued, 'twin__whoami')).error).toBeUndefined();
    expect(await consumed(issued)).toEqual({ [`1:${PROFILE}`]: 1, [`2:${PROFILE}`]: 1 });
  });

  it('a call naming resources of two sets must be allowed in both, and counts in both', async () => {
    const lacking = await issue([line(READ), line(WRITE)], [line(READ)]);
    const refused = await instance.call(lacking, 'twin__copy', { from: 'alpha', to: 'beta' });
    expect(refused.error?.data).toMatchObject({
      code: 'risk-not-accepted',
      missing_risks: [WRITE],
    });

    const issued = await issue([line(READ), line(WRITE)], [line(READ), ask(WRITE)]);
    const asked = await instance.call(issued, 'twin__copy', { from: 'alpha', to: 'beta' });
    expect(asked.error?.data).toMatchObject({ code: 'approval-required', risk_ids: [WRITE] });
    await grantFrom(asked);
    const done = await instance.call(issued, 'twin__copy', { from: 'alpha', to: 'beta' });
    expect(done.error).toBeUndefined();
    expect(await consumed(issued)).toEqual({
      [`1:${READ}`]: 1,
      [`1:${WRITE}`]: 1,
      [`2:${READ}`]: 1,
      [`2:${WRITE}`]: 1,
    });

    // The audit names both sets, and the counters agree with it per set.
    const [first, second] = setsOf(issued.mission);
    const entries = await instance.root.store.audit.list({ missionId: issued.mission.id });
    const allowed = entries.find((e) => e.kind === 'call' && e.decision === 'allowed');
    expect(allowed?.kind === 'call' && [...(allowed.resource_set_ids ?? [])].sort()).toEqual(
      [first, second].sort(),
    );
    const record = await instance.root.store.missions.getById(issued.mission.id);
    const report = await countersAgreeWithAudit(
      { sessions: instance.root.store.sessions, audit: instance.root.store.audit },
      budgetMissionOf(record!),
      new Date(),
    );
    expect(report.mismatches).toEqual([]);
  });

  it('what a call creates joins the set it was judged against', async () => {
    const issued = await issue([line(READ), line(WRITE)], [line(READ), line(WRITE)]);
    const forked = await instance.call(issued, 'twin__fork', { space: 'beta' });
    expect(forked.error).toBeUndefined();
    const record = await instance.root.store.missions.getById(issued.mission.id);
    const [, second] = record!.connections[0]!.resourceSets;
    const forkId = (await instance.root.store.connections.listResources(twin.id)).find(
      (r) => r.ref === 'beta-fork',
    )?.id;
    expect(forkId).toBeDefined();
    expect(second?.resourceIds).toContain(forkId);
    // Judged by set 2 from the next call on.
    expect(
      (await instance.call(issued, 'twin__read', { space: 'beta-fork' })).error,
    ).toBeUndefined();
    expect((await consumed(issued))[`2:${READ}`]).toBe(1);
  });

  it('the catalog names the set of each resource and budget line when an account has several', async () => {
    const issued = await issue([line(READ)], [line(READ, 5)]);
    const response = await instance.root.execution.handlers.catalog(
      new Request('https://gateway.example.com/mcp/catalog', {
        headers: { authorization: `Bearer ${issued.token}` },
      }),
    );
    const catalog = (await response.json()) as {
      connections: { resources: { ref: string; resource_set?: string }[] }[];
      budget: { risk_id: string; quota: number; resource_set?: string }[];
    };
    const twinResources = catalog.connections.flatMap((c) => c.resources);
    expect(twinResources.find((r) => r.ref === 'beta')?.resource_set).toBe('resource set 2');
    expect(twinResources.find((r) => r.ref === 'alpha')?.resource_set).toBe('resource set 1');
    expect(catalog.budget.map((b) => [b.risk_id, b.quota, b.resource_set])).toEqual([
      [READ, 100, 'resource set 1'],
      [READ, 5, 'resource set 2'],
    ]);
  });
});
