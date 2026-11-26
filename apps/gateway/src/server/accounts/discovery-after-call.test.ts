/**
 * `DiscoveryAfterCall` on its own (ADR created-resources-join-the-mission):
 * which calls schedule a discovery, coalescing, the bounded retry, the audit
 * once, errors logged without arguments, `stop()`. The door's end-to-end is in
 * tests/integration/execution/discovery-after-call.test.ts.
 */
import type { MissionContext } from '@vaubaan/gateway-core';
import type { PluginRegistry, ServicePlugin } from '@vaubaan/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { silentLogger, type Logger } from '../logging';
import { DiscoveryAfterCall, type ScheduledCause } from './discovery-after-call';
import type { AfterCallDiscovery, DiscoveryAfterCallCause } from './service';

const CREATE = 'yard__create_shed';
const READ = 'yard__read_shed';
const LIST = 'yard__list_sheds';

const plugin = {
  id: 'yard',
  resourceCreatingTools: [CREATE],
  resourceRevealingTools: [LIST],
} as unknown as ServicePlugin;

const registry: Pick<PluginRegistry, 'serviceForTool'> = {
  serviceForTool: (tool) =>
    tool.startsWith('yard__') ? ({ plugin } as ReturnType<PluginRegistry['serviceForTool']>) : null,
};

function context(holder: 'member' | 'named' = 'member'): MissionContext {
  return {
    mission: { id: 'mis_1', creator_id: 'usr_creator' },
    token: {
      id: 'tok_1',
      prefix: 'vbn_x',
      holder:
        holder === 'member'
          ? { kind: 'member', user_id: 'usr_member', display: 'm@example.com' }
          : { kind: 'named', name: 'ci' },
    },
    accounts: [{ id: 'con_1', service: 'yard' }],
  } as unknown as MissionContext;
}

const ok = (added: number, missing = 0): AfterCallDiscovery => ({
  record: { at: 'now', ok: true, count: 3, error: null, afterCall: null },
  added,
  missing,
});
const failed: AfterCallDiscovery = {
  record: { at: 'now', ok: false, count: 0, error: 'HTTP 503', afterCall: null },
  added: 0,
  missing: 0,
};

interface Rig {
  readonly scheduler: DiscoveryAfterCall;
  readonly runs: DiscoveryAfterCallCause[];
  readonly audits: { cause: ScheduledCause; attempts: number; added: number }[];
  readonly sleeps: number[];
  readonly logs: { level: string; message: string; fields: Record<string, unknown> }[];
}

function rig(
  discover: (n: number) => Promise<AfterCallDiscovery | null>,
  options: { retryDelaysMs?: readonly number[] } = {},
): Rig {
  const runs: Rig['runs'] = [];
  const audits: Rig['audits'] = [];
  const sleeps: number[] = [];
  const logs: Rig['logs'] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: (message, fields = {}) => logs.push({ level: 'info', message, fields }),
    warn: (message, fields = {}) => logs.push({ level: 'warn', message, fields }),
    error: () => undefined,
    child: () => logger,
  };
  const scheduler = new DiscoveryAfterCall({
    registry,
    logger,
    retryDelaysMs: options.retryDelaysMs ?? [5, 10],
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    service: {
      discoverAfterCall: async (_id, cause) => {
        runs.push(cause);
        return discover(runs.length);
      },
      auditDiscoveryAfterCall: async (_id, cause, outcome) => {
        audits.push({
          cause,
          attempts: outcome.attempts,
          added: outcome.added,
        });
      },
    },
  });
  return { scheduler, runs, audits, sleeps, logs };
}

const created = { tool: CREATE, accountId: 'con_1', result: { content: [] } };

describe('DiscoveryAfterCall', () => {
  it('schedules after a successful call of a declared tool, with the member as the actor', async () => {
    const r = rig(async () => ok(1));
    expect(r.scheduler.afterCall(context(), created)).toBe(true);
    await r.scheduler.idle();
    expect(r.runs).toHaveLength(1);
    expect(r.audits).toEqual([
      {
        cause: { missionId: 'mis_1', tool: CREATE, userId: 'usr_member' },
        attempts: 1,
        added: 1,
      },
    ]);
  });

  it('told what the call created, looks again while discovery does not return it (ADR created-resources-join-the-mission)', async () => {
    // Nothing new (the row was recorded from the answer already), the created ref missing once.
    const r = rig(async (n) => (n === 1 ? ok(0, 1) : ok(0, 0)));
    r.scheduler.afterCall(context(), created, ['fresh']);
    await r.scheduler.idle();
    expect(r.runs).toHaveLength(2);
    expect(r.sleeps).toEqual([5]);
    expect(r.audits[0]).toMatchObject({ attempts: 2, added: 0 });

    // Never returned: the bounded schedule, nothing more.
    const never = rig(async () => ok(0, 1));
    never.scheduler.afterCall(context(), created, ['fresh']);
    await never.scheduler.idle();
    expect(never.runs).toHaveLength(3);
    expect(never.sleeps).toEqual([5, 10]);

    // Returned at once: one attempt, although it added nothing.
    const found = rig(async () => ok(0, 0));
    found.scheduler.afterCall(context(), created, ['fresh']);
    await found.scheduler.idle();
    expect(found.runs).toHaveLength(1);
  });

  it('after a revealing call, discovers once and never looks again when nothing new appeared (ADR preview-branches-are-discovered-resources)', async () => {
    const r = rig(async () => ok(0));
    expect(r.scheduler.afterCall(context(), { ...created, tool: LIST })).toBe(true);
    await r.scheduler.idle();
    expect(r.runs).toHaveLength(1);
    expect(r.sleeps).toEqual([]);
    expect(r.audits).toEqual([expect.objectContaining({ attempts: 1, added: 0 })]);

    // A failed discovery is not retried either: the hourly refresh comes anyway.
    const down = rig(async () => failed);
    down.scheduler.afterCall(context(), { ...created, tool: LIST });
    await down.scheduler.idle();
    expect(down.runs).toHaveLength(1);
  });

  it('a queued revealing call never replaces a queued creating one, whose retries it would drop', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const r = rig(async (n) => {
      if (n === 1) await held;
      return ok(1);
    });
    r.scheduler.schedule('con_1', { missionId: 'mis_1', tool: CREATE, userId: 'u1' });
    await new Promise((resolve) => setTimeout(resolve, 1));
    r.scheduler.schedule('con_1', { missionId: 'mis_2', tool: CREATE, userId: 'u2' });
    r.scheduler.schedule('con_1', { missionId: 'mis_3', tool: LIST, userId: 'u3', once: true });
    release();
    await r.scheduler.idle();
    expect(r.runs.map((c) => c.missionId)).toEqual(['mis_1', 'mis_2']);
  });

  it('names the creator as the actor of a call made with a named key', async () => {
    const r = rig(async () => ok(1));
    r.scheduler.afterCall(context('named'), created);
    await r.scheduler.idle();
    expect(r.audits[0]?.cause.userId).toBe('usr_creator');
  });

  it('schedules nothing for a declined result, another tool, an unknown tool or no account', async () => {
    const r = rig(async () => ok(1));
    const ctx = context();
    expect(r.scheduler.afterCall(ctx, { ...created, result: { isError: true } })).toBe(false);
    expect(r.scheduler.afterCall(ctx, { ...created, tool: READ })).toBe(false);
    expect(r.scheduler.afterCall(ctx, { ...created, tool: 'other__create' })).toBe(false);
    expect(r.scheduler.afterCall(ctx, { ...created, accountId: null })).toBe(false);
    expect(r.scheduler.afterCall(ctx, { ...created, accountId: 'con_elsewhere' })).toBe(false);
    await r.scheduler.idle();
    expect(r.runs).toHaveLength(0);
  });

  it('does not start before the caller returns', async () => {
    const r = rig(async () => ok(1));
    r.scheduler.afterCall(context(), created);
    expect(r.runs).toHaveLength(0);
    await r.scheduler.idle();
    expect(r.runs).toHaveLength(1);
  });

  it('coalesces a burst: one in flight, one queued, the latest cause kept', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const r = rig(async (n) => {
      if (n === 1) await held;
      return ok(1);
    });
    r.scheduler.schedule('con_1', { missionId: 'mis_1', tool: CREATE, userId: 'u1' });
    await new Promise((resolve) => setTimeout(resolve, 1));
    r.scheduler.schedule('con_1', { missionId: 'mis_2', tool: CREATE, userId: 'u2' });
    r.scheduler.schedule('con_1', { missionId: 'mis_3', tool: CREATE, userId: 'u3' });
    release();
    await r.scheduler.idle();
    expect(r.runs.map((c) => c.missionId)).toEqual(['mis_1', 'mis_3']);
    expect(r.audits).toHaveLength(2);
  });

  it('looks again after a failure or when nothing new appeared, a bounded number of times', async () => {
    const r = rig(async (n) => (n === 1 ? failed : ok(0)));
    r.scheduler.schedule('con_1', { missionId: 'mis_1', tool: CREATE, userId: 'u1' });
    await r.scheduler.idle();
    // One attempt and one per delay, then given up; audited once, on the last outcome.
    expect(r.runs).toHaveLength(3);
    expect(r.sleeps).toEqual([5, 10]);
    expect(r.audits).toEqual([expect.objectContaining({ attempts: 3, added: 0 })]);
  });

  it('stops looking once something new appeared', async () => {
    const r = rig(async (n) => (n === 1 ? ok(0) : ok(1)));
    r.scheduler.schedule('con_1', { missionId: 'mis_1', tool: CREATE, userId: 'u1' });
    await r.scheduler.idle();
    expect(r.runs).toHaveLength(2);
    expect(r.audits).toEqual([expect.objectContaining({ attempts: 2, added: 1 })]);
  });

  it('an account that no longer serves ends it, unaudited', async () => {
    const r = rig(async () => null);
    r.scheduler.schedule('con_1', { missionId: 'mis_1', tool: CREATE, userId: 'u1' });
    await r.scheduler.idle();
    expect(r.runs).toHaveLength(1);
    expect(r.audits).toHaveLength(0);
  });

  it('an error is logged with the account, the tool and the mission — and the next one still runs', async () => {
    const r = rig(async (n) => {
      if (n === 1) throw new TypeError('boom with secret args');
      return ok(1);
    });
    r.scheduler.schedule('con_1', { missionId: 'mis_1', tool: CREATE, userId: 'u1' });
    await r.scheduler.idle();
    const warning = r.logs.find((l) => l.level === 'warn');
    expect(warning).toEqual({
      level: 'warn',
      message: 'resource discovery after a creating call failed',
      fields: {
        account_id: 'con_1',
        tool: CREATE,
        mission_id: 'mis_1',
        error_class: 'TypeError',
      },
    });
    expect(JSON.stringify(r.logs)).not.toContain('secret args');
    r.scheduler.schedule('con_1', { missionId: 'mis_1', tool: CREATE, userId: 'u1' });
    await r.scheduler.idle();
    expect(r.audits).toHaveLength(1);
  });

  it('stop() drops what is queued, schedules nothing more and waits for the one in flight', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const r = rig(async () => {
      await held;
      return ok(1);
    });
    r.scheduler.schedule('con_1', { missionId: 'mis_1', tool: CREATE, userId: 'u1' });
    await new Promise((resolve) => setTimeout(resolve, 1));
    r.scheduler.schedule('con_1', { missionId: 'mis_2', tool: CREATE, userId: 'u2' });
    const stopping = r.scheduler.stop();
    expect(r.scheduler.afterCall(context(), created)).toBe(false);
    release();
    await stopping;
    expect(r.runs.map((c) => c.missionId)).toEqual(['mis_1']);
  });

  it('stop() cuts a retry wait short on the default timer', async () => {
    const scheduler = new DiscoveryAfterCall({
      registry,
      logger: silentLogger,
      retryDelaysMs: [60_000],
      service: {
        discoverAfterCall: async () => ok(0),
        auditDiscoveryAfterCall: async () => undefined,
      },
    });
    scheduler.schedule('con_1', { missionId: 'mis_1', tool: CREATE, userId: 'u1' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const t0 = Date.now();
    await scheduler.stop();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});
