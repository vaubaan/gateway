import { describe, expect, it } from 'vitest';

import { isOnMission, MEMBERSHIPS, membershipOf, type Membership } from './membership';

const mission = { creatorUserId: 'ada' };
const active = { status: 'active' } as const;
const deactivated = { status: 'removed' } as const;
const current = { removedAt: null };
const removed = { removedAt: '2026-10-13T09:00:00.000Z' };

describe('membershipOf — who a user is to a mission', () => {
  it.each<
    [
      string,
      string,
      typeof active | typeof deactivated | null,
      { removedAt: string | null } | null,
      Membership,
    ]
  >([
    ['the creator', 'ada', active, null, 'creator'],
    // The creator's own status is the mission's state (orphaned), not a membership.
    ['the creator, deactivated', 'ada', deactivated, null, 'creator'],
    ['the creator, with a stray member row', 'ada', active, removed, 'creator'],
    ['an active user with a current row', 'bob', active, current, 'member'],
    ['an active user whose row was removed', 'bob', active, removed, 'removed'],
    ['an active user with no row', 'bob', active, null, 'none'],
    ['a deactivated user with a current row', 'bob', deactivated, current, 'deactivated'],
    // Deactivation is told before removal.
    ['a deactivated user whose row was removed', 'bob', deactivated, removed, 'deactivated'],
    ['a deactivated user with no row', 'bob', deactivated, null, 'none'],
    ['an unknown user with a row', 'ghost', null, current, 'deactivated'],
    ['an unknown user with no row', 'ghost', null, null, 'none'],
  ])('%s is %s', (_who, userId, user, row, expected) => {
    expect(membershipOf(mission, userId, user, row)).toBe(expected);
  });

  it('only the creator and a current member are on the mission', () => {
    expect(Object.fromEntries(MEMBERSHIPS.map((m) => [m, isOnMission(m)]))).toEqual({
      creator: true,
      member: true,
      deactivated: false,
      removed: false,
      none: false,
    });
  });
});
