import { describe, expect, it } from 'vitest';

import { encodeCursor } from './filters';
import { keysetOf, pageOf, parsePage } from './paging';

const A = { ts: '2026-10-13T09:00:00.000Z', id: 'a' };
const B = { ts: '2026-10-12T09:00:00.000Z', id: 'b' };

/** Rows `n`…`1`, newest first, as the store returns a page read from the top. */
function rows(count: number, from = count) {
  return Array.from({ length: count }, (_, i) => {
    const n = from - i;
    return {
      id: `r${String(n).padStart(3, '0')}`,
      ts: `2026-10-13T09:00:${String(n % 60).padStart(2, '0')}.000Z`,
    };
  });
}

describe('parsePage', () => {
  it('no position is the first page, line 1', () => {
    expect(parsePage({})).toEqual({ position: null, at: 1, problems: [] });
    // A line number without a position is the first page all the same.
    expect(parsePage({ at: '51' }).at).toBe(1);
  });

  it('reads an older or a newer position, and the line it starts at', () => {
    expect(parsePage({ cursor: encodeCursor(A), at: '51' })).toEqual({
      position: { direction: 'older', from: A },
      at: 51,
      problems: [],
    });
    expect(parsePage({ after: encodeCursor(B) }).position).toEqual({
      direction: 'newer',
      from: B,
    });
    // A position without a line number shows no number.
    expect(parsePage({ after: encodeCursor(B) }).at).toBeNull();
  });

  it('falls back to the newest lines on what it cannot read, and says so', () => {
    const bad = parsePage({ cursor: 'not a cursor!' });
    expect(bad.position).toBeNull();
    expect(bad.problems).toEqual(['cursor: unreadable, showing the newest lines']);
    const both = parsePage({ cursor: encodeCursor(A), after: encodeCursor(B) });
    expect(both.position).toBeNull();
    expect(both.problems).toHaveLength(1);
    for (const at of ['0', '-3', 'x', '123456789']) {
      expect(parsePage({ cursor: encodeCursor(A), at }).at, at).toBeNull();
    }
  });
});

describe('keysetOf', () => {
  it('maps a position to the store’s keyset', () => {
    expect(keysetOf(null)).toEqual({});
    expect(keysetOf({ direction: 'older', from: A })).toEqual({ before: A });
    expect(keysetOf({ direction: 'newer', from: B })).toEqual({ after: B });
  });
});

describe('pageOf', () => {
  it('the first page: older when the store returned one row more, no newer', () => {
    const page = pageOf(rows(4), 3, null);
    expect(page.shown.map((r) => r.id)).toEqual(['r004', 'r003', 'r002']);
    expect(page.older).toEqual({ ts: page.shown[2]?.ts, id: 'r002' });
    expect(page.newer).toBeNull();
    expect(pageOf(rows(3), 3, null).older).toBeNull();
  });

  it('a page older than a position: newer is its first line', () => {
    const page = pageOf(rows(2, 5), 3, { direction: 'older', from: A });
    expect(page.shown.map((r) => r.id)).toEqual(['r005', 'r004']);
    expect(page.older).toBeNull();
    expect(page.newer?.id).toBe('r005');
  });

  it('a page newer than a position: read oldest first, shown newest first', () => {
    const ascending = rows(4).reverse();
    const page = pageOf(ascending, 3, { direction: 'newer', from: B });
    expect(page.shown.map((r) => r.id)).toEqual(['r003', 'r002', 'r001']);
    expect(page.newer?.id).toBe('r003');
    expect(page.older?.id).toBe('r001');
    // The newest page reached from below: nothing newer.
    expect(pageOf(rows(3).reverse(), 3, { direction: 'newer', from: B }).newer).toBeNull();
  });

  it('an empty page has no neighbour of its own', () => {
    expect(pageOf([], 3, { direction: 'older', from: A })).toEqual({
      shown: [],
      older: null,
      newer: null,
    });
  });
});
