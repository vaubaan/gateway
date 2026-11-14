import { describe, expect, it } from 'vitest';

import { decodeCursor } from '@/server/audit/filters';

import { linesWords, neighboursOf, NEWEST, setPage } from './page-links';

const A = { ts: '2026-10-13T09:00:00.000Z', id: 'a' };
const B = { ts: '2026-10-12T09:00:00.000Z', id: 'b' };

describe('the pager’s links', () => {
  it('the first page offers only Older, numbered after its lines', () => {
    const around = neighboursOf({ older: B, newer: null }, NEWEST, 50, 50);
    expect(around.newer).toBeNull();
    expect(around.newest).toBeNull();
    expect(around.older).toEqual({ position: { direction: 'older', from: B }, at: 51 });
  });

  it('a page further down offers Newest, Newer and Older', () => {
    const here = { position: { direction: 'older', from: A }, at: 51 } as const;
    const around = neighboursOf({ older: B, newer: A }, here, 50, 50);
    expect(around.newest).toEqual(NEWEST);
    expect(around.newer).toEqual({ position: { direction: 'newer', from: A }, at: 1 });
    expect(around.older?.at).toBe(101);
  });

  it('a page that does not know its number numbers no link', () => {
    const here = { position: { direction: 'older', from: A }, at: null } as const;
    const around = neighboursOf({ older: B, newer: A }, here, 50, 50);
    expect(around.newer?.at).toBeNull();
    expect(around.older?.at).toBeNull();
  });

  it('writes one position into an address, keeping the rest of it', () => {
    const params = new URLSearchParams('mission=m-1&cursor=old&at=9');
    setPage(params, { position: { direction: 'newer', from: A }, at: 51 });
    expect(params.get('mission')).toBe('m-1');
    expect(params.get('cursor')).toBeNull();
    expect(decodeCursor(params.get('after') ?? '')).toEqual(A);
    expect(params.get('at')).toBe('51');
    setPage(params, NEWEST);
    expect(params.toString()).toBe('mission=m-1');
  });

  it('says which lines are shown', () => {
    expect(linesWords(51, 50)).toBe('Lines 51–100');
    expect(linesWords(1, 1)).toBe('Line 1');
    expect(linesWords(null, 50)).toBe('50 lines');
    expect(linesWords(1, 0)).toBe('No line');
  });
});
