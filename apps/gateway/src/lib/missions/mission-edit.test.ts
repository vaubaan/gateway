/**
 * `judgeEdit` — the creation's preview kept on what an edit moves (ADR
 * mission-editable-after-issuance, the table of point 4) — and the revision.
 */
import type { MissionPolicyEntry } from '@vaubaan/shared';
import { describe, expect, it } from 'vitest';

import {
  describeMissionChange,
  diffSnapshots,
  draftOfSnapshot,
  hasChanges,
  judgeEdit,
  missionRevision,
  type MissionSnapshot,
  type MissionSnapshotAccount,
} from './mission-edit';
import type { DraftAccount, MissionDraft } from './model';
import { previewDraft } from './preview';
import { ACME_RESOURCES, ACME_STALE, acmeAccount } from '../../../tests/support/missions/testing';

const NOW = new Date('2026-10-24T09:00:00.000Z');

const line = (
  risk_id: string,
  quota = 10,
  gate: 'auto' | 'approval' = 'auto',
): MissionPolicyEntry => ({
  risk_id,
  quota,
  rate_limit: { max: 10, window_seconds: 60 },
  gate,
});

/** The one resource set of the mission's account. */
const SET = 'set-1';
/** An account of the snapshot with one resource set. */
function account(
  c: Omit<MissionSnapshotAccount, 'resource_sets'> & {
    readonly resource_ids: readonly string[];
    readonly future?: boolean;
    readonly env?: string | null;
    readonly policy: readonly MissionPolicyEntry[];
    readonly trust_levels?: Readonly<Record<string, string>>;
    readonly set?: string;
  },
): MissionSnapshotAccount {
  const { resource_ids, future = false, env = null, policy, trust_levels, set = SET, ...rest } = c;
  return {
    ...rest,
    resource_sets: [
      {
        key: set,
        id: set,
        position: 1,
        resource_ids,
        future,
        env,
        policy: policy.map((p) => ({ ...p, resource_set_id: set })),
        ...(trust_levels ? { trust_levels } : {}),
      },
    ],
  };
}

const BEFORE: MissionSnapshot = {
  name: 'Ship it',
  expires_at: null,
  period: { kind: 'recurring', length_seconds: 86_400 },
  accounts: [
    account({
      account_id: 'conn-acme',
      service: 'acme',
      display_name: 'Acme main',
      resource_ids: ['res-app-staging'],
      env: 'staging',
      policy: [line('acme.read'), line('acme[staging].write', 5)],
    }),
  ],
};

function contextWith(resources = ACME_RESOURCES, status = 'active') {
  return { accounts: [acmeAccount({ resources: [...resources], status })], now: NOW };
}

function edit(change: (c: DraftAccount) => DraftAccount, draft: Partial<MissionDraft> = {}) {
  const base = draftOfSnapshot(BEFORE);
  const [acme] = base.accounts;
  if (!acme) throw new Error('fixture');
  return { ...base, ...draft, accounts: [change(acme)] };
}

describe('judgeEdit', () => {
  it('sends the mission back unchanged: no change, no issue', () => {
    const judged = judgeEdit(contextWith(), BEFORE, draftOfSnapshot(BEFORE));
    expect(judged.ok).toBe(true);
    expect(hasChanges(judged.changes)).toBe(false);
    expect(judged.after).toEqual(BEFORE);
  });

  it('keeps a stale resource and judges a lowered limit as it is', () => {
    const stale = { ...ACME_RESOURCES[0]!, stale: true };
    const context = contextWith([stale, ...ACME_RESOURCES.slice(1)]);
    const draft = edit((c) => ({
      ...c,
      policy: [line('acme.read', 3), line('acme[staging].write', 5)],
    }));
    // A creation refuses the stale resource; the edit does not move it.
    expect(previewDraft(context, draft).issues.map((i) => i.code)).toContain('resource-stale');
    const judged = judgeEdit(context, BEFORE, draft);
    expect(judged.issues).toEqual([]);
    expect(judged.after.accounts[0]?.resource_sets[0]?.resource_ids).toEqual(['res-app-staging']);
    expect(judged.changes.permissions_changed.map((c) => c.risk_id)).toEqual(['acme.read']);
  });

  it('refuses an added stale resource with the creation’s words', () => {
    const context = contextWith([...ACME_RESOURCES, ACME_STALE]);
    const draft = edit((c) => ({
      ...c,
      resources: { scope: 'selected', resource_ids: ['res-app-staging', ACME_STALE.id] },
    }));
    const judged = judgeEdit(context, BEFORE, draft);
    expect(judged.ok).toBe(false);
    expect(judged.issues).toEqual(
      previewDraft(context, draft).issues.filter((i) => i.code === 'resource-stale'),
    );
  });

  it('does not let an account that needs reconnecting refuse a narrowing, but refuses a widening', () => {
    const context = contextWith(ACME_RESOURCES, 'needs-reconnect');
    const lower = edit((c) => ({
      ...c,
      policy: [line('acme.read', 2), line('acme[staging].write', 5)],
    }));
    expect(judgeEdit(context, BEFORE, lower).ok).toBe(true);
    const raise = edit((c) => ({
      ...c,
      policy: [line('acme.read', 20), line('acme[staging].write', 5)],
    }));
    expect(judgeEdit(context, BEFORE, raise).issues.map((i) => i.code)).toEqual([
      'account-unavailable',
    ]);
  });

  it('judges an added permission like a creation: outside the authority is refused', () => {
    const context = {
      accounts: [acmeAccount({ authority: ['acme.read', 'acme[staging].write'] })],
      now: NOW,
    };
    const draft = edit((c) => ({ ...c, policy: [...(c.policy ?? []), line('acme.admin')] }));
    const judged = judgeEdit(context, BEFORE, draft);
    expect(judged.issues).toEqual(
      previewDraft(context, draft).issues.filter((i) => i.code === 'exceeds-authority'),
    );
  });

  it('changes a gate alone without judging the line again', () => {
    const context = { accounts: [acmeAccount({ authority: [] })], now: NOW };
    const draft = edit((c) => ({
      ...c,
      policy: [line('acme.read', 10, 'approval'), line('acme[staging].write', 5)],
    }));
    // The creator holds nothing any more: a gate is not what a share restricts.
    const judged = judgeEdit(context, BEFORE, draft);
    expect(judged.ok).toBe(true);
    expect(judged.after.accounts[0]?.resource_sets[0]?.policy[0]?.gate).toBe('approval');
  });

  it('refuses another period, and a past end date only when the end moves', () => {
    const period = judgeEdit(contextWith(), BEFORE, {
      ...draftOfSnapshot(BEFORE),
      period: { kind: 'one-off' },
    });
    expect(period.issues.map((i) => i.code)).toEqual(['period-not-editable']);
    const expired = { ...BEFORE, expires_at: '2026-10-01T00:00:00.000Z' };
    expect(judgeEdit(contextWith(), expired, draftOfSnapshot(expired)).ok).toBe(true);
    const past = judgeEdit(contextWith(), expired, {
      ...draftOfSnapshot(expired),
      expires_at: '2026-10-02T00:00:00.000Z',
    });
    expect(past.issues.map((i) => i.code)).toEqual(['invalid-expiry']);
  });

  it('refuses an account left with no permission, with the creation’s words', () => {
    const judged = judgeEdit(
      contextWith(),
      BEFORE,
      edit((c) => ({ ...c, policy: [] })),
    );
    expect(judged.issues.map((i) => i.code)).toEqual(['no-accepted-risk']);
  });

  it('removes an account the draft leaves out, and lists it', () => {
    const judged = judgeEdit(
      contextWith(),
      {
        ...BEFORE,
        accounts: [
          ...BEFORE.accounts,
          account({
            account_id: 'conn-gone',
            service: 'other',
            display_name: 'Gone',
            resource_ids: [],
            policy: [line('other.read')],
            set: 'set-gone',
          }),
        ],
      },
      draftOfSnapshot(BEFORE),
    );
    expect(judged.ok).toBe(true);
    expect(judged.changes.accounts_removed.map((c) => c.account_id)).toEqual(['conn-gone']);
    expect(judged.changes.permissions_removed.map((p) => p.risk_id)).toEqual(['other.read']);
  });
});

describe('the revision and the words of an edit', () => {
  it('does not depend on the order of rows, and moves with any editable value', () => {
    const [only] = BEFORE.accounts[0]!.resource_sets;
    const reordered: MissionSnapshot = {
      ...BEFORE,
      accounts: [
        {
          ...BEFORE.accounts[0]!,
          resource_sets: [{ ...only!, policy: [...only!.policy].reverse() }],
        },
      ],
    };
    expect(missionRevision(reordered)).toBe(missionRevision(BEFORE));
    expect(missionRevision({ ...BEFORE, name: 'Other' })).not.toBe(missionRevision(BEFORE));
  });

  it('says an edit in one sentence', () => {
    const after: MissionSnapshot = {
      ...BEFORE,
      accounts: [
        account({
          account_id: 'conn-acme',
          service: 'acme',
          display_name: 'Acme main',
          resource_ids: ['res-app-staging', 'res-scratch'],
          policy: [line('acme.read', 50)],
        }),
      ],
    };
    const changes = diffSnapshots(BEFORE, after);
    expect(
      describeMissionChange({
        name_changed: false,
        expiry_changed: false,
        accounts_added: 0,
        accounts_removed: 0,
        resources_added: changes.resources.reduce((n, r) => n + r.added.length, 0),
        resources_removed: 0,
        scopes_changed: 0,
        permissions_added: [],
        permissions_removed: changes.permissions_removed.map((p) => p.risk_id),
        limits: [
          {
            risk_id: 'acme.read',
            quota_before: 10,
            quota: 50,
            rate_limit_max_before: 10,
            rate_limit_max: 10,
            rate_window_seconds_before: 60,
            rate_window_seconds: 60,
          },
        ],
        gates: [],
        requests_closed: 0,
      }),
    ).toBe(
      'Changed the mission: 1 resource added, 1 permission removed, quota of acme.read 10 → 50',
    );
  });
});
