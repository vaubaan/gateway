import { RISK_VECTOR_AXES } from '@vaubaan/shared';
import { describe, expect, it } from 'vitest';

import { fullCatalogRiskIds } from '../authority';
import {
  describePresetWidth,
  enumerateCatalog,
  isResolvable,
  MAX_SEVERITY,
  presetWidth,
  SEVERITY_RANKS,
  severityLevel,
  severityOf,
} from './catalog-view';
import { ACME_CATALOG } from './testing';

describe('enumerateCatalog', () => {
  const rows = enumerateCatalog(ACME_CATALOG);

  it('lists one explicit id per account-scoped entry and per acceptable env', () => {
    expect(rows.map((r) => r.risk_id)).toEqual([
      'acme.read',
      'acme[staging].write',
      'acme[prod].write',
      'acme[staging].bulk-delete',
      'acme.admin',
      'acme.legacy-export',
      'acme.uncategorized-write',
    ]);
  });

  it('is the same enumeration as the owner authority, with no wildcard', () => {
    expect(rows.map((r) => r.risk_id)).toEqual(fullCatalogRiskIds(ACME_CATALOG));
    expect(rows.every((r) => !/[*?]/.test(r.risk_id))).toBe(true);
  });

  it('carries the base id, the env, the flags and the rate ceiling', () => {
    const prodWrite = rows.find((r) => r.risk_id === 'acme[prod].write');
    expect(prodWrite).toMatchObject({ base_id: 'acme.write', env: 'prod', fallback: false });
    expect(rows.find((r) => r.risk_id === 'acme.uncategorized-write')?.fallback).toBe(true);
    expect(rows.find((r) => r.risk_id === 'acme.legacy-export')?.deprecated).toBe(true);
    expect(rows.find((r) => r.risk_id === 'acme.admin')?.rate_ceiling_per_minute).toBe(10);
    expect(rows.find((r) => r.risk_id === 'acme.read')?.rate_ceiling_per_minute).toBeNull();
  });

  it('resolves the vector per env: the prod row is more severe than the staging row', () => {
    const staging = rows.find((r) => r.risk_id === 'acme[staging].write');
    const prod = rows.find((r) => r.risk_id === 'acme[prod].write');
    expect(prod?.severity).toBeGreaterThan(staging?.severity ?? Number.POSITIVE_INFINITY);
  });
});

describe('severity', () => {
  it('ranks the axes exactly like the shared vector vocabulary', () => {
    expect(SEVERITY_RANKS).toEqual(RISK_VECTOR_AXES);
  });

  it('is 0 for the mildest vector and MAX_SEVERITY for the worst', () => {
    expect(
      severityOf({
        reversibility: 'reversible',
        blast: 'single',
        data: 'metadata',
        cost: 'free',
        visibility: 'internal',
        persistence: 'stateless',
      }),
    ).toBe(0);
    expect(
      severityOf({
        reversibility: 'irreversible',
        blast: 'bulk',
        data: 'pii',
        cost: 'unbounded',
        visibility: 'public',
        persistence: 'posture',
      }),
    ).toBe(MAX_SEVERITY);
  });

  it('buckets the score into four levels', () => {
    expect([0, 3, 4, 6, 7, 9, 10, MAX_SEVERITY].map(severityLevel)).toEqual([
      'low',
      'low',
      'medium',
      'medium',
      'high',
      'high',
      'critical',
      'critical',
    ]);
  });
});

describe('isResolvable', () => {
  const plain = { derives_env: false };
  it('always resolves an account-scoped id', () => {
    expect(isResolvable({ env: null }, plain, [])).toBe(true);
  });
  it('resolves an env-qualified id only when a selected resource carries the label', () => {
    expect(isResolvable({ env: 'staging' }, plain, [{ env: 'staging' }, { env: null }])).toBe(true);
    expect(isResolvable({ env: 'staging' }, plain, [{ env: 'prod' }, { env: null }])).toBe(false);
    expect(isResolvable({ env: 'staging' }, plain, [])).toBe(false);
  });
  it('resolves any env when the plugin derives it from the call', () => {
    expect(isResolvable({ env: 'prod' }, { derives_env: true }, [])).toBe(true);
  });
});

describe('presetWidth', () => {
  it('counts the risks, names the most severe one and the largest quota', () => {
    const developer = ACME_CATALOG.presets?.find((p) => p.id === 'developer');
    if (!developer) throw new Error('fixture preset missing');
    const width = presetWidth(developer, enumerateCatalog(ACME_CATALOG));
    expect(width).toMatchObject({ risks: 3, largest_quota: 1000, approvals: 1 });
    expect(width.most_severe?.risk_id).toBe('acme[staging].bulk-delete');
    expect(describePresetWidth(width)).toBe(
      '3 risks · most severe: Delete things in bulk (high) · largest quota 1000 · 1 under approval',
    );
  });
});
