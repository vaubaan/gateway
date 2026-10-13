import { describe, expect, it } from 'vitest';

import { ManualClock } from '../store/clock';
import {
  delegationDeadline,
  delegationLifetime,
  expiryWithin,
  pastLifetime,
} from './delegation-lifetime';

const DAY = 86_400;
const CONSENT = '2026-10-13T09:00:00.000Z';
const delegation = { createdAt: CONSENT };
const at = (iso: string) => new Date(iso);

describe('absolute lifetime of a delegation', () => {
  it('ends the configured time after the consent, to the millisecond', () => {
    expect(delegationDeadline(delegation, 90 * DAY).toISOString()).toBe('2027-01-11T09:00:00.000Z');
    expect(delegationDeadline(delegation, 3_600).toISOString()).toBe('2026-10-13T10:00:00.000Z');
  });

  it('is over at the deadline itself, not one millisecond before', () => {
    expect(pastLifetime(delegation, 90 * DAY, at(CONSENT))).toBe(false);
    expect(pastLifetime(delegation, 90 * DAY, at('2027-01-11T08:59:59.999Z'))).toBe(false);
    expect(pastLifetime(delegation, 90 * DAY, at('2027-01-11T09:00:00.000Z'))).toBe(true);
    expect(pastLifetime(delegation, 90 * DAY, at('2030-01-01T00:00:00.000Z'))).toBe(true);
  });

  it('reads a consent date it cannot parse as past its lifetime', () => {
    expect(pastLifetime({ createdAt: 'not-a-date' }, 90 * DAY, at(CONSENT))).toBe(true);
    expect(pastLifetime({ createdAt: '' }, 90 * DAY, at(CONSENT))).toBe(true);
  });

  it('lets a token live its own lifetime, never past the deadline', () => {
    const now = at('2027-01-10T09:00:00.000Z'); // one day left
    expect(expiryWithin(delegation, 90 * DAY, 900, now).toISOString()).toBe(
      '2027-01-10T09:15:00.000Z',
    );
    expect(expiryWithin(delegation, 90 * DAY, 30 * DAY, now).toISOString()).toBe(
      '2027-01-11T09:00:00.000Z',
    );
    // Asked past the deadline, the answer is the deadline: already expired.
    expect(
      expiryWithin(delegation, 90 * DAY, 900, at('2027-02-01T00:00:00.000Z')).toISOString(),
    ).toBe('2027-01-11T09:00:00.000Z');
  });

  it('bound to a clock, follows it', () => {
    const clock = new ManualClock(at(CONSENT));
    const lifetime = delegationLifetime(90 * DAY, clock);
    expect(lifetime.isOver(delegation)).toBe(false);
    expect(lifetime.deadlineOf(delegation).toISOString()).toBe('2027-01-11T09:00:00.000Z');
    clock.advance(90 * DAY * 1000 - 1);
    expect(lifetime.isOver(delegation)).toBe(false);
    expect(lifetime.expiryOf(delegation, 900).toISOString()).toBe('2027-01-11T09:00:00.000Z');
    clock.advance(1);
    expect(lifetime.isOver(delegation)).toBe(true);
  });
});
