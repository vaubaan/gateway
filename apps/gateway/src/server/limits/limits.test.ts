import { describe, expect, it } from 'vitest';

import { ManualClock } from '../store/clock';
import {
  ceilingSentence,
  collectOpsStats,
  countsAsActiveMission,
  InstanceLimits,
  limitReached,
  revivesEndedMission,
  UNLIMITED,
  utcMidnight,
  type InstanceCounts,
} from '.';

const NOW = new Date('2026-10-31T15:30:00.000Z');

function counts(users: number, accounts: number, activeMissions: number): InstanceCounts {
  const byService: Record<string, number> = accounts > 0 ? { github: accounts } : {};
  return {
    users: async () => users,
    accounts: async () => ({ total: accounts, byService }),
    activeMissions: async () => activeMissions,
  };
}

describe('the refusal sentence', () => {
  it('names the count and the ceiling, in the words of each count', () => {
    expect(ceilingSentence('active-missions', 3, 3)).toBe(
      'This gateway holds 3 active missions; its ceiling is 3.',
    );
    expect(ceilingSentence('users', 1, 1)).toBe('This gateway holds 1 person; its ceiling is 1.');
    expect(ceilingSentence('accounts', 12, 10)).toBe(
      'This gateway holds 12 connected accounts; its ceiling is 10.',
    );
  });
});

describe('limitReached', () => {
  it('refuses at the ceiling and above it, allows below, never without a ceiling', () => {
    expect(limitReached('users', 2, 3)).toBeNull();
    expect(limitReached('users', 3, 3)).toMatchObject({ count: 3, limit: 3 });
    // A ceiling lowered under the count: still only a refusal, nothing else.
    expect(limitReached('users', 5, 3)?.message).toBe(
      'This gateway holds 5 people; its ceiling is 3.',
    );
    expect(limitReached('users', 1_000_000, null)).toBeNull();
  });
});

describe('InstanceLimits', () => {
  it('asks each count against its own ceiling', async () => {
    const limits = new InstanceLimits({
      limits: { users: 2, accounts: 5, activeMissions: null },
      counts: counts(2, 4, 99),
      clock: new ManualClock(NOW),
    });
    expect(await limits.refusal('users')).toMatchObject({ ceiling: 'users', count: 2, limit: 2 });
    expect(await limits.refusal('accounts')).toBeNull();
    expect(await limits.refusal('active-missions')).toBeNull();
    expect(await limits.usage()).toEqual([
      { ceiling: 'users', count: 2, limit: 2 },
      { ceiling: 'accounts', count: 4, limit: 5 },
      { ceiling: 'active-missions', count: 99, limit: null },
    ]);
  });

  it('counts nothing while unlimited', async () => {
    const never = async (): Promise<never> => {
      throw new Error('counted');
    };
    const limits = new InstanceLimits({
      limits: UNLIMITED,
      counts: { users: never, accounts: never, activeMissions: never },
    });
    expect(await limits.refusal('users')).toBeNull();
    expect(await limits.refusal('accounts')).toBeNull();
    expect(await limits.refusal('active-missions')).toBeNull();
  });
});

describe('which missions count as active, and which edit adds one', () => {
  const past = '2026-10-30T00:00:00.000Z';
  const future = '2026-11-30T00:00:00.000Z';

  it('active and orphaned missions count until their end; expired and revoked ones do not', () => {
    expect(countsAsActiveMission({ status: 'active', expiresAt: null }, NOW)).toBe(true);
    expect(countsAsActiveMission({ status: 'orphaned', expiresAt: future }, NOW)).toBe(true);
    expect(countsAsActiveMission({ status: 'active', expiresAt: past }, NOW)).toBe(false);
    expect(countsAsActiveMission({ status: 'expired', expiresAt: past }, NOW)).toBe(false);
    expect(countsAsActiveMission({ status: 'revoked', expiresAt: null }, NOW)).toBe(false);
  });

  it('a new end adds an active mission only to one that has ended', () => {
    expect(revivesEndedMission({ status: 'expired', expiresAt: past }, future, NOW)).toBe(true);
    expect(revivesEndedMission({ status: 'active', expiresAt: past }, null, NOW)).toBe(true);
    // Still ended after the edit, already running, or revoked for good: nothing added.
    expect(revivesEndedMission({ status: 'expired', expiresAt: past }, past, NOW)).toBe(false);
    expect(revivesEndedMission({ status: 'active', expiresAt: future }, null, NOW)).toBe(false);
    expect(revivesEndedMission({ status: 'revoked', expiresAt: past }, future, NOW)).toBe(false);
  });
});

describe('collectOpsStats', () => {
  it('answers counts only, in the documented shape', async () => {
    let since: string | null = null;
    const stats = await collectOpsStats({
      counts: {
        users: async () => 3,
        accounts: async () => ({ total: 4, byService: { github: 3, vercel: 1 } }),
        activeMissions: async () => 2,
      },
      limits: { users: 10, accounts: null, activeMissions: 5 },
      calls: {
        countCallsSince: async (from) => {
          since = from;
          return { allowed: 41, refused: 7 };
        },
      },
      store: { kind: 'sqlite', sizeOnDisk: () => 81_920 },
      sealed: {
        versions: async () => [
          { table: 'accounts', keyVersion: 1, count: 2 },
          { table: 'accounts', keyVersion: 2, count: 2 },
          { table: 'local_secrets', keyVersion: 2, count: 3 },
        ],
      },
      currentKeyVersion: 2,
      now: NOW,
    });
    expect(since).toBe('2026-10-31T00:00:00.000Z');
    expect(stats).toEqual({
      generated_at: '2026-10-31T15:30:00.000Z',
      users: 3,
      accounts: { total: 4, by_service: { github: 3, vercel: 1 } },
      active_missions: 2,
      calls_today: { since: '2026-10-31T00:00:00.000Z', allowed: 41, refused: 7 },
      store: { kind: 'sqlite', bytes: 81_920 },
      keys: { current_version: 2, sealed_by_version: { '1': 2, '2': 5 } },
      limits: { users: 10, accounts: null, active_missions: 5 },
    });
  });

  it('the day starts at midnight UTC', () => {
    expect(utcMidnight(new Date('2026-12-31T23:59:59.999Z')).toISOString()).toBe(
      '2026-12-31T00:00:00.000Z',
    );
    expect(utcMidnight(new Date('2027-01-01T00:00:00.000Z')).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });
});
