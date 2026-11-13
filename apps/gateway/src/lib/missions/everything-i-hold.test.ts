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
import type { IssuanceConnection, IssuanceResource, MissionDraft } from './model';
import { budgetProblem, previewDraft } from './preview';
import {
  ACME_CATALOG,
  ACME_RESOURCES,
  acmeConnection,
} from '../../../tests/support/missions/testing';

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
    connections: [{ connection_id: connection.id, everything_i_hold: true, resources }],
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
    // Deprecated ids are held but left out, as "select all" and the macro-actions do.
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
    // The default is already applied to `resources[].env` (ADR connect-driver-and-resource-curation).
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

  it('budgets: the macro-action base budget at Autonomous, the rate at the catalog ceiling when it sets one; by level in no macro-action', () => {
    const connection = acmeConnection();
    const byId = new Map(
      everythingIHold(connection, ACME_RESOURCES).entries.map((e) => [e.risk_id, e]),
    );
    const risks = new Map(connection.risks.map((r) => [r.risk_id, r]));
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
    const lone = acmeConnection({ macro_actions: [] });
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
    const connection = acmeConnection({ derives_env: true });
    const explicit = new Set(connection.risks.map((r) => r.risk_id));
    for (const entry of everythingIHold(connection, []).entries) {
      expect(entry.risk_id).not.toMatch(/[*?]/);
      expect(explicit.has(entry.risk_id), entry.risk_id).toBe(true);
    }
  });
});

describe('everything I hold — the preview', () => {
  /** The labelled resources of one environment: "all" is then one resource set. */
  const STAGING = ACME_RESOURCES.filter((r) => r.env === 'staging');

  it('passes at once, and the policy is the explicit list, not "everything"', () => {
    const connection = acmeConnection({ resources: STAGING });
    const p = previewDraft({ connections: [connection], now: NOW }, draftWith(connection));
    expect(p.ok).toBe(true);
    expect(p.issues).toEqual([]);
    expect(p.policy).toEqual(everythingIHold(connection, STAGING).entries);
    expect(p.connections[0]?.left_out).toEqual([]);
    expect(JSON.stringify(p.policy)).not.toContain(EVERYTHING_I_HOLD);
  });

  it('says what it wrote out: count, the hardest to repair, and the fallback by id', () => {
    const connection = acmeConnection({ resources: STAGING });
    const p = previewDraft({ connections: [connection], now: NOW }, draftWith(connection));
    const notice = p.notices.find((n) => n.code === 'everything-i-hold-expanded');
    expect(notice?.connection_id).toBe(connection.id);
    expect(notice?.message).toContain(`${idsOf(connection, STAGING).length} explicit risks`);
    expect(notice?.message).toContain(
      'The hardest to repair: acme[staging].bulk-delete (Cannot be repaired)',
    );
    expect(notice?.message).toContain('Includes the fallback acme.uncategorized-write');
    // The bulk delete cannot be repaired and runs freely here: named first.
    expect(notice?.risk_ids).toEqual(['acme[staging].bulk-delete', 'acme.uncategorized-write']);
  });

  it('names the lines that cannot be repaired and run freely, without adding a gate', () => {
    const base = acmeConnection();
    // Put `acme.admin` in row 4: the notice must say so, the gate stays `auto`.
    const risks = base.risks.map((r) =>
      r.risk_id === 'acme.admin'
        ? { ...r, row: 4 as const, row_reason: 'irreversible' as const }
        : r,
    );
    const connection = acmeConnection({ risks });
    const p = previewDraft({ connections: [connection], now: NOW }, draftWith(connection));
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
    const connection = acmeConnection();
    const p = previewDraft(
      { connections: [connection], now: NOW },
      draftWith(connection, { scope: 'selected', resource_refs: ['app-prod'] }),
    );
    expect(p.ok).toBe(true);
    const prodOnly = idsOf(connection, [byRef('app-prod')]);
    expect(p.policy.map((l) => l.risk_id)).toEqual(prodOnly);
    expect(prodOnly).not.toContain('acme[staging].write');
    expect(prodOnly.length).toBeLessThan(idsOf(connection, ACME_RESOURCES).length);
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
    const connection = acmeConnection();
    const p = previewDraft(
      { connections: [connection], now: NOW },
      {
        ...draftWith(connection),
        connections: [{ connection_id: connection.id, everything_i_hold: false }],
      },
    );
    expect(p.connections[0]?.everything_i_hold).toBe(false);
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
