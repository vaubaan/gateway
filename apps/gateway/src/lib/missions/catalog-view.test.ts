import { RISK_VECTOR_AXES, type RiskCatalog } from '@vaubaan/shared';
import { describe, expect, it } from 'vitest';

import { fullCatalogRiskIds } from '../../server/authority';
import {
  enumerateCatalog,
  formatRate,
  groupByKind,
  groupVariants,
  isResolvable,
  MAX_SEVERITY,
  patternsOf,
  riskKindOf,
  SEVERITY_RANKS,
  severityLevel,
  severityOf,
  VECTOR_AXES,
  noteBody,
  FALLBACK_NOTE,
  DEPRECATED_NOTE,
  vectorBadges,
} from './catalog-view';
import { ACME_CATALOG } from '../../../tests/support/missions/testing';

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

  it('is built on the authority enumeration: an entry the authority cannot enumerate has no row', () => {
    // An env-scoped entry whose id does not parse. A loaded catalog never holds one;
    // the two enumerations must still agree on it, by construction.
    const [, envScoped] = ACME_CATALOG.risks;
    if (!envScoped) throw new Error('fixture: the second entry is env-scoped');
    const malformed: RiskCatalog = {
      provider: 'acme',
      risks: [...ACME_CATALOG.risks, { ...envScoped, id: 'not a risk id' }],
    };
    expect(fullCatalogRiskIds(malformed)).toEqual(fullCatalogRiskIds(ACME_CATALOG));
    expect(enumerateCatalog(malformed).map((r) => r.risk_id)).toEqual(
      fullCatalogRiskIds(malformed),
    );
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

describe('explaining a risk', () => {
  const rows = enumerateCatalog(ACME_CATALOG);
  const row = (id: string) => {
    const found = rows.find((r) => r.risk_id === id);
    if (!found) throw new Error(`fixture row ${id} missing`);
    return found;
  };

  it('carries the vector resolved for the environment of each id', () => {
    expect(row('acme[staging].write').vector).toMatchObject({
      blast: 'single',
      visibility: 'internal',
    });
    expect(row('acme[prod].write').vector).toMatchObject({ blast: 'env', visibility: 'public' });
  });

  it('names the six axes in the order of the shared vocabulary, each with its question', () => {
    expect(VECTOR_AXES.map((a) => a.axis)).toEqual(Object.keys(RISK_VECTOR_AXES));
    expect(VECTOR_AXES.every((a) => a.label !== '' && a.question.endsWith('?'))).toBe(true);
  });

  it('gives each axis a short name of its own for the compact strip', () => {
    const abbrs = VECTOR_AXES.map((a) => a.abbr);
    expect(new Set(abbrs).size).toBe(abbrs.length);
    expect(abbrs.every((abbr) => abbr.length > 0 && abbr.length <= 5)).toBe(true);
    expect(vectorBadges(row('acme.admin').vector).map((b) => b.abbr)).toEqual(abbrs);
  });

  it('prints a note without its lead where the lead is already the title', () => {
    expect(noteBody(FALLBACK_NOTE)).toMatch(/^Counts only for a write/);
    expect(noteBody(DEPRECATED_NOTE)).toMatch(/^Kept so that/);
    expect(noteBody('No lead here.')).toBe('No lead here.');
  });

  it('turns a vector into six badges whose text carries the value and whose weight follows the scale', () => {
    const badges = vectorBadges(row('acme.admin').vector);
    expect(badges.map((b) => `${b.label}: ${b.value}`)).toEqual([
      'Reversibility: costly',
      'Blast radius: account',
      'Data: secret',
      'Cost: free',
      'Visibility: team',
      'Persistence: posture',
    ]);
    expect(badges.map((b) => b.weight)).toEqual([
      'middle',
      'middle',
      'middle',
      'mildest',
      'middle',
      'worst',
    ]);
    expect(badges[1]?.scale).toEqual(['single', 'env', 'account', 'bulk']);
  });

  it('tells reads from writes by the patterns, and destructive writes by the vector', () => {
    expect(patternsOf({ matches: 'a.b.R' })).toEqual(['a.b.R']);
    expect(patternsOf({ matches: ['a.b.R', 'a.c.W'] })).toEqual(['a.b.R', 'a.c.W']);
    const vector = row('acme.read').vector;
    expect(riskKindOf({ matches: ['a.b.R', 'a.c.R'] }, vector)).toBe('read');
    // One write pattern is enough: the entry is not a read.
    expect(riskKindOf({ matches: ['a.b.R', 'a.c.W'] }, vector)).toBe('write');
    expect(riskKindOf({ matches: 'a.c.W' }, { ...vector, reversibility: 'irreversible' })).toBe(
      'destructive',
    );
    expect(rows.map((r) => [r.risk_id, r.kind])).toEqual([
      ['acme.read', 'read'],
      ['acme[staging].write', 'write'],
      ['acme[prod].write', 'write'],
      ['acme[staging].bulk-delete', 'destructive'],
      ['acme.admin', 'write'],
      ['acme.legacy-export', 'read'],
      ['acme.uncategorized-write', 'write'],
    ]);
  });

  it('groups the rows by catalog entry: one variant per environment', () => {
    const families = groupVariants(rows);
    expect(families.map((f) => [f.base_id, f.variants.map((v) => v.env)])).toEqual([
      ['acme.read', [null]],
      ['acme.write', ['staging', 'prod']],
      ['acme.bulk-delete', ['staging']],
      ['acme.admin', [null]],
      ['acme.legacy-export', [null]],
      ['acme.uncategorized-write', [null]],
    ]);
    expect(families.find((f) => f.base_id === 'acme.legacy-export')?.deprecated).toBe(true);
    expect(families.find((f) => f.base_id === 'acme.uncategorized-write')?.fallback).toBe(true);
    expect(groupVariants([])).toEqual([]);
  });

  it('lists reads, then writes, then irreversible writes, leaving empty groups out', () => {
    const groups = groupByKind(rows);
    expect(groups.map((g) => [g.title, g.families.map((f) => f.base_id)])).toEqual([
      ['Reads', ['acme.read', 'acme.legacy-export']],
      ['Writes', ['acme.write', 'acme.admin', 'acme.uncategorized-write']],
      ['Irreversible writes', ['acme.bulk-delete']],
    ]);
    // Every row is in exactly one group.
    expect(groups.flatMap((g) => g.families.flatMap((f) => f.variants)).length).toBe(rows.length);
    expect(groupByKind(rows.filter((r) => r.kind === 'read')).map((g) => g.kind)).toEqual(['read']);
  });

  it('writes a rate limit in a few characters', () => {
    expect(formatRate({ max: 120, window_seconds: 60 })).toBe('120/min');
    expect(formatRate({ max: 10, window_seconds: 3600 })).toBe('10/hour');
    expect(formatRate({ max: 2, window_seconds: 1 })).toBe('2/s');
    expect(formatRate({ max: 5, window_seconds: 30 })).toBe('5 per 30s');
  });
});
