import { describe, expect, it } from 'vitest';

import { silentLogger } from '../logging';
import { ManualClock } from '../store/clock';
import type { AccountRecord } from '../store/types';
import {
  AccountRefresher,
  backoffMs,
  isDue,
  isStale,
  lastSlotAt,
  phaseOf,
  REFRESH_TICK_MS,
  type RefreshTimers,
} from './account-refresh';
import type { AutomaticRefresh, DiscoveryRecord } from './service';

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const T0 = Date.parse('2026-11-15T10:00:00.000Z');

function manualTimers() {
  const armed: { fn: () => void; ms: number }[] = [];
  const timers: RefreshTimers = {
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

function account(
  id: string,
  lastAt: string | null,
  extra: Partial<AccountRecord> = {},
): AccountRecord {
  return {
    id,
    service: 'depot',
    owner: { kind: 'user', id: 'u1' },
    displayName: id,
    status: 'active',
    keyVersion: 1,
    credentialExpiresAt: null,
    defaultEnv: null,
    metadata: lastAt === null ? {} : { discovery: { at: lastAt, ok: true, count: 1, error: null } },
    createdAt: new Date(T0 - 24 * HOUR).toISOString(),
    updatedAt: new Date(T0 - 24 * HOUR).toISOString(),
    revokedAt: null,
    serviceGrant: null,
    ...extra,
  };
}

function outcome(ok: boolean, changed = false): AutomaticRefresh {
  const record: DiscoveryRecord = {
    at: new Date().toISOString(),
    ok,
    count: 1,
    error: ok ? null : 'unreachable',
    afterCall: null,
  };
  return { record, added: 0, removed: 0, rightsChanged: false, expired: false, changed };
}

describe('the slots of the hourly refresh', () => {
  it('gives each account a stable slot inside the interval, spread across it', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `acc-${i}`);
    const phases = ids.map((id) => phaseOf(id, HOUR));
    expect(phases.every((p) => p >= 0 && p < HOUR)).toBe(true);
    expect(phaseOf('acc-7', HOUR)).toBe(phaseOf('acc-7', HOUR));
    // Spread: every quarter of the hour holds a share of them, none holds them all.
    const quarters = [0, 1, 2, 3].map(
      (q) => phases.filter((p) => p >= (q * HOUR) / 4 && p < ((q + 1) * HOUR) / 4).length,
    );
    for (const count of quarters) expect(count).toBeGreaterThan(20);
  });

  it('places the last slot at or before now, less than one interval ago', () => {
    for (const now of [T0, T0 + 17 * MINUTE, T0 + 59 * MINUTE + 59_000]) {
      const slot = lastSlotAt('acc-1', now, HOUR);
      expect(slot).toBeLessThanOrEqual(now);
      expect(now - slot).toBeLessThan(HOUR);
      expect((((slot - phaseOf('acc-1', HOUR)) % HOUR) + HOUR) % HOUR).toBe(0);
    }
  });

  it('is due once its slot passed since the last refresh, and half an interval went by', () => {
    const id = 'acc-1';
    const now = lastSlotAt(id, T0, HOUR) + MINUTE; // just past its slot
    expect(isDue(id, now - 2 * HOUR, now, HOUR)).toBe(true);
    // Refreshed after its slot: not again before the next one.
    expect(isDue(id, now - 30_000, now, HOUR)).toBe(false);
    // Refreshed on open 10 minutes before its slot: the slot does not repeat it.
    expect(isDue(id, now - 11 * MINUTE, now, HOUR)).toBe(false);
    // Off.
    expect(isDue(id, now - 2 * HOUR, now, 0)).toBe(false);
  });

  it('is stale for a page only once refreshed, longer ago than the window', () => {
    expect(isStale(null, T0, 15 * MINUTE)).toBe(false);
    expect(isStale(T0 - 14 * MINUTE, T0, 15 * MINUTE)).toBe(false);
    expect(isStale(T0 - 15 * MINUTE, T0, 15 * MINUTE)).toBe(true);
  });

  it('backs off one, two, four, then eight intervals at most', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map((n) => backoffMs(n, HOUR) / HOUR)).toEqual([
      0, 1, 2, 4, 8, 8, 8,
    ]);
  });
});

describe('AccountRefresher', () => {
  function rig(accounts: AccountRecord[], futureIds: string[] = []) {
    const clock = new ManualClock(new Date(T0));
    const { timers, armed } = manualTimers();
    const ran: { id: string; cause: string }[] = [];
    let answer: (id: string) => Promise<AutomaticRefresh | null> = async () => outcome(true);
    const refresher = new AccountRefresher({
      accounts: {
        list: async (filter) =>
          accounts.filter((a) => filter?.status === undefined || a.status === filter.status),
        getById: async (id) => accounts.find((a) => a.id === id) ?? null,
      },
      missions: { accountsWithFutureSets: async () => futureIds },
      service: {
        refreshOnItsOwn: async (id, cause) => {
          ran.push({ id, cause });
          return answer(id);
        },
      },
      logger: silentLogger,
      clock,
      intervalMs: HOUR,
      timers,
    });
    return {
      refresher,
      clock,
      armed,
      ran,
      answer: (fn: typeof answer) => {
        answer = fn;
      },
    };
  }

  it('ticks every minute, refreshes the due accounts in slot order, and re-arms after a tick', async () => {
    const old = new Date(T0 - 3 * HOUR).toISOString();
    const fresh = new Date(T0 - 5 * MINUTE).toISOString();
    const accounts = [
      account('a', old),
      account('b', old),
      account('fresh', fresh),
      account('gone', old, { status: 'revoked' }),
      account('host', old, { metadata: { credential_kind: 'host' } }),
      account('lost', old, { status: 'expired' }),
      // Unowned, but a running future set needs it.
      account('unowned', old, { status: 'unowned' }),
    ];
    const r = rig(accounts, ['unowned']);
    r.refresher.start();
    expect(r.armed.map((a) => a.ms)).toEqual([REFRESH_TICK_MS]);
    const run = await r.refresher.runOnce();
    expect([...run.accounts].sort()).toEqual(['a', 'b', 'unowned']);
    const order = run.accounts.map((id) => lastSlotAt(id, T0, HOUR));
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(r.ran.every((call) => call.cause === 'scheduled')).toBe(true);

    r.armed[0]!.fn();
    await new Promise((resolve) => setImmediate(resolve));
    expect(r.armed).toHaveLength(2);
    await r.refresher.stop();
    expect(r.armed).toHaveLength(0);
  });

  it('runs one tick at a time', async () => {
    const r = rig([account('a', new Date(T0 - 3 * HOUR).toISOString())]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    r.answer(async () => {
      await held;
      return outcome(true);
    });
    const [first, second] = [r.refresher.runOnce(), r.refresher.runOnce()];
    expect(first).toBe(second);
    release();
    expect((await first).accounts).toEqual(['a']);
    expect(r.ran).toHaveLength(1);
  });

  it('puts a failing account aside, longer each time, and clears it on success', async () => {
    const accounts = [account('a', new Date(T0 - 3 * HOUR).toISOString())];
    const r = rig(accounts);
    r.answer(async () => outcome(false));
    expect((await r.refresher.runOnce()).failed).toEqual(['a']);
    // Aside for an hour: neither the tick nor a page asks again.
    r.clock.advance(30 * MINUTE);
    expect(r.refresher.staleAmong(accounts)).toEqual([]);
    expect((await r.refresher.runOnce()).accounts).toEqual([]);
    r.clock.advance(31 * MINUTE + HOUR);
    expect((await r.refresher.runOnce()).failed).toEqual(['a']);
    // Second failure: two hours.
    r.clock.advance(90 * MINUTE);
    expect(r.refresher.staleAmong(accounts)).toEqual([]);
    r.clock.advance(31 * MINUTE);
    expect(r.refresher.staleAmong(accounts)).toEqual(['a']);
    r.answer(async () => outcome(true));
    expect((await r.refresher.refreshStale(['a'])).refreshed).toEqual(['a']);
    // Cleared: the next failure is one interval again.
    r.answer(async () => outcome(false));
    await r.refresher.refreshStale(['a']);
    r.clock.advance(HOUR + MINUTE);
    expect(r.refresher.staleAmong(accounts)).toEqual(['a']);
  });

  it('refreshes for a page only the stale accounts, and says which changed', async () => {
    const accounts = [
      account('stale', new Date(T0 - 20 * MINUTE).toISOString()),
      account('changes', new Date(T0 - 2 * HOUR).toISOString()),
      account('recent', new Date(T0 - 2 * MINUTE).toISOString()),
      account('never', null),
    ];
    const r = rig(accounts);
    expect(r.refresher.staleAmong(accounts)).toEqual(['stale', 'changes']);
    r.answer(async (id) => outcome(true, id === 'changes'));
    const answer = await r.refresher.refreshStale(['stale', 'changes', 'recent', 'never', 'nope']);
    expect([...answer.refreshed].sort()).toEqual(['changes', 'stale']);
    expect(answer.changed).toEqual(['changes']);
    expect(r.ran.every((call) => call.cause === 'on-open')).toBe(true);
  });

  it('shares a refresh under way: a page asking for an account the tick is refreshing waits for it', async () => {
    const accounts = [account('a', new Date(T0 - 3 * HOUR).toISOString())];
    const r = rig(accounts);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    r.answer(async () => {
      await held;
      return outcome(true, true);
    });
    const tick = r.refresher.runOnce();
    await new Promise((resolve) => setImmediate(resolve));
    const page = r.refresher.refreshStale(['a']);
    release();
    await tick;
    expect((await page).changed).toEqual(['a']);
    expect(r.ran).toHaveLength(1);
  });

  it('does nothing when the interval is 0', async () => {
    const accounts = [account('a', new Date(T0 - 3 * HOUR).toISOString())];
    const { timers, armed } = manualTimers();
    const off = new AccountRefresher({
      accounts: { list: async () => accounts, getById: async () => accounts[0]! },
      missions: { accountsWithFutureSets: async () => [] },
      service: {
        refreshOnItsOwn: async () => {
          throw new Error('not expected');
        },
      },
      logger: silentLogger,
      clock: new ManualClock(new Date(T0)),
      intervalMs: 0,
      timers,
    });
    off.start();
    expect(armed).toEqual([]);
    expect(off.staleAmong(accounts)).toEqual([]);
    expect(await off.refreshStale(['a'])).toEqual({ refreshed: [], changed: [] });
  });
});
