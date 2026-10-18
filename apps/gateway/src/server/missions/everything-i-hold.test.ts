/**
 * The built-in preset "Everything I hold on this account" (ADR
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
  findPreset,
  presetIdsOf,
  QUOTA_BY_LEVEL,
  RATE_BY_LEVEL,
} from './everything-i-hold';
import type { IssuanceConnection, IssuanceResource, MissionDraft } from './model';
import { budgetProblem, previewDraft } from './preview';
import { ACME_CATALOG, ACME_RESOURCES, acmeConnection } from './testing';

const NOW = new Date('2026-10-18T09:00:00.000Z');

function idsOf(connection: IssuanceConnection, selected: readonly IssuanceResource[]): RiskId[] {
  return everythingIHold(connection, selected).entries.map((e) => e.risk_id);
}

function draftWith(
  connection: IssuanceConnection,
  resources: MissionDraft['connections'][number]['resources'] = { scope: 'all' },
): MissionDraft {
  return {
    name: 'My own agents',
    connections: [{ connection_id: connection.id, preset: EVERYTHING_I_HOLD, resources }],
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
    const connection = acmeConnection();
    expect(idsOf(connection, ACME_RESOURCES)).toEqual([
      'acme.read',
      'acme[staging].write',
      'acme[prod].write',
      'acme[staging].bulk-delete',
      'acme.admin',
      'acme.uncategorized-write',
    ]);
    // Deprecated ids are held but left out, as "select all" and the plugin presets do.
    expect(connection.authority).toContain('acme.legacy-export');
  });

  it('is bounded by the authority: a share yields what it covers, nothing more', () => {
    const connection = acmeConnection({
      basis: 'share',
      authority: ['acme.read', 'acme[prod].write'],
    });
    expect(idsOf(connection, ACME_RESOURCES)).toEqual(['acme.read', 'acme[prod].write']);
    expect(idsOf(acmeConnection({ basis: 'share', authority: [] }), ACME_RESOURCES)).toEqual([]);
  });

  it('an env-qualified id only when a selected resource carries its label', () => {
    const connection = acmeConnection();
    expect(idsOf(connection, [byRef('scratch')])).toEqual([
      'acme.read',
      'acme.admin',
      'acme.uncategorized-write',
    ]);
    expect(idsOf(connection, [byRef('app-staging')])).toEqual([
      'acme.read',
      'acme[staging].write',
      'acme[staging].bulk-delete',
      'acme.admin',
      'acme.uncategorized-write',
    ]);
  });

  it('a resource that carries the connection default environment reaches its ids', () => {
    // The default is already applied to `resources[].env` (ADR connection-default-environment-label).
    const inherited: IssuanceResource = { ...byRef('scratch'), env: 'prod' };
    const connection = acmeConnection({ default_env: 'prod', resources: [inherited] });
    expect(idsOf(connection, [inherited])).toContain('acme[prod].write');
    expect(idsOf(connection, [inherited])).not.toContain('acme[staging].write');
  });

  it('a plugin that derives the environment from the call reaches every environment', () => {
    const connection = acmeConnection({ derives_env: true });
    expect(idsOf(connection, [])).toContain('acme[prod].write');
    expect(idsOf(connection, [])).toContain('acme[staging].bulk-delete');
  });

  it('budgets: rate at the catalog ceiling, else the largest preset rate, else by level; quota the largest preset quota, else by level', () => {
    const connection = acmeConnection();
    const byId = new Map(
      everythingIHold(connection, ACME_RESOURCES).entries.map((e) => [e.risk_id, e]),
    );
    const risks = new Map(connection.risks.map((r) => [r.risk_id, r]));
    // Two presets name it: the largest quota (developer 1000) and rate (120/min) win.
    expect(byId.get('acme.read')).toMatchObject({
      quota: 1000,
      rate_limit: { max: 120, window_seconds: 60 },
      gate: 'auto',
    });
    // Named exactly by developer (200) and by its base id by writer (50).
    expect(byId.get('acme[staging].write')?.quota).toBe(200);
    expect(byId.get('acme[prod].write')).toMatchObject({
      quota: 50,
      rate_limit: { max: 10, window_seconds: 60 },
    });
    // The catalog ceiling (10/min) wins; no preset names it, so the quota is by level.
    const admin = risks.get('acme.admin');
    expect(byId.get('acme.admin')).toMatchObject({
      rate_limit: { max: 10, window_seconds: 60 },
      quota: admin ? QUOTA_BY_LEVEL[admin.level] : -1,
    });
    // The fallback is in no preset: both by level.
    const fallback = risks.get('acme.uncategorized-write');
    expect(byId.get('acme.uncategorized-write')).toMatchObject({
      quota: fallback ? QUOTA_BY_LEVEL[fallback.level] : -1,
      rate_limit: { max: fallback ? RATE_BY_LEVEL[fallback.level] : -1, window_seconds: 60 },
      gate: 'auto',
    });
    // Every line passes the issuance budget check, ceilings included.
    for (const entry of byId.values()) {
      const risk = risks.get(entry.risk_id);
      expect(risk && budgetProblem(entry, risk), entry.risk_id).toBeNull();
    }
  });

  it('is offered after the plugin presets, and found by its id', () => {
    const connection = acmeConnection();
    expect(presetIdsOf(connection)).toEqual(['reader', 'developer', 'writer', EVERYTHING_I_HOLD]);
    expect(findPreset(connection, EVERYTHING_I_HOLD, ACME_RESOURCES)?.label).toBe(
      'Everything I hold on this account',
    );
    expect(findPreset(connection, 'developer', ACME_RESOURCES)?.id).toBe('developer');
    expect(findPreset(connection, 'everything', ACME_RESOURCES)).toBeUndefined();
  });

  it('never yields a wildcard, a pattern or a base id of an env-scoped risk', () => {
    const connection = acmeConnection({ derives_env: true });
    const explicit = new Set(connection.risks.map((r) => r.risk_id));
    for (const entry of everythingIHold(connection, []).entries) {
      expect(entry.risk_id).not.toMatch(/[*?]/);
      expect(explicit.has(entry.risk_id), entry.risk_id).toBe(true);
    }
  });
});

describe('everything I hold — the preview', () => {
  it('passes at once, and the policy is the explicit list, not the preset', () => {
    const connection = acmeConnection();
    const p = previewDraft({ connections: [connection], now: NOW }, draftWith(connection));
    expect(p.ok).toBe(true);
    expect(p.issues).toEqual([]);
    expect(p.policy).toEqual(everythingIHold(connection, ACME_RESOURCES).entries);
    expect(p.connections[0]?.skipped_from_preset).toEqual([]);
    expect(JSON.stringify(p.policy)).not.toContain(EVERYTHING_I_HOLD);
  });

  it('says what it wrote out: count, most severe, and the fallback by id', () => {
    const connection = acmeConnection();
    const p = previewDraft({ connections: [connection], now: NOW }, draftWith(connection));
    const notice = p.notices.find((n) => n.code === 'everything-i-hold-expanded');
    expect(notice?.connection_id).toBe(connection.id);
    expect(notice?.message).toContain('6 explicit risks');
    expect(notice?.message).toContain('Most severe: acme[staging].bulk-delete');
    expect(notice?.message).toContain('Includes the fallback acme.uncategorized-write');
    expect(notice?.risk_ids).toEqual(['acme.uncategorized-write']);
  });

  it('names the critical lines that run freely, without adding a gate', () => {
    const base = acmeConnection();
    // Make `acme.admin` critical: the notice must say so, the gate stays `auto`.
    const risks = base.risks.map((r) =>
      r.risk_id === 'acme.admin' ? { ...r, severity: 12, level: 'critical' as const } : r,
    );
    const connection = acmeConnection({ risks });
    const p = previewDraft({ connections: [connection], now: NOW }, draftWith(connection));
    const notice = p.notices.find((n) => n.code === 'everything-i-hold-expanded');
    expect(notice?.message).toContain('gate auto (no approval asked): acme.admin');
    expect(notice?.risk_ids).toEqual(['acme.admin', 'acme.uncategorized-write']);
    expect(p.policy.every((line) => line.gate === 'auto')).toBe(true);
  });

  it('follows the selection: a narrower one yields fewer lines, never an unresolvable one', () => {
    const connection = acmeConnection();
    const p = previewDraft(
      { connections: [connection], now: NOW },
      draftWith(connection, { scope: 'selected', resource_refs: ['scratch'] }),
    );
    expect(p.ok).toBe(true);
    expect(p.policy.map((l) => l.risk_id)).toEqual([
      'acme.read',
      'acme.admin',
      'acme.uncategorized-write',
    ]);
    expect(p.connections[0]?.unresolvable).toEqual([]);
  });

  it('a share holding nothing reachable accepts nothing, and says so', () => {
    const connection = acmeConnection({ basis: 'share', authority: ['acme[prod].write'] });
    const p = previewDraft(
      { connections: [connection], now: NOW },
      draftWith(connection, { scope: 'selected', resource_refs: ['app-staging'] }),
    );
    expect(p.ok).toBe(false);
    expect(p.issues.map((i) => i.code)).toEqual(['no-accepted-risk']);
  });

  it('as the budget source of an explicit policy, it fills the missing budgets', () => {
    const connection = acmeConnection();
    const p = previewDraft(
      { connections: [connection], now: NOW },
      {
        ...draftWith(connection),
        connections: [
          {
            connection_id: connection.id,
            preset: EVERYTHING_I_HOLD,
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

  it('an unknown preset names the built-in one among the known', () => {
    const connection = acmeConnection();
    const p = previewDraft(
      { connections: [connection], now: NOW },
      {
        ...draftWith(connection),
        connections: [{ connection_id: connection.id, preset: 'everything' }],
      },
    );
    expect(p.issues.find((i) => i.code === 'unknown-preset')?.message).toContain(EVERYTHING_I_HOLD);
  });
});

describe('expansionDigest', () => {
  it('counts the lines, names the most severe, the critical running freely and the fallback', () => {
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
    expect(digest.most_severe?.risk_id).toBe('acme[staging].bulk-delete');
    expect(digest.critical_auto).toEqual([]);
    expect(digest.fallback.map((r) => r.risk_id)).toEqual(['acme.uncategorized-write']);
  });
});
