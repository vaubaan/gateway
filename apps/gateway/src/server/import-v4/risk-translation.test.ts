import githubPlugin from '@vaubaan/plugin-github';
import type { ServicePlugin } from '@vaubaan/plugin-sdk';
import supabasePlugin from '@vaubaan/plugin-supabase';
import vercelPlugin from '@vaubaan/plugin-vercel';
import { describe, expect, it } from 'vitest';

import { budgetAtTrustLevel, rowOf, TRUST_LEVEL_GATES } from '@vaubaan/policy-engine';

import { enumerateCatalog } from '../../lib/missions/catalog-view';
import { macroActionsOf } from '../../lib/missions/macro-actions';
import {
  IMPORT_TRUST_LEVEL,
  serviceOfV4Risk,
  translateRisks,
  unbindingRateLimit,
  type TranslatableAccount,
} from './risk-translation';

function accountOf(plugin: ServicePlugin, authority?: readonly string[]): TranslatableAccount {
  const risks = enumerateCatalog(plugin.catalog);
  return {
    risks,
    derives_env: typeof plugin.envOf === 'function',
    macro_actions: macroActionsOf(plugin.catalog),
    authority: authority ?? risks.map((r) => r.risk_id),
  };
}

describe('v4 risk ids translated to the v5 catalog', () => {
  it('keeps an id the v5 catalog has, its macro-action base budget at Trusting as the line', () => {
    const github = accountOf(githubPlugin);
    const propose = github.macro_actions.find((a) => a.id === 'propose');
    const base = propose?.entries.find((e) => e.risk_id === 'github.create-pr');
    const risk = github.risks.find((r) => r.risk_id === 'github.create-pr');
    expect(base && risk).toBeTruthy();

    const t = translateRisks(['github.create-pr', 'github.read-code'], github, []);
    expect(t.dropped).toEqual([]);
    expect(t.entries.map((e) => e.risk_id)).toEqual(['github.create-pr', 'github.read-code']);
    expect(t.entries[0]).toMatchObject({
      ...budgetAtTrustLevel(base!, IMPORT_TRUST_LEVEL, risk!.rate_ceiling_per_minute),
      gate: TRUST_LEVEL_GATES[IMPORT_TRUST_LEVEL][rowOf(risk!.vector)],
      macroActionId: 'propose',
      from: 'github.create-pr',
    });
  });

  it('keeps the fallback in "Anything else", at its default base budget', () => {
    const t = translateRisks(['github.uncategorized-write'], accountOf(githubPlugin), []);
    expect(t.dropped).toEqual([]);
    expect(t.entries).toMatchObject([
      { risk_id: 'github.uncategorized-write', quota: 150, macroActionId: 'anything-else' },
    ]);
  });

  it('drops a risk in no macro-action: no budget is invented', () => {
    const bare = { ...accountOf(githubPlugin), macro_actions: [] };
    const t = translateRisks(['github.create-pr'], bare, []);
    expect(t.entries).toEqual([]);
    expect(t.dropped).toEqual([
      { v4RiskId: 'github.create-pr', reason: 'no-base-budget', v5RiskIds: ['github.create-pr'] },
    ]);
  });

  it('drops an id the v5 catalog does not know', () => {
    const t = translateRisks(['github.teleport'], accountOf(githubPlugin), []);
    expect(t.dropped).toEqual([
      { v4RiskId: 'github.teleport', reason: 'unknown-in-v5', v5RiskIds: [] },
    ]);
  });

  it('never widens an env-qualified v4 id to an account-scoped v5 one', () => {
    // v4 accepted `workflow-write-via-file` on feature branches only; v5 has one unscoped entry.
    const t = translateRisks(
      ['github[feature].workflow-write-via-file'],
      accountOf(githubPlugin),
      [],
    );
    expect(t.entries).toEqual([]);
    expect(t.dropped).toEqual([
      {
        v4RiskId: 'github[feature].workflow-write-via-file',
        reason: 'no-exact-env-counterpart',
        v5RiskIds: ['github.workflow-write-via-file'],
      },
    ]);
  });

  it('writes out an account-scoped v4 id per environment of the selected resources', () => {
    // v4: `supabase.migration-write` on every project; v5: env-scoped.
    const supabase = accountOf(supabasePlugin);
    const t = translateRisks(['supabase.migration-write'], supabase, [
      { env: 'staging' },
      { env: 'prod' },
    ]);
    expect(t.expanded).toEqual([
      {
        v4RiskId: 'supabase.migration-write',
        v5RiskIds: ['supabase[staging].migration-write', 'supabase[prod].migration-write'],
      },
    ]);
    expect(t.entries.map((e) => e.risk_id)).toEqual([
      'supabase[staging].migration-write',
      'supabase[prod].migration-write',
    ]);
    expect(new Set(t.entries.map((e) => e.macroActionId)).size).toBe(1);
  });

  it('drops an env-scoped risk no selected resource is labelled for', () => {
    const t = translateRisks(['supabase.migration-write'], accountOf(supabasePlugin), [
      { env: null },
    ]);
    expect(t.entries).toEqual([]);
    expect(t.dropped[0]).toMatchObject({
      v4RiskId: 'supabase.migration-write',
      reason: 'env-unresolvable',
    });
  });

  it('keeps an exact env-qualified id that a selected resource resolves', () => {
    const t = translateRisks(['supabase[staging].migration-write'], accountOf(supabasePlugin), [
      { env: 'staging' },
    ]);
    expect(t.entries.map((e) => e.risk_id)).toEqual(['supabase[staging].migration-write']);
    const none = translateRisks(['supabase[staging].migration-write'], accountOf(supabasePlugin), [
      { env: 'prod' },
    ]);
    expect(none.dropped[0]!.reason).toBe('env-unresolvable');
  });

  it('resolves the environments of a plugin that derives them from the call', () => {
    // Vercel reads the environment from the call: no labelled resource is needed.
    const vercel = accountOf(vercelPlugin);
    const scoped = vercel.risks.find((r) => r.env !== null);
    expect(scoped).toBeDefined();
    const t = translateRisks([scoped!.risk_id], vercel, [{ env: null }]);
    expect(t.dropped.filter((d) => d.reason === 'env-unresolvable')).toEqual([]);
  });

  it('drops what lies outside the authority on the account', () => {
    const github = accountOf(githubPlugin, ['github.read-code']);
    const t = translateRisks(['github.read-code', 'github.create-pr'], github, []);
    expect(t.entries.map((e) => e.risk_id)).toEqual(['github.read-code']);
    expect(t.dropped).toEqual([
      {
        v4RiskId: 'github.create-pr',
        reason: 'outside-authority',
        v5RiskIds: ['github.create-pr'],
      },
    ]);
  });

  it('drops what v4 denied, even when it was also accepted', () => {
    const t = translateRisks(
      ['github.read-code', 'github.create-pr'],
      accountOf(githubPlugin),
      [],
      ['github.create-pr'],
    );
    expect(t.entries.map((e) => e.risk_id)).toEqual(['github.read-code']);
    expect(t.dropped).toEqual([
      { v4RiskId: 'github.create-pr', reason: 'denied-in-v4', v5RiskIds: [] },
    ]);
  });

  it('drops the written-out environment a v4 denial names, by id or by base id', () => {
    const supabase = accountOf(supabasePlugin);
    const both = [{ env: 'staging' }, { env: 'prod' }];
    const byEnv = translateRisks(['supabase.migration-write'], supabase, both, [
      'supabase[prod].migration-write',
    ]);
    expect(byEnv.entries.map((e) => e.risk_id)).toEqual(['supabase[staging].migration-write']);
    expect(byEnv.dropped).toEqual([
      {
        v4RiskId: 'supabase.migration-write',
        reason: 'denied-in-v4',
        v5RiskIds: ['supabase[prod].migration-write'],
      },
    ]);
    const byBase = translateRisks(['supabase[staging].migration-write'], supabase, both, [
      'supabase.migration-write',
    ]);
    expect(byBase.entries).toEqual([]);
    expect(byBase.dropped[0]!.reason).toBe('denied-in-v4');
  });

  it('counts a duplicated v4 id once', () => {
    const t = translateRisks(['github.read-code', 'github.read-code'], accountOf(githubPlugin), []);
    expect(t.entries).toHaveLength(1);
  });

  it('every kept entry is explicit: an id of the catalog with a numeric quota', () => {
    const supabase = accountOf(supabasePlugin);
    const all = (supabasePlugin.catalog.risks ?? []).map((r) => r.id);
    const t = translateRisks(all, supabase, [
      { env: 'staging' },
      { env: 'prod' },
      { env: 'preview' },
    ]);
    const ids = new Set(supabase.risks.map((r) => r.risk_id));
    for (const entry of t.entries) {
      expect(ids.has(entry.risk_id)).toBe(true);
      expect(entry.risk_id).not.toMatch(/\*/);
      expect(Number.isFinite(entry.quota)).toBe(true);
    }
  });
});

describe('helpers', () => {
  it('reads the service of a v4 id', () => {
    expect(serviceOfV4Risk('supabase[prod].auth.user-write-one')).toBe('supabase');
    expect(serviceOfV4Risk('cloudflare-dns.record-write')).toBe('cloudflare-dns');
    expect(serviceOfV4Risk('not a risk')).toBeNull();
  });
});

describe('--carry-unbudgeted: risks no macro-action budgets, kept under approval', () => {
  const carry = { quota: 5 };

  it('keeps the risk with the given quota, the approval gate and no binding rate', () => {
    const github = { ...accountOf(githubPlugin), macro_actions: [] };
    const t = translateRisks(['github.uncategorized-write'], github, [], [], carry);
    expect(t.dropped).toEqual([]);
    expect(t.carried).toEqual([
      { v4RiskId: 'github.uncategorized-write', v5RiskId: 'github.uncategorized-write' },
    ]);
    const risk = github.risks.find((r) => r.risk_id === 'github.uncategorized-write')!;
    expect(t.entries).toEqual([
      {
        risk_id: 'github.uncategorized-write',
        quota: 5,
        rate_limit: unbindingRateLimit(5, risk),
        gate: 'approval',
        from: 'github.uncategorized-write',
        macroActionId: null,
      },
    ]);
  });

  it('carries an env-qualified risk with an exact v5 counterpart', () => {
    const supabase = { ...accountOf(supabasePlugin), macro_actions: [] };
    const prod = supabase.risks.find((r) => r.env === 'prod' && !r.deprecated);
    expect(prod).toBeDefined();
    const t = translateRisks([prod!.risk_id], supabase, [{ env: 'prod' }], [], carry);
    expect(t.carried.map((c) => c.v5RiskId)).toEqual([prod!.risk_id]);
    expect(t.entries[0]).toMatchObject({ gate: 'approval', quota: 5 });
  });

  it('leaves a budgeted risk on its macro-action line, gate included', () => {
    const t = translateRisks(['github.create-pr'], accountOf(githubPlugin), [], [], carry);
    expect(t.carried).toEqual([]);
    expect(t.entries[0]!.macroActionId).toBe('propose');
  });

  it('lifts no other reason: authority, denial, unknown and widening still drop', () => {
    const github = accountOf(githubPlugin, ['github.read-code']);
    const t = translateRisks(
      [
        'github.uncategorized-write',
        'github.teleport',
        'github[feature].workflow-write-via-file',
        'github.read-code',
      ],
      github,
      [],
      ['github.read-code'],
      carry,
    );
    expect(t.entries).toEqual([]);
    expect(t.carried).toEqual([]);
    expect(t.dropped.map((d) => [d.v4RiskId, d.reason])).toEqual([
      ['github.uncategorized-write', 'outside-authority'],
      ['github.teleport', 'unknown-in-v5'],
      ['github[feature].workflow-write-via-file', 'no-exact-env-counterpart'],
      ['github.read-code', 'denied-in-v4'],
    ]);
  });

  it('holds the rate limit under the catalog ceiling, per minute', () => {
    expect(unbindingRateLimit(5, { rate_ceiling_per_minute: null })).toEqual({
      max: 5,
      window_seconds: 60,
    });
    expect(unbindingRateLimit(500, { rate_ceiling_per_minute: 30 })).toEqual({
      max: 30,
      window_seconds: 60,
    });
  });
});
