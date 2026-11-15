/**
 * A deadline on every plugin call (`execution.call_timeout_seconds`).
 *
 * A service that never answers must not hold the request, the decrypted
 * credential, the pending audit entry and the surface slot for ever: the
 * plugin receives a signal that fires at the deadline, and the stage stops
 * waiting at that moment even when the plugin does not listen. The call was
 * allowed and counted; the audit records it as `upstream_error` ending in
 * `(timeout)`, and the agent reads a tool error that says so.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  executionInstance,
  line,
  type ExecutionInstance,
  type IssuedMission,
} from '../../support/execution/testing';

const READ = 'depot.read';
const TOOL = 'depot__read_item';
const ARGS = { space: 'scratch' };

describe('a plugin call past its deadline', () => {
  let instance: ExecutionInstance;
  let mission: IssuedMission;

  beforeEach(async () => {
    instance = await executionInstance({
      env: { VAUBAAN_EXECUTION_CALL_TIMEOUT_SECONDS: '1' },
    });
    mission = await instance.issue({ policy: [line(READ, 5)] });
  });
  afterEach(async () => {
    await instance.close();
  });

  const consumed = async (): Promise<number> => {
    const session = await instance.root.store.sessions.getByMission(mission.mission.id);
    if (!session) return 0;
    const counters = await instance.root.store.sessions.counters(session.id);
    return counters.filter((c) => c.riskId === READ).reduce((sum, c) => sum + c.consumed, 0);
  };

  it('is stopped for a plugin that never answers and ignores its signal', async () => {
    let signalled: AbortSignal | undefined;
    // Never settles, and never looks at ctx.signal.
    instance.depot.script((ctx) => {
      signalled = ctx.signal;
      return new Promise(() => undefined);
    });

    const started = performance.now();
    const body = await instance.call(mission, TOOL, ARGS);
    const elapsed = performance.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(elapsed).toBeLessThan(5_000);
    expect(body.result).toMatchObject({ isError: true });
    const [content] = (body.result?.content ?? []) as { type: string; text: string }[];
    expect(content?.text).toMatch(
      /^Upstream error: timeout: depot did not answer within 1 seconds/,
    );
    expect(content?.text).toContain('counted');
    // The plugin was handed a signal, and it fired at the deadline.
    expect(signalled?.aborted).toBe(true);

    const [entry] = await instance.root.store.audit.list({ missionId: mission.mission.id });
    expect(entry).toMatchObject({ decision: 'allowed', tool: TOOL });
    expect(entry?.kind === 'call' && entry.upstream_error).toMatch(/\(timeout\)$/);
    expect(await consumed()).toBe(1);
  });

  it('is stopped for a plugin that listens: its abort is recorded as the timeout', async () => {
    instance.depot.script(
      (ctx) =>
        new Promise((_, reject) => {
          ctx.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );

    const body = await instance.call(mission, TOOL, ARGS);

    expect(body.result).toMatchObject({ isError: true });
    const [entry] = await instance.root.store.audit.list({ missionId: mission.mission.id });
    expect(entry?.kind === 'call' && entry.upstream_error).toBe(
      'depot call stopped: no answer within 1 s (timeout)',
    );
  });

  it('leaves a call that answers in time untouched', async () => {
    instance.depot.script(async () => ({ content: [{ type: 'text', text: 'ok' }] }));

    const body = await instance.call(mission, TOOL, ARGS);

    expect(body.result).toMatchObject({ content: [{ type: 'text', text: 'ok' }] });
    const [entry] = await instance.root.store.audit.list({ missionId: mission.mission.id });
    expect(entry).toMatchObject({ decision: 'allowed', upstream_error: null });
  });
});
