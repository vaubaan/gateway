import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '../logging';
import { REQUEST_SWEEP_INTERVAL_MS, startRequestSweeper } from './sweeper';

describe('request sweeper', () => {
  const lines: string[] = [];
  const logger = createLogger({
    level: 'error',
    redact: (text) => text,
    write: (_level, line) => lines.push(line),
  });

  beforeEach(() => {
    vi.useFakeTimers();
    lines.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sweeps on every interval until stopped', async () => {
    const sweep = vi.fn(async () => 0);
    const sweeper = startRequestSweeper({ sweep, logger });
    expect(sweep).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(REQUEST_SWEEP_INTERVAL_MS);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * REQUEST_SWEEP_INTERVAL_MS);
    expect(sweep).toHaveBeenCalledTimes(3);
    sweeper.stop();
    await vi.advanceTimersByTimeAsync(5 * REQUEST_SWEEP_INTERVAL_MS);
    expect(sweep).toHaveBeenCalledTimes(3);
  });

  it('runOnce reports how many requests expired', async () => {
    const sweeper = startRequestSweeper({ sweep: async () => 4, logger, intervalMs: 1000 });
    expect(await sweeper.runOnce()).toBe(4);
    sweeper.stop();
  });

  it('a failing pass is logged and the next one still runs', async () => {
    const sweep = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('database is locked'))
      .mockResolvedValue(2);
    const sweeper = startRequestSweeper({ sweep, logger, intervalMs: 1000 });
    expect(await sweeper.runOnce()).toBe(0);
    expect(lines.join('\n')).toContain('request sweep failed');
    expect(lines.join('\n')).toContain('database is locked');
    expect(await sweeper.runOnce()).toBe(2);
    sweeper.stop();
  });

  it('does not stack a pass on one still running', async () => {
    let release: (count: number) => void = () => undefined;
    const sweep = vi.fn(() => new Promise<number>((resolve) => (release = resolve)));
    const sweeper = startRequestSweeper({ sweep, logger, intervalMs: 1000 });
    const first = sweeper.runOnce();
    expect(await sweeper.runOnce()).toBe(0);
    expect(sweep).toHaveBeenCalledTimes(1);
    release(1);
    expect(await first).toBe(1);
    sweeper.stop();
  });
});
