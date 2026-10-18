import { describe, expect, it } from 'vitest';

import { reachedResources, reachesLaterResources } from './mission-reach.ts';

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

describe('reachedResources — what a mission reaches on one connection', () => {
  it('an explicit selection: the stored ids, minus stale and self; a hidden one picked on purpose stays', () => {
    const selection = { resourceScope: 'selected', resourceIds: ['a', 'b', 'c', 'self'] } as const;
    expect(ids(reachedResources(selection, rows, isSelf))).toEqual(['a', 'b']);
    expect(reachesLaterResources(selection)).toBe(false);
  });

  it('scope `all` with an empty list reaches nothing, whatever discovery found since', () => {
    const selection = { resourceScope: 'all', resourceIds: [] } as const;
    expect(reachedResources(selection, rows, isSelf)).toEqual([]);
    expect(reachesLaterResources(selection)).toBe(false);
  });

  it('scope `connection` reaches the live list: later resources included, hidden, stale and self excepted', () => {
    const selection = { resourceScope: 'connection', resourceIds: [] } as const;
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
});
