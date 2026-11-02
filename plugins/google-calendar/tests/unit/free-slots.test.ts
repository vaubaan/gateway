/**
 * The free slots `suggest_time` answers, computed from freeBusy's busy
 * blocks: clipped to the window, merged when they overlap or touch, gaps of
 * at least the duration, bounded in number.
 */
import { describe, expect, test } from 'vitest';

import { freeSlots, mergedBusy } from '../../src/free-slots.ts';

const H = 3_600_000;
const day = { start: 8 * H, end: 18 * H };

describe('mergedBusy', () => {
  test('clips to the window, sorts, merges overlapping and touching blocks, drops empty ones', () => {
    expect(
      mergedBusy(day, [
        { start: 12 * H, end: 13 * H },
        { start: 7 * H, end: 9 * H },
        { start: 9 * H, end: 10 * H },
        { start: 12.5 * H, end: 14 * H },
        { start: 15 * H, end: 15 * H },
        { start: 17 * H, end: 20 * H },
        { start: 19 * H, end: 21 * H },
      ]),
    ).toEqual([
      { start: 8 * H, end: 10 * H },
      { start: 12 * H, end: 14 * H },
      { start: 17 * H, end: 18 * H },
    ]);
  });
});

describe('freeSlots', () => {
  test('nobody busy: the whole window is one slot', () => {
    expect(freeSlots(day, [], H, 10)).toEqual([day]);
  });

  test('the gaps long enough, in order', () => {
    const busy = [
      { start: 9 * H, end: 10 * H },
      { start: 10.5 * H, end: 12 * H },
      { start: 16 * H, end: 18 * H },
    ];
    expect(freeSlots(day, busy, H, 10)).toEqual([
      { start: 8 * H, end: 9 * H },
      { start: 12 * H, end: 16 * H },
    ]);
    // A 30-minute meeting also fits between 10:00 and 10:30.
    expect(freeSlots(day, busy, 0.5 * H, 10)).toHaveLength(3);
  });

  test('a block that swallows another does not move the cursor back', () => {
    const busy = [
      { start: 9 * H, end: 15 * H },
      { start: 10 * H, end: 11 * H },
    ];
    expect(freeSlots(day, busy, H, 10)).toEqual([
      { start: 8 * H, end: 9 * H },
      { start: 15 * H, end: 18 * H },
    ]);
  });

  test('bounded by max; nothing for an empty window, a zero duration or no room', () => {
    const busy = [
      { start: 9 * H, end: 10 * H },
      { start: 11 * H, end: 12 * H },
    ];
    expect(freeSlots(day, busy, H, 2)).toEqual([
      { start: 8 * H, end: 9 * H },
      { start: 10 * H, end: 11 * H },
    ]);
    expect(freeSlots({ start: 5, end: 5 }, [], 1, 10)).toEqual([]);
    expect(freeSlots(day, [], 0, 10)).toEqual([]);
    expect(freeSlots(day, [{ start: 0, end: 24 * H }], H, 10)).toEqual([]);
  });
});
