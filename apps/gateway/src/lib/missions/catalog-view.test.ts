import type { RiskCatalog } from '@vaubaan/shared';
import { describe, expect, it } from 'vitest';

import { fullCatalogRiskIds } from '../../server/authority';
import {
  byRowWorstFirst,
  enumerateCatalog,
  formatRate,
  groupByKind,
  groupVariants,
  isResolvable,
  patternsOf,
  hardestToRepair,
  riskKindOf,
  noteBody,
  FALLBACK_NOTE,
  DEPRECATED_NOTE,
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

  it('resolves the vector per env; the row is read from it, the first branch deciding', () => {
    const staging = rows.find((r) => r.risk_id === 'acme[staging].write');
    const prod = rows.find((r) => r.risk_id === 'acme[prod].write');
    expect(prod?.vector.visibility).toBe('public');
    expect(staging?.vector.visibility).toBe('internal');
    // Costly to undo in both: that branch comes before "public".
    expect(staging).toMatchObject({ row: 3, row_reason: 'costly-to-undo' });
    expect(prod).toMatchObject({ row: 3, row_reason: 'costly-to-undo' });
    expect(rows.find((r) => r.risk_id === 'acme.read')).toMatchObject({ row: 1, row_reason: null });
  });

  it('orders by row, the hardest to repair first, then catalog order', () => {
    const ordered = byRowWorstFirst(rows);
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i - 1]!.row).toBeGreaterThanOrEqual(ordered[i]!.row);
    }
    const sameRow = (row: number) => rows.filter((r) => r.row === row).map((r) => r.risk_id);
    expect(ordered.filter((r) => r.row === 1).map((r) => r.risk_id)).toEqual(sameRow(1));
    expect(hardestToRepair(rows)).toBe(ordered[0]);
    expect(hardestToRepair([])).toBeNull();
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

  it('prints a note without its lead where the lead is already the title', () => {
    expect(noteBody(FALLBACK_NOTE)).toMatch(/^Counts only for a write/);
    expect(noteBody(DEPRECATED_NOTE)).toMatch(/^Kept so that/);
    expect(noteBody('No lead here.')).toBe('No lead here.');
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
