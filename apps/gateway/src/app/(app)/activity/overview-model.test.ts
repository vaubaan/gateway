import { describe, expect, it } from 'vitest';

import type { CatalogRisk } from '@/lib/missions/model';
import { formatBytes, percentOf } from '@/lib/vocabulary';

import {
  actionUsages,
  isRecordAddress,
  overviewHref,
  recordHref,
  timelineHref,
} from './overview-model';

function risk(riskId: string, baseId: string, label: string): CatalogRisk {
  return { risk_id: riskId, base_id: baseId, label } as CatalogRisk;
}

const catalog = {
  risks: [
    risk('github.read-code', 'github.read-code', 'Read code'),
    risk('github.read-issues', 'github.read-issues', 'Read issues'),
    risk('github.create-pr', 'github.create-pr', 'Open pull requests'),
  ],
  macro_actions: [
    {
      id: 'read',
      label: 'Read',
      description: '',
      entries: [
        { risk_id: 'github.read-code', quota: 1, rate_limit: { max: 1, window_seconds: 60 } },
        { risk_id: 'github.read-issues', quota: 1, rate_limit: { max: 1, window_seconds: 60 } },
      ],
    },
    {
      id: 'ship',
      label: 'Ship',
      description: '',
      entries: [
        { risk_id: 'github.create-pr', quota: 1, rate_limit: { max: 1, window_seconds: 60 } },
      ],
    },
    { id: 'admin', label: 'Administer', description: '', entries: [] },
  ],
};

describe('actionUsages', () => {
  it('groups the lines by action, the gauge on the line closest to its limit', () => {
    const usages = actionUsages(
      {
        lines: [
          {
            risk_id: 'github.read-code',
            resource_set_id: 's1',
            quota: 100,
            used: 30,
            gate: 'auto',
          },
          {
            risk_id: 'github.read-issues',
            resource_set_id: 's1',
            quota: 10,
            used: 9,
            gate: 'auto',
          },
          {
            risk_id: 'github.create-pr',
            resource_set_id: 's1',
            quota: 5,
            used: 0,
            gate: 'approval',
          },
          // A permission the catalog no longer knows belongs to no action.
          { risk_id: 'github.gone', resource_set_id: 's1', quota: 5, used: 5, gate: 'auto' },
        ],
      },
      catalog,
    );
    expect(usages.map((u) => [u.id, u.top.riskId, u.top.used, u.top.quota])).toEqual([
      ['read', 'github.read-issues', 9, 10],
      ['ship', 'github.create-pr', 0, 5],
    ]);
    expect(usages[0]?.lines).toHaveLength(2);
  });

  it('shows nothing for a mission with no current period', () => {
    expect(
      actionUsages(
        {
          lines: [
            {
              risk_id: 'github.read-code',
              resource_set_id: 's1',
              quota: 5,
              used: null,
              gate: 'auto',
            },
          ],
        },
        catalog,
      ),
    ).toEqual([]);
  });
});

describe('the links of the Overview', () => {
  const from = '2026-11-08T15:30:00.000Z';

  it('opens the Record on the calls a number counts', () => {
    const url = new URL(
      recordHref({
        mission: 'mis_1',
        from,
        account: 'acc_1',
        holder: { kind: 'named', key: 'ci', label: 'ci' },
        decision: 'refused',
      }),
      'http://gateway.test',
    );
    expect(url.pathname).toBe('/activity/record');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      mission: 'mis_1',
      kind: 'call',
      account: 'acc_1',
      holder: 'named:ci',
      decision: 'refused',
      from,
    });
  });

  it('opens the Timeline of a mission, and of one key holder', () => {
    expect(timelineHref('mis_1')).toBe('/activity/timeline?mission=mis_1');
    expect(timelineHref('mis_1', { kind: 'member', key: 'usr_1', label: 'a@b.c' })).toBe(
      '/activity/timeline?mission=mis_1&holder=member%3Ausr_1',
    );
    expect(overviewHref('30d')).toBe('/activity?period=30d');
  });

  it('sends an older address of the Record on, never the Overview’s own', () => {
    expect(isRecordAddress({ mission: 'mis_1' })).toBe(true);
    expect(isRecordAddress({ period: 'today', decision: 'refused' })).toBe(true);
    expect(isRecordAddress({ period: '30d' })).toBe(false);
    expect(isRecordAddress({})).toBe(false);
  });
});

describe('the units of the Overview', () => {
  it('writes bytes in decimal units, one decimal under ten', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1_234)).toBe('1.2 KB');
    expect(formatBytes(34_400_000)).toBe('34 MB');
    expect(formatBytes(2_500_000_000)).toBe('2.5 GB');
    expect(formatBytes(999_960)).toBe('1 MB');
    expect(formatBytes(-5)).toBe('0 B');
  });

  it('writes a share as a whole percentage', () => {
    expect(percentOf(5 / 6)).toBe('83%');
    expect(percentOf(0)).toBe('0%');
  });
});
