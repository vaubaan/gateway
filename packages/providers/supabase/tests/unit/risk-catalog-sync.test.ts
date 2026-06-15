/**
 * Catalog sync — assert that `risk-catalog.ts` (runtime export) and
 * `risk-catalog.yaml` (canonical reviewable form) declare the same risks
 * with the same shape.
 *
 * The YAML stays the source of truth for review purposes (concise, human-
 * friendly diff). The TS export is what the web runtime imports — Vercel
 * does not bundle `.yaml` files in the Lambda. This test fails the build
 * if the two drift, so authors are forced to keep them aligned.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, test } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { RiskCatalog, RiskEntry } from '@vaubaan/shared';

import { supabaseRiskCatalog } from '../../src/risk-catalog.ts';

const CATALOG_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../src/risk-catalog.yaml',
);

const yamlCatalog = parseYaml(readFileSync(CATALOG_PATH, 'utf8')) as RiskCatalog;

function matchesAsArray(entry: RiskEntry): readonly string[] {
  return typeof entry.matches === 'string' ? [entry.matches] : entry.matches;
}

describe('supabase risk-catalog YAML ↔ TS sync', () => {
  test('provider matches', () => {
    expect(supabaseRiskCatalog.provider).toBe(yamlCatalog.provider);
  });

  test('declares the same number of risks', () => {
    expect(supabaseRiskCatalog.risks.length).toBe(yamlCatalog.risks.length);
  });

  test('risk ids match 1:1, in the same order', () => {
    const tsIds = supabaseRiskCatalog.risks.map((r) => r.id);
    const yamlIds = yamlCatalog.risks.map((r) => r.id);
    expect(tsIds).toEqual(yamlIds);
  });

  for (const yamlEntry of yamlCatalog.risks) {
    test(`entry "${yamlEntry.id}" matches TS export`, () => {
      const tsEntry = supabaseRiskCatalog.risks.find((r) => r.id === yamlEntry.id);
      expect(tsEntry, `missing TS entry for ${yamlEntry.id}`).toBeDefined();
      expect(tsEntry!.label).toBe(yamlEntry.label);
      expect(normalizeWs(tsEntry!.reason)).toBe(normalizeWs(yamlEntry.reason));
      expect(matchesAsArray(tsEntry!)).toEqual(matchesAsArray(yamlEntry));
      expect(tsEntry!.vector).toEqual(yamlEntry.vector);
      expect(tsEntry!.default_gate).toBe(yamlEntry.default_gate);
      expect(tsEntry!.acceptable_in_envs ?? null).toEqual(yamlEntry.acceptable_in_envs ?? null);
      expect(tsEntry!.deprecated ?? null).toEqual(yamlEntry.deprecated ?? null);
      expect(tsEntry!.replaced_by ?? null).toEqual(yamlEntry.replaced_by ?? null);
    });
  }
});

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
