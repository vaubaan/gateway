/**
 * The versions of a mission's configuration (spec §4.2 "History"): sameness, the
 * changes a version is listed with, the detail lines, and the restore bounded by the
 * creator's authority now.
 */
import type { RiskId } from '@vaubaan/shared';
import { describe, expect, it } from 'vitest';

import { hasChanges, type MissionSnapshot } from './mission-edit';
import {
  canonicalConfig,
  changesBetween,
  judgeRestore,
  sameConfig,
  snapshotOfConfig,
  versionChanges,
  versionDetailLines,
  type MissionVersionConfig,
  type MissionVersionLine,
} from './versions';
import { ACME_RESOURCES, acmeAccount } from '../../../tests/support/missions/testing';

const NOW = new Date('2026-11-15T09:00:00.000Z');

const line = (
  risk_id: string,
  quota = 10,
  gate: 'auto' | 'approval' = 'auto',
  resource_set_id = 'set-1',
): MissionVersionLine => ({
  resource_set_id,
  risk_id,
  quota,
  rate_limit: { max: 10, window_seconds: 60 },
  gate,
});

const V1: MissionVersionConfig = {
  name: 'Ship it',
  expires_at: null,
  period: { kind: 'recurring', length_seconds: 86_400 },
  accounts: [
    {
      account_id: 'conn-acme',
      resource_sets: [
        {
          id: 'set-1',
          position: 1,
          future: false,
          env: 'staging',
          mixed_env: false,
          resource_ids: ['res-app-staging'],
          trust_levels: {},
        },
      ],
    },
  ],
  policy: [line('acme.read'), line('acme[staging].write', 5)],
};

/** V1 with one more permission and a lower quota. */
const V2: MissionVersionConfig = {
  ...V1,
  policy: [
    line('acme.read', 3),
    line('acme[staging].write', 5),
    line('acme[staging].bulk-delete', 1),
  ],
};

const WORDS = {
  riskLabel: (id: RiskId) => `label of ${id}`,
  resourceName: (_account: string, id: string) =>
    ACME_RESOURCES.find((r) => r.id === id)?.display_name ?? id,
};

const names = () => ({ service: 'acme', display_name: 'Acme main' });

/** The mission as it stands now: V2. */
const CURRENT: MissionSnapshot = snapshotOfConfig(V2, names);

describe('sameness', () => {
  it('ignores the order of rows and of resource ids', () => {
    const shuffled: MissionVersionConfig = {
      ...V2,
      policy: [...V2.policy].reverse(),
      accounts: V2.accounts.map((c) => ({
        ...c,
        resource_sets: c.resource_sets.map((s) => ({ ...s, resource_ids: [...s.resource_ids] })),
      })),
    };
    expect(sameConfig(V2, shuffled)).toBe(true);
    expect(canonicalConfig(V2)).toBe(canonicalConfig(shuffled));
  });

  it('reads one instant written two ways as the same end', () => {
    const a = { ...V1, expires_at: '2027-01-01T00:00:00.000Z' };
    const b = { ...V1, expires_at: '2027-01-01T00:00:00Z' };
    expect(sameConfig(a, b)).toBe(true);
  });

  it('tells a moved trust level apart, though it is no change of an edit', () => {
    const levelled: MissionVersionConfig = {
      ...V1,
      accounts: V1.accounts.map((c) => ({
        ...c,
        resource_sets: c.resource_sets.map((s) => ({ ...s, trust_levels: { read: 'careful' } })),
      })),
    };
    expect(sameConfig(V1, levelled)).toBe(false);
    expect(hasChanges(changesBetween(V1, levelled))).toBe(false);
  });
});

describe('the changes a version is listed with', () => {
  it('is null for a first version', () => {
    expect(versionChanges(null, V1)).toBeNull();
  });

  it('is the summary of a mission-changed event between two versions', () => {
    const changes = versionChanges(V1, V2);
    expect(changes?.permissions_added).toEqual(['acme[staging].bulk-delete']);
    expect(changes?.limits.map((l) => [l.risk_id, l.quota_before, l.quota])).toEqual([
      ['acme.read', 10, 3],
    ]);
    expect(changes?.requests_closed).toBe(0);
  });

  it('words each change on its own line, resources by name', () => {
    const v3: MissionVersionConfig = {
      ...V2,
      name: 'Ship it now',
      expires_at: '2027-01-01T00:00:00.000Z',
      accounts: V2.accounts.map((c) => ({
        ...c,
        resource_sets: c.resource_sets.map((s) => ({
          ...s,
          resource_ids: [],
          future: true,
        })),
      })),
      policy: [line('acme.read', 3, 'approval')],
    };
    const lines = versionDetailLines(changesBetween(V2, v3, names), WORDS);
    expect(lines).toEqual([
      'Renamed from “Ship it” to “Ship it now”',
      'Ends: never → 2027-01-01',
      'Acme main, resource set 1: removed App (staging)',
      'Acme main, resource set 1: takes new resources from now on',
      'Permission removed: label of acme[staging].write',
      'Permission removed: label of acme[staging].bulk-delete',
      'label of acme.read: 3 per period, 10 per 60s, runs freely → 3 per period, 10 per 60s, asks first',
    ]);
  });
});

describe('judgeRestore', () => {
  it('brings a past version back, the mission keeping its set and its period', () => {
    const restored = judgeRestore({ accounts: [acmeAccount()], now: NOW }, CURRENT, V1);
    expect(restored.judgement.ok).toBe(true);
    expect(restored.dropped).toEqual({
      accounts: [],
      resources: [],
      permissions: [],
      expiry_kept: false,
    });
    const set = restored.judgement.after.accounts[0]?.resource_sets[0];
    expect(set?.id).toBe('set-1');
    expect(set?.policy.map((p) => [p.risk_id, p.quota])).toEqual([
      ['acme.read', 10],
      ['acme[staging].write', 5],
    ]);
    expect(restored.judgement.changes.permissions_removed.map((p) => p.risk_id)).toEqual([
      'acme[staging].bulk-delete',
    ]);
  });

  it('leaves out a permission the creator no longer holds, and says so', () => {
    const narrow = acmeAccount({ authority: ['acme.read'] });
    const restored = judgeRestore({ accounts: [narrow], now: NOW }, CURRENT, V1);
    expect(restored.dropped.permissions).toEqual([
      { account_id: 'conn-acme', risk_id: 'acme[staging].write' },
    ]);
    expect(restored.draft.accounts[0]?.policy?.map((p) => p.risk_id)).toEqual(['acme.read']);
  });

  it('leaves out a resource that no longer exists, and says so', () => {
    const without = acmeAccount({
      resources: ACME_RESOURCES.filter((r) => r.id !== 'res-app-staging'),
    });
    const restored = judgeRestore({ accounts: [without], now: NOW }, CURRENT, V1);
    expect(restored.dropped.resources).toEqual([
      { account_id: 'conn-acme', resource_id: 'res-app-staging' },
    ]);
    const resources = restored.draft.accounts[0]?.resources;
    expect(resources).toEqual({ scope: 'selected', resource_ids: [] });
  });

  it('leaves out a resource no longer discovered', () => {
    const stale = acmeAccount({
      resources: ACME_RESOURCES.map((r) =>
        r.id === 'res-app-staging' ? { ...r, stale: true } : r,
      ),
    });
    const restored = judgeRestore({ accounts: [stale], now: NOW }, CURRENT, V1);
    expect(restored.dropped.resources.map((r) => r.resource_id)).toEqual(['res-app-staging']);
  });

  it('leaves out an account the creator no longer holds, or that is revoked', () => {
    const revoked = judgeRestore(
      { accounts: [acmeAccount({ status: 'revoked' })], now: NOW },
      CURRENT,
      V1,
    );
    expect(revoked.dropped.accounts).toEqual(['conn-acme']);
    expect(revoked.draft.accounts).toEqual([]);
    expect(revoked.judgement.ok).toBe(false);
    const gone = judgeRestore({ accounts: [], now: NOW }, CURRENT, V1);
    expect(gone.dropped.accounts).toEqual(['conn-acme']);
  });

  it('keeps the current end when the version’s has passed', () => {
    const ended = { ...V1, expires_at: '2026-01-01T00:00:00.000Z' };
    const current = { ...CURRENT, expires_at: '2027-06-01T00:00:00.000Z' };
    const restored = judgeRestore({ accounts: [acmeAccount()], now: NOW }, current, ended);
    expect(restored.dropped.expiry_kept).toBe(true);
    expect(restored.draft.expires_at).toBe('2027-06-01T00:00:00.000Z');
    const future = { ...V1, expires_at: '2027-03-01T00:00:00.000Z' };
    const kept = judgeRestore({ accounts: [acmeAccount()], now: NOW }, current, future);
    expect(kept.dropped.expiry_kept).toBe(false);
    expect(kept.draft.expires_at).toBe('2027-03-01T00:00:00.000Z');
  });

  it('restores the version that is already the configuration as no change', () => {
    const restored = judgeRestore({ accounts: [acmeAccount()], now: NOW }, CURRENT, V2);
    expect(restored.judgement.ok).toBe(true);
    expect(hasChanges(restored.judgement.changes)).toBe(false);
  });
});
