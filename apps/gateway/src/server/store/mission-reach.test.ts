import { describe, expect, it } from 'vitest';

import { reachedResources, reachedResourcesBySet, reachesLaterResources } from './mission-reach.ts';

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
/** A connection of the mission with one resource set. */
const one = (set: {
  readonly resourceScope: 'all' | 'selected' | 'connection';
  readonly resourceIds: readonly string[];
}) => ({ resourceSets: [{ id: 's1', position: 1, ...set }] });

describe('reachedResources — what a mission reaches on one connection', () => {
  it('an explicit selection: the stored ids, minus stale and self; a hidden one picked on purpose stays', () => {
    const selection = one({ resourceScope: 'selected', resourceIds: ['a', 'b', 'c', 'self'] });
    expect(ids(reachedResources(selection, rows, isSelf))).toEqual(['a', 'b']);
    expect(reachesLaterResources(selection)).toBe(false);
  });

  it('scope `all` with an empty list reaches nothing, whatever discovery found since', () => {
    const selection = one({ resourceScope: 'all', resourceIds: [] });
    expect(reachedResources(selection, rows, isSelf)).toEqual([]);
    expect(reachesLaterResources(selection)).toBe(false);
  });

  it('scope `connection` reaches the live list: later resources included, hidden, stale and self excepted', () => {
    const selection = one({ resourceScope: 'connection', resourceIds: [] });
    expect(ids(reachedResources(selection, rows, isSelf))).toEqual(['a', 'later']);
    expect(reachesLaterResources(selection)).toBe(true);
    // A resource discovery no longer returns is not reached any more.
    expect(
      ids(
        reachedResources(
          selection,
          rows.map((r) => (r.id === 'later' ? { ...r, staleSince: STALE } : r)),
          isSelf,
        ),
      ),
    ).toEqual(['a']);
  });

  it('resource sets partition the reach: the whole-connection set reaches what no other set selects', () => {
    const selection = {
      resourceSets: [
        { id: 's1', position: 1, resourceScope: 'selected', resourceIds: ['b'] },
        { id: 's2', position: 2, resourceScope: 'connection', resourceIds: [] },
      ],
    } as const;
    const bySet = reachedResourcesBySet(selection, rows, isSelf);
    expect(ids(bySet.get('s1') ?? [])).toEqual(['b']);
    expect(ids(bySet.get('s2') ?? [])).toEqual(['a', 'later']);
    // The connection's reach is the union, in the connection's order.
    expect(ids(reachedResources(selection, rows, isSelf))).toEqual(['a', 'b', 'later']);
    expect(reachesLaterResources(selection)).toBe(true);
  });

  it('a resource another set selects leaves the whole-connection set, hidden or not', () => {
    const selection = {
      resourceSets: [
        { id: 's1', position: 1, resourceScope: 'connection', resourceIds: [] },
        { id: 's2', position: 2, resourceScope: 'selected', resourceIds: ['a'] },
      ],
    } as const;
    const bySet = reachedResourcesBySet(selection, rows, isSelf);
    expect(ids(bySet.get('s1') ?? [])).toEqual(['later']);
    expect(ids(bySet.get('s2') ?? [])).toEqual(['a']);
  });
});
