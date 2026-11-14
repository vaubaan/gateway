/**
 * The built-in "Everything I hold on this account" (ADR
 * preset-everything-i-hold-expands-explicitly): bounded by the authority,
 * env-qualified ids only when usable, budgets by one rule and within the
 * catalog ceilings, the fallback included and named, and a preview whose
 * policy is the explicit list.
 */
import type { RiskId } from '@vaubaan/shared';
import { describe, expect, it } from 'vitest';

import { enumerateCatalog } from './catalog-view';
import {
  EVERYTHING_I_HOLD,
  everythingIHold,
  expansionDigest,
  QUOTA_BY_ROW,
  RATE_BY_ROW,
} from './everything-i-hold';
import type { IssuanceAccount, IssuanceResource, MissionDraft } from './model';
import { budgetProblem, previewDraft } from './preview';
import { ACME_CATALOG, ACME_RESOURCES, acmeAccount } from '../../../tests/support/missions/testing';

const NOW = new Date('2026-10-18T09:00:00.000Z');

function idsOf(account: IssuanceAccount, selected: readonly IssuanceResource[]): RiskId[] {
  return everythingIHold(account, selected).entries.map((e) => e.risk_id);
}

function draftWith(
  account: IssuanceAccount,
  resources: MissionDraft['accounts'][number]['resources'] = { scope: 'all' },
): MissionDraft {
  return {
    name: 'My own agents',
    accounts: [{ account_id: account.id, everything_i_hold: true, resources }],
    period: { kind: 'recurring', length_seconds: 86_400 },
    expires_at: null,
  };
}

const byRef = (ref: string): IssuanceResource => {
  const found = ACME_RESOURCES.find((r) => r.ref === ref);
  if (!found) throw new Error(ref);
  return found;
};

describe('everything I hold — the expansion', () => {
  it('an owner gets every non-deprecated id the selected resources reach, the fallback included', () => {
    const account = acmeAccount();
    expect(idsOf(account, ACME_RESOURCES)).toEqual([
      'acme.read',
      'acme[staging].write',
      'acme[prod].write',
      'acme[staging].bulk-delete',
      'acme.admin',
      'acme.uncategorized-write',
    ]);
    // Deprecated ids are held but left out, as "select all" and the macro-actions do.
    expect(account.authority).toContain('acme.legacy-export');
  });

  it('is bounded by the authority: a share yields what it covers, nothing more', () => {
    const account = acmeAccount({
      basis: 'share',
      authority: ['acme.read', 'acme[prod].write'],
    });
    expect(idsOf(account, ACME_RESOURCES)).toEqual(['acme.read', 'acme[prod].write']);
    expect(idsOf(acmeAccount({ basis: 'share', authority: [] }), ACME_RESOURCES)).toEqual([]);
  });

  it('an env-qualified id only when a selected resource carries its label', () => {
    const account = acmeAccount();
    expect(idsOf(account, [byRef('scratch')])).toEqual([
      'acme.read',
      'acme.admin',
      'acme.uncategorized-write',
    ]);
    expect(idsOf(account, [byRef('app-staging')])).toEqual([
      'acme.read',
      'acme[staging].write',
      'acme[staging].bulk-delete',
      'acme.admin',
      'acme.uncategorized-write',
    ]);
  });

  it('a resource that carries the account default environment reaches its ids', () => {
    // The default is already applied to `resources[].env` (ADR connect-driver-and-resource-curation).
    const inherited: IssuanceResource = { ...byRef('scratch'), env: 'prod' };
    const account = acmeAccount({ default_env: 'prod', resources: [inherited] });
    expect(idsOf(account, [inherited])).toContain('acme[prod].write');
    expect(idsOf(account, [inherited])).not.toContain('acme[staging].write');
  });

  it('a plugin that derives the environment from the call reaches every environment', () => {
    const account = acmeAccount({ derives_env: true });
    expect(idsOf(account, [])).toContain('acme[prod].write');
    expect(idsOf(account, [])).toContain('acme[staging].bulk-delete');
  });

  it('budgets: the macro-action base budget at Autonomous, the rate at the catalog ceiling when it sets one; by level in no macro-action', () => {
    const account = acmeAccount();
    const byId = new Map(
      everythingIHold(account, ACME_RESOURCES).entries.map((e) => [e.risk_id, e]),
    );
    const risks = new Map(account.risks.map((r) => [r.risk_id, r]));
    // Base 100 a day, 60 a minute, ×10.
    expect(byId.get('acme.read')).toMatchObject({
      quota: 1000,
      rate_limit: { max: 600, window_seconds: 60 },
      gate: 'auto',
    });
    // An env-scoped risk takes its base id's entry in every environment.
    expect(byId.get('acme[staging].write')?.quota).toBe(1000);
    expect(byId.get('acme[prod].write')?.quota).toBe(1000);
    // The catalog ceiling (10/min) is the rate; the quota is the base ×10.
    expect(byId.get('acme.admin')).toMatchObject({
      quota: 50,
      rate_limit: { max: 10, window_seconds: 60 },
    });
    // The fallback is in "Anything else", at its default base budget.
    expect(byId.get('acme.uncategorized-write')).toMatchObject({
      quota: 500,
      rate_limit: { max: 100, window_seconds: 60 },
      gate: 'auto',
    });
    // A risk in no macro-action: by row.
    const lone = acmeAccount({ macro_actions: [] });
    const read = risks.get('acme.read');
    expect(
      everythingIHold(lone, ACME_RESOURCES).entries.find((e) => e.risk_id === 'acme.read'),
    ).toMatchObject({
      quota: read ? QUOTA_BY_ROW[read.row] : -1,
      rate_limit: { max: read ? RATE_BY_ROW[read.row] : -1, window_seconds: 60 },
    });
    // Every line passes the issuance budget check, ceilings included.
    for (const entry of byId.values()) {
      const risk = risks.get(entry.risk_id);
      expect(risk && budgetProblem(entry, risk), entry.risk_id).toBeNull();
    }
  });

  it('never yields a wildcard, a pattern or a base id of an env-scoped risk', () => {
    const account = acmeAccount({ derives_env: true });
    const explicit = new Set(account.risks.map((r) => r.risk_id));
    for (const entry of everythingIHold(account, []).entries) {
      expect(entry.risk_id).not.toMatch(/[*?]/);
      expect(explicit.has(entry.risk_id), entry.risk_id).toBe(true);
    }
  });
});

describe('everything I hold — the preview', () => {
  /** The labelled resources of one environment: "all" is then one resource set. */
  const STAGING = ACME_RESOURCES.filter((r) => r.env === 'staging');

  it('passes at once, and the policy is the explicit list, not "everything"', () => {
    const account = acmeAccount({ resources: STAGING });
    const p = previewDraft({ accounts: [account], now: NOW }, draftWith(account));
    expect(p.ok).toBe(true);
    expect(p.issues).toEqual([]);
    expect(p.policy).toEqual(everythingIHold(account, STAGING).entries);
    expect(p.accounts[0]?.left_out).toEqual([]);
    expect(JSON.stringify(p.policy)).not.toContain(EVERYTHING_I_HOLD);
  });

  it('says what it wrote out: count, the hardest to repair, and the fallback by id', () => {
    const account = acmeAccount({ resources: STAGING });
    const p = previewDraft({ accounts: [account], now: NOW }, draftWith(account));
    const notice = p.notices.find((n) => n.code === 'everything-i-hold-expanded');
    expect(notice?.account_id).toBe(account.id);
    expect(notice?.message).toContain(`${idsOf(account, STAGING).length} explicit risks`);
    expect(notice?.message).toContain(
      'The hardest to repair: acme[staging].bulk-delete (Cannot be repaired)',
    );
    expect(notice?.message).toContain('Includes the fallback acme.uncategorized-write');
    // The bulk delete cannot be repaired and runs freely here: named first.
    expect(notice?.risk_ids).toEqual(['acme[staging].bulk-delete', 'acme.uncategorized-write']);
  });

  it('names the lines that cannot be repaired and run freely, without adding a gate', () => {
    const base = acmeAccount();
    // Put `acme.admin` in row 4: the notice must say so, the gate stays `auto`.
    const risks = base.risks.map((r) =>
      r.risk_id === 'acme.admin'
        ? { ...r, row: 4 as const, row_reason: 'irreversible' as const }
        : r,
    );
    const account = acmeAccount({ risks });
    const p = previewDraft({ accounts: [account], now: NOW }, draftWith(account));
    const notice = p.notices.find((n) => n.code === 'everything-i-hold-expanded');
    expect(notice?.message).toContain(
      'Cannot be repaired, gate auto (no approval asked): acme[staging].bulk-delete, acme.admin.',
    );
    expect(notice?.risk_ids).toEqual([
      'acme[staging].bulk-delete',
      'acme.admin',
      'acme.uncategorized-write',
    ]);
    expect(p.policy.every((line) => line.gate === 'auto')).toBe(true);
  });

  it('follows the selection: a narrower one yields fewer lines, never an unresolvable one', () => {
    const account = acmeAccount();
    const p = previewDraft(
      { accounts: [account], now: NOW },
      draftWith(account, { scope: 'selected', resource_refs: ['app-prod'] }),
    );
    expect(p.ok).toBe(true);
    const prodOnly = idsOf(account, [byRef('app-prod')]);
    expect(p.policy.map((l) => l.risk_id)).toEqual(prodOnly);
    expect(prodOnly).not.toContain('acme[staging].write');
    expect(prodOnly.length).toBeLessThan(idsOf(account, ACME_RESOURCES).length);
    expect(p.accounts[0]?.unresolvable).toEqual([]);
  });

  it('a share holding nothing reachable accepts nothing, and says so', () => {
    const account = acmeAccount({ basis: 'share', authority: ['acme[prod].write'] });
    const p = previewDraft(
      { accounts: [account], now: NOW },
      draftWith(account, { scope: 'selected', resource_refs: ['app-staging'] }),
    );
    expect(p.ok).toBe(false);
    expect(p.issues.map((i) => i.code)).toEqual(['no-accepted-risk']);
  });

  it('as the budget source of an explicit policy, it fills the missing budgets', () => {
    const account = acmeAccount();
    const p = previewDraft(
      { accounts: [account], now: NOW },
      {
        ...draftWith(account),
        accounts: [
          {
            account_id: account.id,
            everything_i_hold: true,
            resources: { scope: 'selected', resource_refs: ['app-staging'] },
            policy: [{ risk_id: 'acme.admin' }],
          },
        ],
      },
    );
    expect(p.ok).toBe(true);
    expect(p.policy).toEqual([
      expect.objectContaining({
        risk_id: 'acme.admin',
        rate_limit: { max: 10, window_seconds: 60 },
      }),
    ]);
  });

  it('is asked by name only: `false` writes nothing on its own', () => {
    const account = acmeAccount();
    const p = previewDraft(
      { accounts: [account], now: NOW },
      {
        ...draftWith(account),
        accounts: [{ account_id: account.id, everything_i_hold: false }],
      },
    );
    expect(p.accounts[0]?.everything_i_hold).toBe(false);
    expect(p.policy).toEqual([]);
  });
});

describe('expansionDigest', () => {
  it('counts the lines, names the hardest to repair, those that cannot be repaired running freely and the fallback', () => {
    const risks = enumerateCatalog(ACME_CATALOG);
    const digest = expansionDigest(
      [
        { risk_id: 'acme.read', gate: 'auto' },
        { risk_id: 'acme[staging].bulk-delete', gate: 'approval' },
        { risk_id: 'acme.uncategorized-write', gate: 'auto' },
      ],
      risks,
    );
    expect(digest.count).toBe(3);
    expect(digest.hardest).toEqual({
      risk_id: 'acme[staging].bulk-delete',
      label: risks.find((r) => r.risk_id === 'acme[staging].bulk-delete')?.label,
      row: 4,
    });
    expect(digest.irreparable_auto).toEqual([]);
    expect(digest.fallback.map((r) => r.risk_id)).toEqual(['acme.uncategorized-write']);
  });
});
