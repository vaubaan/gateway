import githubPlugin from '@vaubaan/plugin-github';
import type { ProviderPlugin } from '@vaubaan/plugin-sdk';
import supabasePlugin from '@vaubaan/plugin-supabase';
import vercelPlugin from '@vaubaan/plugin-vercel';
import { describe, expect, it } from 'vitest';

import { enumerateCatalog } from '../missions/catalog-view';
import {
  isDeveloperLike,
  providerOfV4Risk,
  translateRisks,
  type TranslatableConnection,
} from './risk-translation';

function connectionOf(
  plugin: ProviderPlugin,
  authority?: readonly string[],
): TranslatableConnection {
  const risks = enumerateCatalog(plugin.catalog);
  return {
    risks,
    derives_env: typeof plugin.envOf === 'function',
    presets: plugin.catalog.presets ?? [],
    authority: authority ?? risks.map((r) => r.risk_id),
  };
}

describe('v4 risk ids translated to the v5 catalog', () => {
  it('keeps an id the v5 catalog has, with the developer preset line as budget', () => {
    const github = connectionOf(githubPlugin);
    const developer = (githubPlugin.catalog.presets ?? []).find((p) => p.id === 'developer');
    const line = developer?.entries.find((e) => e.risk_id === 'github.create-pr');
    expect(line).toBeDefined();

    const t = translateRisks(['github.create-pr', 'github.read-code'], github, []);
    expect(t.dropped).toEqual([]);
    expect(t.entries.map((e) => e.risk_id)).toEqual(['github.create-pr', 'github.read-code']);
    const createPr = t.entries[0]!;
    expect(createPr).toMatchObject({
      quota: line!.quota,
      rate_limit: line!.rate_limit,
      gate: line!.gate,
      presetId: 'developer',
      from: 'github.create-pr',
    });
  });

  it('takes the budget from another preset when no developer-like one carries the risk', () => {
    const github = connectionOf(githubPlugin);
    const inDeveloper = new Set(
      (githubPlugin.catalog.presets ?? [])
        .filter((p) => isDeveloperLike(p.id))
        .flatMap((p) => p.entries.map((e) => e.risk_id)),
    );
    const elsewhere = (githubPlugin.catalog.presets ?? [])
      .filter((p) => !isDeveloperLike(p.id))
      .flatMap((p) => p.entries.map((e) => ({ preset: p.id, risk: e.risk_id })))
      .find((e) => !inDeveloper.has(e.risk));
    expect(elsewhere).toBeDefined();

    const t = translateRisks([elsewhere!.risk], github, []);
    expect(t.entries).toHaveLength(1);
    expect(t.entries[0]!.presetId).toBe(elsewhere!.preset);
  });

  it('drops the fallback: no preset gives it a budget, and none is invented', () => {
    const t = translateRisks(['github.uncategorized-write'], connectionOf(githubPlugin), []);
    expect(t.entries).toEqual([]);
    expect(t.dropped).toEqual([
      {
        v4RiskId: 'github.uncategorized-write',
        reason: 'no-preset-budget',
        v5RiskIds: ['github.uncategorized-write'],
      },
    ]);
  });

  it('drops an id the v5 catalog does not know', () => {
    const t = translateRisks(['github.teleport'], connectionOf(githubPlugin), []);
    expect(t.dropped).toEqual([
      { v4RiskId: 'github.teleport', reason: 'unknown-in-v5', v5RiskIds: [] },
    ]);
  });

  it('never widens an env-qualified v4 id to an account-scoped v5 one', () => {
    // v4 accepted `workflow-write-via-file` on feature branches only; v5 has one unscoped entry.
    const t = translateRisks(
      ['github[feature].workflow-write-via-file'],
      connectionOf(githubPlugin),
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
    const supabase = connectionOf(supabasePlugin);
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
    expect(t.entries.map((e) => [e.risk_id, e.presetId])).toEqual([
      ['supabase[staging].migration-write', 'staging-developer'],
      ['supabase[prod].migration-write', 'migration-operator'],
    ]);
  });

  it('drops an env-scoped risk no selected resource is labelled for', () => {
    const t = translateRisks(['supabase.migration-write'], connectionOf(supabasePlugin), [
      { env: null },
    ]);
    expect(t.entries).toEqual([]);
    expect(t.dropped[0]).toMatchObject({
      v4RiskId: 'supabase.migration-write',
      reason: 'env-unresolvable',
    });
  });

  it('keeps an exact env-qualified id that a selected resource resolves', () => {
    const t = translateRisks(['supabase[staging].migration-write'], connectionOf(supabasePlugin), [
      { env: 'staging' },
    ]);
    expect(t.entries.map((e) => e.risk_id)).toEqual(['supabase[staging].migration-write']);
    const none = translateRisks(
      ['supabase[staging].migration-write'],
      connectionOf(supabasePlugin),
      [{ env: 'prod' }],
    );
    expect(none.dropped[0]!.reason).toBe('env-unresolvable');
  });

  it('resolves the environments of a plugin that derives them from the call', () => {
    // Vercel reads the environment from the call: no labelled resource is needed.
    const vercel = connectionOf(vercelPlugin);
    const scoped = vercel.risks.find((r) => r.env !== null);
    expect(scoped).toBeDefined();
    const t = translateRisks([scoped!.risk_id], vercel, [{ env: null }]);
    expect(t.dropped.filter((d) => d.reason === 'env-unresolvable')).toEqual([]);
  });

  it('drops what lies outside the authority on the connection', () => {
    const github = connectionOf(githubPlugin, ['github.read-code']);
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
      connectionOf(githubPlugin),
      [],
      ['github.create-pr'],
    );
    expect(t.entries.map((e) => e.risk_id)).toEqual(['github.read-code']);
    expect(t.dropped).toEqual([
      { v4RiskId: 'github.create-pr', reason: 'denied-in-v4', v5RiskIds: [] },
    ]);
  });

  it('drops the written-out environment a v4 denial names, by id or by base id', () => {
    const supabase = connectionOf(supabasePlugin);
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
    const t = translateRisks(
      ['github.read-code', 'github.read-code'],
      connectionOf(githubPlugin),
      [],
    );
    expect(t.entries).toHaveLength(1);
  });

  it('every kept entry is explicit: an id of the catalog with a numeric quota', () => {
    const supabase = connectionOf(supabasePlugin);
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
  it('reads the provider of a v4 id', () => {
    expect(providerOfV4Risk('supabase[prod].auth.user-write-one')).toBe('supabase');
    expect(providerOfV4Risk('cloudflare-dns.record-write')).toBe('cloudflare-dns');
    expect(providerOfV4Risk('not a risk')).toBeNull();
  });

  it('recognises developer-like presets', () => {
    expect(isDeveloperLike('developer')).toBe(true);
    expect(isDeveloperLike('staging-developer')).toBe(true);
    expect(isDeveloperLike('read-only')).toBe(false);
    expect(isDeveloperLike('developers')).toBe(false);
  });
});
