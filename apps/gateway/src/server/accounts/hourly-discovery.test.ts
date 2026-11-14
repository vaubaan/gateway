import { describe, expect, it } from 'vitest';

import { silentLogger } from '../logging';
import { systemClock } from '../store/clock';
import { HourlyDiscovery, type DiscoveryTimers } from './hourly-discovery';

function manualTimers() {
  const armed: { fn: () => void; ms: number }[] = [];
  const timers: DiscoveryTimers = {
    setTimeout(fn, ms) {
      armed.push({ fn, ms });
      return armed.length - 1;
    },
    clearTimeout() {
      armed.length = 0;
    },
  };
  return { timers, armed };
}

describe('HourlyDiscovery', () => {
  it('runs each account in turn, re-arms once a run ends, and stops cleanly', async () => {
    const { timers, armed } = manualTimers();
    const ran: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const hourly = new HourlyDiscovery({
      missions: { accountsWithFutureSets: async () => ['c1', 'c2'] },
      service: {
        discoverOnSchedule: async (id) => {
          ran.push(id);
          if (id === 'c1') await held;
          if (id === 'c2') throw new Error('boom');
          return { at: 'now', ok: true, count: 0, error: null, afterCall: null };
        },
      },
      logger: silentLogger,
      clock: systemClock,
      timers,
      intervalMs: 1000,
    });
    hourly.start();
    expect(armed.map((a) => a.ms)).toEqual([1000]);
    armed[0]!.fn();
    // A run in progress is handed back, never doubled.
    const again = hourly.runOnce();
    release();
    expect(await again).toEqual({ accounts: ['c1', 'c2'], failed: ['c2'] });
    expect(ran).toEqual(['c1', 'c2']);
    // Re-armed after the run, not before.
    await Promise.resolve();
    expect(armed).toHaveLength(2);
    await hourly.stop();
    expect(armed).toHaveLength(0);
  });
});
