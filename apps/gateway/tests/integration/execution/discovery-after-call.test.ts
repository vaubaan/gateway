/**
 * Discovery after a creating call (ADR created-resources-join-the-mission),
 * through the execution door: the real composition root on the `:memory:`
 * store, the `depot` fixture plugin whose `depot__create_space` is declared in
 * `resourceCreatingTools`, missions issued through the mission service.
 *
 * Spec §0 "Resource" (refreshed after a call that creates one), §3.1
 * "Resource selection" (a whole-connection mission reaches it), §8 (audit).
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
} from '../../support/execution/testing';

/** `depot__create_space` has no risk of its own: the fallback write covers it. */
const CREATE = 'depot.uncategorized-write';
const READ = 'depot.read';

const space = (ref: string): Resource => ({ provider: DEPOT, ref, displayName: ref });
const SEEDED: readonly Resource[] = DEFAULT_SPACES.map((s) => ({
  ...space(s.ref),
  ...(s.env ? { env: s.env } : {}),
}));

describe('execution door: discovery after a creating call', () => {
  let instance: ExecutionInstance;

  beforeEach(async () => {
    instance = await executionInstance();
  });
  afterEach(async () => {
    await instance.close();
  });

  const idle = (): Promise<void> => instance.root.connections.discoveryAfterCall.idle();

  async function discoveryEntries(): Promise<AdminAuditEntry[]> {
    const records = await instance.root.store.audit.list({ kind: 'admin' });
    return (records as unknown as AdminAuditEntry[]).filter(
      (e) => e.act === 'resources-discovered',
    );
  }

  it('a successful creating call schedules one discovery, audited with its cause', async () => {
    const mission = await instance.issue({ policy: [line(CREATE)], wholeConnection: true });
    instance.depot.scriptDiscovery(async () => [...SEEDED, space('fresh')]);

    const body = await instance.call(mission, 'depot__create_space', { space: 'fresh' });
    expect(body.error).toBeUndefined();
    await idle();

    expect(instance.depot.discoveries()).toBe(1);
    const refs = (await instance.root.store.connections.listResources(instance.connection.id)).map(
      (r) => r.ref,
    );
    expect(refs).toContain('fresh');
    const entries = await discoveryEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      user_id: instance.ada.id,
      object: { type: 'connection', id: instance.connection.id },
      after: {
        ok: true,
        count: SEEDED.length + 1,
        error: null,
        cause: 'after-a-call',
        mission_id: mission.mission.id,
        tool: 'depot__create_space',
        added: 1,
        attempts: 1,
      },
    });
    // The account page reads the same record: "last checked" names the call.
    const connection = await instance.root.store.connections.getById(instance.connection.id);
    expect(connection?.metadata?.discovery).toMatchObject({
      ok: true,
      afterCall: { missionId: mission.mission.id, tool: 'depot__create_space' },
    });
  });

  it('a whole-account mission reaches the new resource on its next call', async () => {
    const mission = await instance.issue({
      policy: [line(CREATE), line(READ)],
      wholeConnection: true,
    });
    instance.depot.scriptDiscovery(async () => [...SEEDED, space('fresh')]);

    // Never discovered: the classifier's own reason, nothing executed.
    const before = await instance.call(mission, 'depot__read_item', { space: 'fresh' });
    expect(before.error).toBeDefined();
    expect(instance.depot.calls).toHaveLength(0);

    await instance.call(mission, 'depot__create_space', { space: 'fresh' });
    await idle();

    const after = await instance.call(mission, 'depot__read_item', { space: 'fresh' });
    expect(after.error).toBeUndefined();
    expect(instance.depot.calls.at(-1)?.ctx.resources.map((r) => r.ref)).toContain('fresh');
  });

  it('a resource a whole-account mission does not reach is refused with a hint that says when one is', async () => {
    const mission = await instance.issue({ policy: [line(READ)], wholeConnection: true });
    const scratch = instance.resources.find((r) => r.ref === 'scratch')!;
    await instance.root.store.connections.setResourceHidden(scratch.id, true);

    const body = await instance.call(mission, 'depot__read_item', { space: 'scratch' });
    expect(body.error?.data?.code).toBe('resource-not-in-mission');
    expect(body.error?.data?.hint).toContain(
      'A resource created through the gateway is reached right after its creation',
    );
  });

  it('a refused creating call schedules nothing', async () => {
    // The mission does not accept the creation risk: refused before execution.
    const mission = await instance.issue({ policy: [line(READ)], wholeConnection: true });

    const body = await instance.call(mission, 'depot__create_space', { space: 'fresh' });
    expect(body.error?.data?.code).toBe('risk-not-accepted');
    await idle();

    expect(instance.depot.discoveries()).toBe(0);
    expect(await discoveryEntries()).toHaveLength(0);
  });

  it('a creating call that failed upstream, or that the plugin declined, schedules nothing', async () => {
    const mission = await instance.issue({ policy: [line(CREATE)], wholeConnection: true });

    instance.depot.script(async () => {
      throw new Error('upstream 500');
    });
    const failed = await instance.call(mission, 'depot__create_space', { space: 'fresh' });
    expect(failed.result?.isError).toBe(true);

    instance.depot.script(async () => ({
      isError: true,
      content: [{ type: 'text', text: 'declined' }],
    }));
    const declined = await instance.call(mission, 'depot__create_space', { space: 'fresh' });
    expect(declined.result?.isError).toBe(true);
    await idle();

    expect(instance.depot.discoveries()).toBe(0);
  });

  it('a call of a tool that creates nothing schedules nothing', async () => {
    const mission = await instance.issue({ policy: [line(READ)] });
    await instance.call(mission, 'depot__read_item', { space: 'scratch' });
    await idle();
    expect(instance.depot.discoveries()).toBe(0);
  });

  it('a burst of creations coalesces: one discovery in flight, one queued', async () => {
    const mission = await instance.issue({ policy: [line(CREATE)], wholeConnection: true });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let run = 0;
    instance.depot.scriptDiscovery(async () => {
      run += 1;
      if (run === 1) await held;
      // Each run finds something new, so none is looked at again.
      return [...SEEDED, space(`fresh-${run}`)];
    });

    await instance.call(mission, 'depot__create_space', { space: 'a' });
    // Let the first discovery start and hold.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await instance.call(mission, 'depot__create_space', { space: 'b' });
    await instance.call(mission, 'depot__create_space', { space: 'c' });
    release();
    await idle();

    expect(instance.depot.discoveries()).toBe(2);
    expect(await discoveryEntries()).toHaveLength(2);
  });

  it('the agent is answered before the discovery runs', async () => {
    const mission = await instance.issue({ policy: [line(CREATE)], wholeConnection: true });
    let started = false;
    instance.depot.scriptDiscovery(async () => {
      started = true;
      return [...SEEDED, space('fresh')];
    });

    const body = await instance.call(mission, 'depot__create_space', { space: 'fresh' });
    expect(body.error).toBeUndefined();
    expect(started).toBe(false);
    await idle();
    expect(started).toBe(true);
  });
});
