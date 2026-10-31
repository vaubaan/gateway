/**
 * Catalog lint — the catalog as the plugin loads it from the YAML : the
 * entries, the vector, the fallback, and slice → risk resolution on the
 * slices the classifier emits and on writes no tool emits.
 */
import { describe, expect, test } from 'vitest';

import { matches, risksTouchedBy } from '@vaubaan/plugin-sdk/testing';

import { parseSlice } from '@vaubaan/plugin-sdk';

import { PROVIDER_ID, context7Catalog } from '../../src/index.ts';

const { catalog, indexed } = context7Catalog;

describe('context7 risk-catalog — YAML structural validation', () => {
  test('one named risk and the fallback, at catalog version 1', () => {
    expect(catalog.provider).toBe(PROVIDER_ID);
    expect(catalog.catalog_version).toBe(3);
    expect(catalog.risks.map((r) => [r.id, r.fallback === true])).toEqual([
      [`${PROVIDER_ID}.query-docs`, false],
      [`${PROVIDER_ID}.uncategorized-write`, true],
    ]);
  });

  test('the vector of the disclosure, as decided', () => {
    const risk = catalog.risks.find((r) => r.id === `${PROVIDER_ID}.query-docs`)!;
    expect(risk.vector).toEqual({
      reversibility: 'irreversible',
      blast: 'single',
      data: 'data',
      cost: 'moderate',
      visibility: 'public',
      persistence: 'stateless',
    });
    expect(risk.reason).toMatch(/sent to Context7/);
  });

  test('every pattern parses as a slice of this provider', () => {
    for (const risk of catalog.risks) {
      const patterns: readonly string[] =
        typeof risk.matches === 'string' ? [risk.matches] : risk.matches;
      for (const pattern of patterns) expect(parseSlice(pattern).provider).toBe(PROVIDER_ID);
    }
  });
});

describe('context7 risk-catalog — slice → risk resolution', () => {
  test('a read of the index, a search or one library, is query-docs alone', () => {
    for (const slice of [
      'context7.index[docs].library[*].R',
      'context7.index[docs].library[/vercel/next.js].R',
      'context7.index[docs].library[/vercel/next.js/v14.3.0].R',
    ]) {
      expect(risksTouchedBy(parseSlice(slice), indexed), slice).toEqual([
        `${PROVIDER_ID}.query-docs`,
      ]);
    }
  });

  test('a write no tool emits lands on the fallback alone', () => {
    const write = parseSlice('context7.index[docs].library[/a/b].W');
    expect(risksTouchedBy(write, indexed)).toEqual([`${PROVIDER_ID}.uncategorized-write`]);
    expect(matches(parseSlice('context7.index[**].library[**].R'), write)).toBe(false);
  });
});
