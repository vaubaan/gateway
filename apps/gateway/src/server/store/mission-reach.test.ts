import { describe, expect, it } from 'vitest';

import { reachedResources, reachedResourcesBySet, takesFutureResources } from './mission-reach.ts';

const STALE = '2026-10-17T00:00:00.000Z';

const rows = [
  { id: 'a', ref: 'app-a', hidden: false, staleSince: null },
  { id: 'b', ref: 'app-b', hidden: true, staleSince: null },
  { id: 'c', ref: 'app-c', hidden: false, staleSince: STALE },
  { id: 'self', ref: 'instance', hidden: false, staleSince: null },
  { id: 'later', ref: 'app-later', hidden: false, staleSince: null },
];
const isSelf = (r: { ref: string }): boolean => r.ref === 'instance';
const ids = (list: readonly { id: string }[]): string[] => list.map((r) => r.id);
/** One resource set of a connection. */
const set = (id: string, resourceIds: readonly string[], future = false) => ({
  id,
  position: 1,
  resourceIds,
  future,
  env: null,
  mixedEnv: false,
});

describe('reachedResources — what a mission reaches on one connection', () => {
  it('a list: the stored ids, minus stale and self; a hidden one in the list stays', () => {
    const selection = { resourceSets: [set('s1', ['a', 'b', 'c', 'self'])] };
    expect(ids(reachedResources(selection, rows, isSelf))).toEqual(['a', 'b']);
    expect(takesFutureResources(selection)).toBe(false);
  });

  it('an empty list reaches nothing, whatever discovery found since', () => {
    const selection = { resourceSets: [set('s1', [])] };
    expect(reachedResources(selection, rows, isSelf)).toEqual([]);
  });

  it('a set with future on reaches its list only: nothing is resolved from the connection', () => {
    const selection = { resourceSets: [set('s1', ['a'], true)] };
    expect(ids(reachedResources(selection, rows, isSelf))).toEqual(['a']);
    expect(takesFutureResources(selection)).toBe(true);
    // A resource discovery no longer returns is not reached any more.
    expect(
      reachedResources(
        selection,
        rows.map((r) => (r.id === 'a' ? { ...r, staleSince: STALE } : r)),
        isSelf,
      ),
    ).toEqual([]);
  });

  it('each set reaches its own list; the connection reaches the union, in its own order', () => {
    const selection = { resourceSets: [set('s1', ['later']), set('s2', ['b', 'a'], true)] };
    const bySet = reachedResourcesBySet(selection, rows, isSelf);
    expect(ids(bySet.get('s1') ?? [])).toEqual(['later']);
    expect(ids(bySet.get('s2') ?? [])).toEqual(['a', 'b']);
    expect(ids(reachedResources(selection, rows, isSelf))).toEqual(['a', 'b', 'later']);
  });
});
