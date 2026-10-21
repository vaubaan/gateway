/**
 * The pure parts of the schedule (ADR scheduled-encrypted-backup-to-object-storage, D2):
 * the next slot, the object key.
 */
import { describe, expect, it } from 'vitest';

import { BACKUP_OBJECT_NAME, backupObjectKey, nextRunAfter, timeOfDay } from './scheduled';

const H = 3600;

describe('nextRunAfter', () => {
  it.each([
    // now, every, at, next
    ['2026-10-21T02:59:59Z', 24 * H, '03:00', '2026-10-21T03:00:00.000Z'],
    ['2026-10-21T03:00:00Z', 24 * H, '03:00', '2026-10-22T03:00:00.000Z'],
    ['2026-10-21T10:15:00Z', 24 * H, '03:00', '2026-10-22T03:00:00.000Z'],
    ['2026-10-21T10:15:00Z', 6 * H, '03:00', '2026-10-21T15:00:00.000Z'],
    ['2026-10-21T22:00:00Z', 6 * H, '03:00', '2026-10-22T03:00:00.000Z'],
    ['2026-10-21T01:00:00Z', 6 * H, '03:00', '2026-10-21T03:00:00.000Z'],
    ['2026-10-21T10:15:00Z', 1 * H, '00:30', '2026-10-21T10:30:00.000Z'],
    ['2026-10-21T23:59:00Z', 8 * H, '23:45', '2026-10-22T07:45:00.000Z'],
    ['2026-12-31T23:00:00Z', 24 * H, '00:00', '2027-01-01T00:00:00.000Z'],
  ])('after %s, every %i s from %s: %s', (now, every, at, next) => {
    const [h = 0, m = 0] = at.split(':').map(Number);
    expect(nextRunAfter(new Date(now), every, h * 60 + m).toISOString()).toBe(next);
  });
});

describe('the object key', () => {
  it('is the prefix, the name and the UTC stamp of the run', () => {
    const key = backupObjectKey('tenant/a/', new Date('2026-10-21T03:00:00.123Z'));
    expect(key).toBe('tenant/a/vaubaan-backup-20261021T030000Z.vbk');
    expect(BACKUP_OBJECT_NAME.test(key.slice('tenant/a/'.length))).toBe(true);
  });

  it('timeOfDay writes HH:MM', () => {
    expect(timeOfDay(0)).toBe('00:00');
    expect(timeOfDay(3 * 60 + 5)).toBe('03:05');
  });
});
