/**
 * Catalog invariants the SDK loader does not check for us : the risk count
 * and version, the irreversible set, the absence of env scoping / caps, the
 * layered record-write patterns, and the coverage of every tool by a
 * non-fallback risk. Structure, patterns, presets and fallback are validated
 * by `loadCatalogFile` at import and by the kit in `plugin.test.ts`.
 *
 * Spec : docs/spec/gateway-risk-model.md §4.
 */
import { describe, expect, test } from 'vitest';

import { parseSlice } from '@vaubaan/plugin-sdk';
import type { ProviderBinding, Slice } from '@vaubaan/shared';
import { matches, prepareCatalog, risksTouchedBy } from '@vaubaan/policy-engine';

import { classifyCloudflareDnsV4 } from '../../src/risk-classifier.ts';
import { cloudflareDnsCatalog, cloudflareDnsRiskCatalog } from '../../src/index.ts';

const { catalog, indexed: idx } = cloudflareDnsCatalog;

const binding: ProviderBinding = {
  id: 'b1',
  project_id: 'p1',
  provider: 'cloudflare-dns',
  resource_ref: 'abc123account',
  display_name: null,
  metadata: {},
  created_at: '2026-01-01',
};

describe('cloudflare-dns risk-catalog — shape', () => {
  test('11 named risks + 1 fallback, version 2', () => {
    expect(catalog.provider).toBe('cloudflare-dns');
    expect(catalog.risks).toHaveLength(12);
    expect(catalog.catalog_version).toBe(2);
    expect(
      catalog.risks.filter((r) => r.id.startsWith('cloudflare-dns.uncategorized')),
    ).toHaveLength(1);
  });

  test('the legacy export is the loaded YAML', () => {
    expect(cloudflareDnsRiskCatalog).toBe(catalog);
  });

  test('zone-delete is the only irreversible risk', () => {
    const ids = catalog.risks
      .filter((r) => r.vector.reversibility === 'irreversible')
      .map((r) => r.id);
    expect(ids).toEqual(['cloudflare-dns.zone-delete']);
  });

  test('no env scoping, no caps, no infra_limits (DNS has no test/live mode)', () => {
    for (const entry of catalog.risks) {
      expect(entry.acceptable_in_envs, entry.id).toBeUndefined();
      expect(entry.caps, entry.id).toBeUndefined();
      expect(entry.infra_limits, entry.id).toBeUndefined();
    }
  });

  test('no preset lists the fallback or the zone deletion', () => {
    for (const preset of catalog.presets) {
      const risks = preset.entries.map((e) => e.risk_id);
      expect(risks, preset.id).not.toContain('cloudflare-dns.uncategorized-write');
      expect(risks, preset.id).not.toContain('cloudflare-dns.zone-delete');
    }
  });
});

describe('cloudflare-dns risk-catalog — prepareCatalog', () => {
  test('indexes every risk', () => {
    expect(idx.provider).toBe('cloudflare-dns');
    expect(idx.entries.length).toBe(catalog.risks.length);
    expect(prepareCatalog(catalog).entries.length).toBe(catalog.risks.length);
  });
});

// ─── Coverage lint on the v4 classifier (frozen) ─────────────────────────────

const patterns = catalog.risks.flatMap((entry) => {
  const raws: readonly string[] =
    typeof entry.matches === 'string' ? [entry.matches] : entry.matches;
  return raws.map((raw) => ({ entry, pattern: parseSlice(raw) }));
});

const FALLBACK_ID = 'cloudflare-dns.uncategorized-write';

/** The 15 tools the v4 classifier knows (7 reads + 8 writes). */
const CF_DNS_TOOLS = [
  'cloudflare_dns__list_zones',
  'cloudflare_dns__get_zone',
  'cloudflare_dns__list_records',
  'cloudflare_dns__get_record',
  'cloudflare_dns__export_records',
  'cloudflare_dns__get_zone_settings',
  'cloudflare_dns__get_dnssec',
  'cloudflare_dns__create_record',
  'cloudflare_dns__update_record',
  'cloudflare_dns__delete_record',
  'cloudflare_dns__import_records',
  'cloudflare_dns__edit_zone_settings',
  'cloudflare_dns__purge_cache',
  'cloudflare_dns__edit_dnssec',
  'cloudflare_dns__delete_zone',
] as const;

function syntheticArgsForTool(tool: string): Array<Record<string, unknown>> {
  switch (tool) {
    case 'cloudflare_dns__get_record':
    case 'cloudflare_dns__update_record':
    case 'cloudflare_dns__delete_record':
      return [{ zone_id: 'zone_x', record_id: 'rec_x' }];
    case 'cloudflare_dns__list_zones':
      return [{}];
    default:
      return [{ zone_id: 'zone_x' }];
  }
}

function slicesForTool(tool: string): Slice[] {
  const out: Slice[] = [];
  for (const args of syntheticArgsForTool(tool)) {
    const result = classifyCloudflareDnsV4(tool, args, [binding]);
    if ('slices' in result) out.push(...result.slices);
  }
  return out;
}

function risksForTool(tool: string): string[] {
  const matched = new Set<string>();
  for (const slice of slicesForTool(tool)) {
    for (const { entry, pattern } of patterns) {
      if (matches(pattern, slice)) matched.add(entry.id);
    }
  }
  return [...matched];
}

describe('cloudflare-dns risk-catalog — coverage lint (every tool matched by >= 1 non-fallback risk)', () => {
  for (const tool of CF_DNS_TOOLS) {
    test(`'${tool}' is covered by at least one non-fallback risk`, () => {
      const hit = risksForTool(tool);
      expect(hit.length, `tool '${tool}' matched zero catalog risks`).toBeGreaterThan(0);
      const nonFallback = hit.filter((id) => id !== FALLBACK_ID);
      expect(
        nonFallback.length,
        `tool '${tool}' is only covered by the fallback ${FALLBACK_ID} — add a specific risk`,
      ).toBeGreaterThan(0);
    });
  }
});

describe('cloudflare-dns risk-catalog — risksTouchedBy sanity checks', () => {
  const touched = (s: string) => risksTouchedBy(parseSlice(s), idx);

  test('a zone[Z].R slice touches read-zone-metadata', () => {
    expect(touched('cloudflare-dns.account[acct_x].zone[zone_x].R')).toContain(
      'cloudflare-dns.read-zone-metadata',
    );
  });

  test('a record[R].R slice touches read-records and read-zone-metadata (zone[**].R is recursive)', () => {
    const risks = touched('cloudflare-dns.account[acct_x].zone[zone_x].record[rec_x].R');
    expect(risks).toContain('cloudflare-dns.read-records');
    expect(risks).toContain('cloudflare-dns.read-zone-metadata');
  });

  test('zone-settings.R touches read-zone-metadata but not read-records', () => {
    const risks = touched('cloudflare-dns.account[acct_x].zone[zone_x].zone-settings.R');
    expect(risks).toContain('cloudflare-dns.read-zone-metadata');
    expect(risks).not.toContain('cloudflare-dns.read-records');
  });

  test('a zone-export.R slice touches export-zone-file', () => {
    expect(touched('cloudflare-dns.account[acct_x].zone[zone_x].zone-export.R')).toContain(
      'cloudflare-dns.export-zone-file',
    );
  });

  test('an ordinary record write touches record-write only (plus the fallback)', () => {
    expect(touched('cloudflare-dns.account[acct_x].zone[zone_x].record.W')).toEqual([
      'cloudflare-dns.record-write',
      FALLBACK_ID,
    ]);
    expect(touched('cloudflare-dns.account[acct_x].zone[zone_x].record[rec_x].W')).toEqual([
      'cloudflare-dns.record-write',
      FALLBACK_ID,
    ]);
  });

  test('the critical overlay and the delete leaf layer on top of record-write', () => {
    expect(touched('cloudflare-dns.account[acct_x].zone[zone_x].record.critical.W')).toEqual([
      'cloudflare-dns.record-write',
      'cloudflare-dns.critical-record-write',
      FALLBACK_ID,
    ]);
    expect(touched('cloudflare-dns.account[acct_x].zone[zone_x].record[rec_x].delete.W')).toEqual([
      'cloudflare-dns.record-write',
      'cloudflare-dns.record-delete',
      FALLBACK_ID,
    ]);
  });

  test('zone-level writes resolve to their own risk', () => {
    const zone = 'cloudflare-dns.account[acct_x].zone[zone_x]';
    expect(touched(`${zone}.zone-import.W`)).toContain('cloudflare-dns.import-records');
    expect(touched(`${zone}.zone-settings.W`)).toContain('cloudflare-dns.zone-settings-write');
    expect(touched(`${zone}.dnssec.W`)).toContain('cloudflare-dns.dnssec-write');
    expect(touched(`${zone}.cache.W`)).toContain('cloudflare-dns.cache-purge');
    expect(touched(`${zone}.W`)).toContain('cloudflare-dns.zone-delete');
    expect(touched(`${zone}.W`)).not.toContain('cloudflare-dns.record-write');
  });

  test('the fallback alone catches a wholly novel write slice', () => {
    expect(touched('cloudflare-dns.account[acct_x].zone[zone_x].page-rule[pr_x].W')).toEqual([
      FALLBACK_ID,
    ]);
  });

  test('zone-delete is touched by the zone write only, never by a write under the zone', () => {
    const zone = 'cloudflare-dns.account[acct_x].zone[zone_x]';
    for (const under of [
      `${zone}.record.W`,
      `${zone}.record[rec_x].W`,
      `${zone}.record[rec_x].delete.W`,
      `${zone}.zone-settings.W`,
      `${zone}.dnssec.W`,
      `${zone}.cache.W`,
      `${zone}.zone-import.W`,
    ]) {
      expect(touched(under), under).not.toContain('cloudflare-dns.zone-delete');
    }
  });
});
