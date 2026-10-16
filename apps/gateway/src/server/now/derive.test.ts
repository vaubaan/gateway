import { describe, expect, it } from 'vitest';

import { byLastActivity, nearestLimit } from './derive';

const label = (riskId: string): string => `label of ${riskId}`;

describe('nearestLimit', () => {
  it('is the permission whose usage is the largest share of its limit', () => {
    const nearest = nearestLimit(
      [
        { riskId: 'github.code-read', quota: 5000 },
        { riskId: 'github.write-feature-branch', quota: 3000 },
        { riskId: 'github.merge-protected', quota: 50 },
      ],
      {
        'github.code-read': 4000,
        'github.write-feature-branch': 1140,
        'github.merge-protected': 49,
      },
      label,
    );
    expect(nearest).toEqual({
      risk_id: 'github.write-feature-branch',
      label: 'label of github.write-feature-branch',
      used: 1860,
      limit: 3000,
    });
  });

  it('a permission never used counts as untouched, and ties go to the first listed', () => {
    expect(
      nearestLimit(
        [
          { riskId: 'a.first', quota: 10 },
          { riskId: 'a.second', quota: 10 },
        ],
        {},
        label,
      ),
    ).toMatchObject({ risk_id: 'a.first', used: 0, limit: 10 });
  });

  it('never reports more used than the limit, and a limit of zero is reached', () => {
    expect(nearestLimit([{ riskId: 'a.spent', quota: 2 }], { 'a.spent': -3 }, label)).toMatchObject(
      {
        used: 2,
        limit: 2,
      },
    );
    expect(
      nearestLimit(
        [
          { riskId: 'a.half', quota: 10 },
          { riskId: 'a.none', quota: 0 },
        ],
        { 'a.half': 5 },
        label,
      ),
    ).toMatchObject({ risk_id: 'a.none', used: 0, limit: 0 });
  });

  it('is null for an empty policy', () => {
    expect(nearestLimit([], {}, label)).toBeNull();
  });
});

describe('byLastActivity', () => {
  it('puts the most recently active first, then the never-called ones, newest first', () => {
    const rows = [
      { name: 'old, never called', last_activity_at: null, created_at: '2026-10-01T00:00:00.000Z' },
      {
        name: 'called yesterday',
        last_activity_at: '2026-10-12T10:00:00.000Z',
        created_at: '2026-09-01T00:00:00.000Z',
      },
      { name: 'new, never called', last_activity_at: null, created_at: '2026-10-12T00:00:00.000Z' },
      {
        name: 'called just now',
        last_activity_at: '2026-10-13T10:00:00.000Z',
        created_at: '2026-08-01T00:00:00.000Z',
      },
    ];
    expect(rows.sort(byLastActivity).map((row) => row.name)).toEqual([
      'called just now',
      'called yesterday',
      'new, never called',
      'old, never called',
    ]);
  });
});
