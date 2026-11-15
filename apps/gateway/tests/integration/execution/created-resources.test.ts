/**
 * What a mission creates, it reaches (ADR created-resources-join-the-mission),
 * through the execution door: the real composition root on the `:memory:`
 * store, the `depot` fixture plugin whose `depot__create_space` is declared in
 * `resourceCreatingTools` and read by `createdResources` (a scripted answer
 * `{ "created": { "ref", "name" } }`), missions issued through the mission
 * service.
 *
 * Spec §3.1 "Resource selection" (what a mission creates, it reaches), §8 (audit).
 */
import type { AdminAuditEntry } from '@vaubaan/gateway-core';
import type { Resource } from '@vaubaan/plugin-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SPACES,
  DEPOT,
  executionInstance,
  line,
  type ExecutionInstance,
  type IssuedMission,
} from '../../support/execution/testing';

/** `depot__create_space` has no risk of its own: the fallback write covers it. */
const CREATE = 'depot.uncategorized-write';
const READ = 'depot.read';

const space = (ref: string): Resource => ({ service: DEPOT, ref, displayName: ref });
const SEEDED: readonly Resource[] = DEFAULT_SPACES.map((s) => ({
  ...space(s.ref),
  ...(s.env ? { env: s.env } : {}),
}));

describe('execution door: a resource the mission creates joins the mission', () => {
  let instance: ExecutionInstance;

  beforeEach(async () => {
    instance = await executionInstance();
  });
  afterEach(async () => {
    await instance.close();
  });

  const idle = (): Promise<void> => instance.root.accounts.discoveryAfterCall.idle();

  /** The service answers the creation with the new space, as Miro answers a board. */
  function createsSpace(ref: string, name = `Space ${ref}`): void {
    instance.depot.script(async () => ({
      content: [{ type: 'text', text: JSON.stringify({ created: { ref, name } }) }],
    }));
  }

  async function addedEntries(): Promise<AdminAuditEntry[]> {
    const records = await instance.root.store.audit.list({ kind: 'admin' });
    return (records as unknown as AdminAuditEntry[]).filter(
      (e) => e.act === 'mission-resources-added',
    );
  }

  async function rowOf(ref: string) {
    const rows = await instance.root.store.accounts.listResources(instance.account.id);
    return rows.find((r) => r.ref === ref);
  }

  async function selectionOf(mission: IssuedMission) {
    const stored = await instance.root.store.missions.getById(mission.mission.id);
    // One set on the account: its selection.
    return stored?.accounts[0]?.resourceSets[0];
  }

  it('an explicit selection reaches the space it created on its very next call', async () => {
    const mission = await instance.issue({
      policy: [line(CREATE), line(READ)],
      spaces: ['scratch'],
    });
    // The service lists the new space late: discovery does not return it yet.
    instance.depot.scriptDiscovery(async () => [...SEEDED]);
    createsSpace('fresh');

    const created = await instance.call(mission, 'depot__create_space', { space: 'fresh' });
    expect(created.error).toBeUndefined();

    // Recorded before the answer left: the row, the selection, the audit entry.
    const row = await rowOf('fresh');
    expect(row).toMatchObject({ displayName: 'Space fresh', staleSince: null });
    const selection = await selectionOf(mission);
    expect(selection).toMatchObject({ future: false, env: 'staging' });
    expect(selection?.resourceIds).toContain(row?.id);
    expect(selection?.resourceSources).toEqual({ [row!.id]: 'created' });

    // Answered by the plugin, not refused by the classifier nor by the resource stage.
    instance.depot.script(async (_ctx, tool, args) => ({
      content: [{ type: 'text', text: JSON.stringify({ tool, args }) }],
    }));
    const read = await instance.call(mission, 'depot__read_item', { space: 'fresh' });
    expect(read.error).toBeUndefined();
    expect(
      instance.depot.calls
        .at(-1)
        ?.ctx.resources.map((r) => r.ref)
        .sort(),
    ).toEqual(['fresh', 'scratch']);

    const [entry, ...more] = await addedEntries();
    expect(more).toHaveLength(0);
    expect(entry).toMatchObject({
      user_id: instance.ada.id,
      object: { type: 'mission', id: mission.mission.id },
      before: null,
      after: {
        cause: 'created-by-the-mission',
        account_id: instance.account.id,
        tool: 'depot__create_space',
        refs: ['fresh'],
        resource_set_ids: [selection?.id],
        added_to_selection: ['fresh'],
      },
    });
    expect(JSON.stringify(entry)).not.toContain('"args"');
  });

  it('the discovery that does not list it yet does not mark it stale, and looks again', async () => {
    const mission = await instance.issue({
      policy: [line(CREATE), line(READ)],
      spaces: ['scratch'],
    });
    instance.depot.scriptDiscovery(async () => [...SEEDED]);
    createsSpace('fresh');

    await instance.call(mission, 'depot__create_space', { space: 'fresh' });
    // The first attempt ran and missed the space; the retry waits (2 s): stop it there.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(instance.depot.discoveries()).toBe(1);
    await instance.root.accounts.discoveryAfterCall.stop();

    expect((await rowOf('fresh'))?.staleSince).toBeNull();
    const read = await instance.call(mission, 'depot__read_item', { space: 'fresh' });
    expect(read.error).toBeUndefined();
  });

  it('a discovery that returns it ends the retries: one attempt, the row kept as discovery describes it', async () => {
    const mission = await instance.issue({ policy: [line(CREATE)], spaces: ['scratch'] });
    instance.depot.scriptDiscovery(async () => [
      ...SEEDED,
      { ...space('fresh'), displayName: 'Fresh (listed)' },
    ]);
    createsSpace('fresh');

    await instance.call(mission, 'depot__create_space', { space: 'fresh' });
    await idle();

    expect(instance.depot.discoveries()).toBe(1);
    expect(await rowOf('fresh')).toMatchObject({
      displayName: 'Fresh (listed)',
      staleSince: null,
    });
    const discovered = (await instance.root.store.audit.list({
      kind: 'admin',
    })) as unknown as AdminAuditEntry[];
    expect(discovered.find((e) => e.act === 'resources-discovered')?.after).toMatchObject({
      cause: 'after-a-call',
      attempts: 1,
    });
  });

  it('an `all` selection that knew nothing becomes the list of what it created', async () => {
    const empty = await executionInstance({ spaces: [] });
    try {
      const mission = await empty.issue({ policy: [line(CREATE), line(READ)] });
      expect(mission.mission.accounts[0]?.resourceSets[0]).toMatchObject({
        resourceIds: [],
      });
      empty.depot.script(async () => ({
        content: [{ type: 'text', text: JSON.stringify({ created: { ref: 'first' } }) }],
      }));

      await empty.call(mission, 'depot__create_space', { space: 'first' });
      const stored = await empty.root.store.missions.getById(mission.mission.id);
      expect(stored?.accounts[0]?.resourceSets[0]?.resourceIds).toHaveLength(1);

      empty.depot.script(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
      const read = await empty.call(mission, 'depot__read_item', { space: 'first' });
      expect(read.error).toBeUndefined();
    } finally {
      await empty.close();
    }
  });

  it('a mission with future resources gets it in its list like any other, and the other missions’ future sets too', async () => {
    const other = await instance.issue({
      policy: [line(READ)],
      wholeAccount: true,
      name: 'Another mission, future resources',
    });
    await instance.root.store.accounts.setDefaultEnv(instance.account.id, 'staging');
    const mission = await instance.issue({
      policy: [line(CREATE), line(READ)],
      wholeAccount: true,
    });
    instance.depot.scriptDiscovery(async () => [...SEEDED]);
    createsSpace('fresh');

    await instance.call(mission, 'depot__create_space', { space: 'fresh' });
    const fresh = await rowOf('fresh');
    // The creating mission: in the set the call was judged against (staging, future on).
    const sets = (await instance.root.store.missions.getById(mission.mission.id))!.accounts[0]!
      .resourceSets;
    const holding = sets.find((set) => set.resourceIds.includes(fresh!.id));
    expect(holding).toMatchObject({ future: true, env: 'staging' });
    expect(holding?.resourceSources).toEqual({ [fresh!.id]: 'created' });
    expect((await addedEntries())[0]?.after).toMatchObject({
      added_to_selection: ['fresh'],
      refs: ['fresh'],
    });
    // The other mission's staging set with future on takes it, audited on that mission.
    const otherSets = (await instance.root.store.missions.getById(other.mission.id))!.accounts[0]!
      .resourceSets;
    const joinedOther = otherSets.find((set) => set.resourceIds.includes(fresh!.id));
    expect(joinedOther).toMatchObject({ future: true, env: 'staging' });
    expect(joinedOther?.resourceSources).toEqual({ [fresh!.id]: 'future' });
    const joins = (await instance.root.store.audit.list({ kind: 'admin' })).filter(
      (e) => e.kind === 'admin' && e.act === 'mission-resource-joined',
    );
    expect(joins.map((e) => e.kind === 'admin' && [e.object.id, e.after])).toEqual([
      [
        other.mission.id,
        {
          account_id: instance.account.id,
          resource_set_id: joinedOther?.id,
          refs: ['fresh'],
          reason: 'discovered',
        },
      ],
    ]);
    const read = await instance.call(mission, 'depot__read_item', { space: 'fresh' });
    expect(read.error).toBeUndefined();
  });

  it('a new row inherits the default environment; a known one keeps its owner edits', async () => {
    const { accounts } = instance.root.store;
    await accounts.setDefaultEnv(instance.account.id, 'staging');
    const scratch = instance.resources.find((r) => r.ref === 'scratch')!;
    await accounts.setResourceDisplayName(scratch.id, 'My scratch');
    await accounts.setResourceEnv(scratch.id, 'prod');
    const mission = await instance.issue({
      policy: [line(CREATE)],
      spaces: ['app-staging'],
    });
    instance.depot.scriptDiscovery(async () => [...SEEDED]);

    createsSpace('fresh');
    await instance.call(mission, 'depot__create_space', { space: 'fresh' });
    expect(await rowOf('fresh')).toMatchObject({ env: 'staging', envSource: 'account-default' });

    // The plugin answers a space the account already lists: owner edits stay.
    createsSpace('scratch', 'Scratch upstream');
    await instance.call(mission, 'depot__create_space', { space: 'scratch' });
    expect(await rowOf('scratch')).toMatchObject({
      id: scratch.id,
      displayName: 'My scratch',
      env: 'prod',
    });
    expect((await selectionOf(mission))?.resourceIds).toContain(scratch.id);
  });

  it('the mission page marks it created by the mission; its activity says it reached it', async () => {
    const mission = await instance.issue({
      policy: [line(CREATE), line(READ)],
      spaces: ['scratch'],
    });
    instance.depot.scriptDiscovery(async () => [...SEEDED]);
    createsSpace('fresh');
    await instance.call(mission, 'depot__create_space', { space: 'fresh' });

    const detail = await instance.root.missions.service.get(instance.ada, mission.mission.id);
    const account = detail?.accounts[0];
    const fresh = account?.resources.find((r) => r.ref === 'fresh');
    expect(fresh).toBeDefined();
    expect(account?.created_resource_ids).toEqual([fresh!.id]);

    const session = await instance.root.store.sessions.getByMission(mission.mission.id);
    const events = await instance.root.store.sessions.listEvents(session!.id);
    expect(events.find((e) => e.kind === 'resources-created')).toMatchObject({
      actorUserId: instance.ada.id,
      details: {
        tool: 'depot__create_space',
        account_id: instance.account.id,
        refs: ['fresh'],
      },
    });
  });

  it('nothing joins on a declined call, an unreadable answer, or the instance’s own resource', async () => {
    const mission = await instance.issue({ policy: [line(CREATE)], spaces: ['scratch'] });
    instance.depot.scriptDiscovery(async () => [...SEEDED]);

    instance.depot.script(async () => ({
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ created: { ref: 'declined' } }) }],
    }));
    await instance.call(mission, 'depot__create_space', { space: 'declined' });
    instance.depot.script(async () => ({ content: [{ type: 'text', text: 'created!' }] }));
    await instance.call(mission, 'depot__create_space', { space: 'unread' });
    createsSpace('Not A Ref');
    await instance.call(mission, 'depot__create_space', { space: 'x' });

    expect(await rowOf('declined')).toBeUndefined();
    expect(await rowOf('unread')).toBeUndefined();
    expect((await selectionOf(mission))?.resourceIds).toHaveLength(1);
    expect(await addedEntries()).toHaveLength(0);
  });

  it('a failure to record it never changes the answer of the creating call', async () => {
    const mission = await instance.issue({ policy: [line(CREATE)], spaces: ['scratch'] });
    instance.depot.scriptDiscovery(async () => [...SEEDED]);
    createsSpace('fresh');
    const { missions } = instance.root.store;
    const original = missions.addResources.bind(missions);
    missions.addResources = async () => {
      throw new Error('disk full');
    };
    try {
      const body = await instance.call(mission, 'depot__create_space', { space: 'fresh' });
      expect(body.error).toBeUndefined();
      expect(body.result?.isError).toBeUndefined();
    } finally {
      missions.addResources = original;
    }
    expect(await addedEntries()).toHaveLength(0);
  });
});

describe('execution door: the instance’s own resource never joins', () => {
  it('a created ref the configuration names as the instance’s own is left out', async () => {
    const instance = await executionInstance({ env: { VAUBAAN_SELF_RESOURCES: `${DEPOT}:home` } });
    try {
      const mission = await instance.issue({ policy: [line(CREATE)], spaces: ['scratch'] });
      instance.depot.scriptDiscovery(async () => [...SEEDED]);
      instance.depot.script(async () => ({
        content: [{ type: 'text', text: JSON.stringify({ created: { ref: 'home' } }) }],
      }));
      await instance.call(mission, 'depot__create_space', { space: 'home' });
      const rows = await instance.root.store.accounts.listResources(instance.account.id);
      expect(rows.some((r) => r.ref === 'home')).toBe(false);
      const stored = await instance.root.store.missions.getById(mission.mission.id);
      expect(stored?.accounts[0]?.resourceSets[0]?.resourceIds).toHaveLength(1);
    } finally {
      await instance.close();
    }
  });
});
