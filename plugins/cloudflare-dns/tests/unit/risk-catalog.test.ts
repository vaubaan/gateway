/**
 * Catalog invariants the SDK loader does not check for us : the risk count
 * and version, the irreversible set, the absence of env scoping / caps, the
 * layered record-write patterns, and the exact risks every tool touches.
 * Structure, patterns, presets and fallback are validated
 * by `loadCatalogFile` at import and by the kit in `plugin.test.ts`.
 *
 * Spec : docs/spec/gateway-risk-model.md §4.
 */
import { describe, expect, test } from 'vitest';

import { parseSlice, type Resource } from '@vaubaan/plugin-sdk';
import { declaredOnly } from '@vaubaan/plugin-sdk/testing';
import { prepareCatalog, risksTouchedBy } from '@vaubaan/policy-engine';

import { classifyCloudflareDns } from '../../src/classify.ts';
import { cloudflareDnsCatalog, cloudflareDnsTools } from '../../src/index.ts';

const { catalog, indexed: idx } = cloudflareDnsCatalog;

const zone: Resource = {
  provider: 'cloudflare-dns',
  ref: 'zone_x',
  displayName: 'example.com',
  metadata: { account_id: 'abc123account', zone_name: 'example.com' },
};

describe('cloudflare-dns risk-catalog — shape', () => {
  test('11 named risks + 1 fallback, version 3', () => {
    expect(catalog.provider).toBe('cloudflare-dns');
    expect(catalog.risks).toHaveLength(12);
    expect(catalog.catalog_version).toBe(3);
    expect(catalog.risks.filter((r) => r.fallback === true).map((r) => r.id)).toEqual([
      'cloudflare-dns.uncategorized-write',
    ]);
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

// ─── Exact risks per tool ────────────────────────────────────────────────────

const FALLBACK_ID = 'cloudflare-dns.uncategorized-write';

/** An ordinary subdomain record : keeps a record write out of the critical overlay. */
const ORDINARY = { type: 'A', name: 'www.example.com' };

/** The single source of truth for the tool list is `tools.ts`. */
const CF_DNS_TOOLS = cloudflareDnsTools.map((t) => t.name);

/** The risks a call touches, in catalog order ; a denied sample is a test failure, not an empty list. */
function risksFor(tool: string, args: Record<string, unknown>): string[] {
  // One sample serves every tool : each receives the arguments it declares.
  const result = classifyCloudflareDns(
    tool,
    declaredOnly({ tools: cloudflareDnsTools }, tool, args),
    [zone],
  );
  if ('denied' in result) throw new Error(`'${tool}' sample was denied: ${result.denied}`);
  const touched = new Set(result.slices.flatMap((slice) => risksTouchedBy(slice, idx)));
  return catalog.risks.map((r) => r.id).filter((id) => touched.has(id));
}

const READ_META = 'cloudflare-dns.read-zone-metadata';
const RECORD_WRITE = 'cloudflare-dns.record-write';
const CRITICAL = 'cloudflare-dns.critical-record-write';
const RECORD_DELETE = 'cloudflare-dns.record-delete';

/** Minimal arguments (zone and record id only) : record writes are under-specified, hence critical. */
const EXPECTED_MINIMAL: Readonly<Record<string, readonly string[]>> = {
  cloudflare_dns__list_zones: [READ_META],
  cloudflare_dns__get_zone: [READ_META],
  cloudflare_dns__list_records: [READ_META, 'cloudflare-dns.read-records'],
  cloudflare_dns__get_record: [READ_META, 'cloudflare-dns.read-records'],
  cloudflare_dns__export_records: [READ_META, 'cloudflare-dns.export-zone-file'],
  cloudflare_dns__get_zone_settings: [READ_META],
  cloudflare_dns__get_dnssec: [READ_META],
  cloudflare_dns__create_record: [RECORD_WRITE, CRITICAL],
  cloudflare_dns__update_record: [RECORD_WRITE, CRITICAL],
  cloudflare_dns__delete_record: [RECORD_WRITE, CRITICAL, RECORD_DELETE],
  cloudflare_dns__import_records: ['cloudflare-dns.import-records'],
  cloudflare_dns__edit_zone_settings: ['cloudflare-dns.zone-settings-write'],
  cloudflare_dns__purge_cache: ['cloudflare-dns.cache-purge'],
  cloudflare_dns__edit_dnssec: ['cloudflare-dns.dnssec-write'],
  cloudflare_dns__delete_zone: ['cloudflare-dns.zone-delete'],
};

/** Record writes that name an ordinary subdomain record, then a critical one. */
const EXPECTED_RECORD_WRITES: ReadonlyArray<
  readonly [tool: string, record: Record<string, string>, risks: readonly string[]]
> = [
  ['cloudflare_dns__create_record', ORDINARY, [RECORD_WRITE]],
  ['cloudflare_dns__update_record', ORDINARY, [RECORD_WRITE]],
  ['cloudflare_dns__delete_record', ORDINARY, [RECORD_WRITE, RECORD_DELETE]],
  ['cloudflare_dns__create_record', { type: 'MX', name: 'example.com' }, [RECORD_WRITE, CRITICAL]],
  ['cloudflare_dns__update_record', { type: 'A', name: 'example.com' }, [RECORD_WRITE, CRITICAL]],
  [
    'cloudflare_dns__delete_record',
    { type: 'NS', name: 'sub.example.com' },
    [RECORD_WRITE, CRITICAL, RECORD_DELETE],
  ],
  [
    'cloudflare_dns__delete_record',
    { type: 'A', name: 'example.com' },
    [RECORD_WRITE, CRITICAL, RECORD_DELETE],
  ],
];

describe('cloudflare-dns risk-catalog — every tool touches exactly its risks', () => {
  test('the expectation table lists every declared tool and nothing else', () => {
    expect(Object.keys(EXPECTED_MINIMAL).sort()).toEqual([...CF_DNS_TOOLS].sort());
  });

  for (const tool of CF_DNS_TOOLS) {
    test(`'${tool}' touches exactly its risks (never the fallback)`, () => {
      const risks = risksFor(tool, { zone_id: 'zone_x', record_id: 'rec_x' });
      expect(risks).toEqual(EXPECTED_MINIMAL[tool]);
      expect(risks).not.toContain(FALLBACK_ID);
    });
  }

  test.each(EXPECTED_RECORD_WRITES)('%s on %o touches %j', (tool, record, risks) => {
    expect(risksFor(tool, { zone_id: 'zone_x', record_id: 'rec_x', ...record })).toEqual(risks);
  });

  test('a denied sample fails loudly instead of counting as zero risks', () => {
    expect(() => risksFor('cloudflare_dns__get_record', { zone_id: 'zone_x' })).toThrow(
      /sample was denied: record_id: missing/,
    );
  });
});

describe('cloudflare-dns risk-catalog — risksTouchedBy sanity checks', () => {
  const touched = (s: string) => risksTouchedBy(parseSlice(s), idx);

  test('a zone[Z].R slice touches read-zone-metadata only', () => {
    expect(touched('cloudflare-dns.account[acct_x].zone[zone_x].R')).toEqual([
      'cloudflare-dns.read-zone-metadata',
    ]);
  });

  test('a record[R].R slice touches read-zone-metadata and read-records (zone[**].R is recursive)', () => {
    expect(touched('cloudflare-dns.account[acct_x].zone[zone_x].record[rec_x].R')).toEqual([
      'cloudflare-dns.read-zone-metadata',
      'cloudflare-dns.read-records',
    ]);
  });

  test('zone-settings.R and dnssec.R touch read-zone-metadata only', () => {
    expect(touched('cloudflare-dns.account[acct_x].zone[zone_x].zone-settings.R')).toEqual([
      'cloudflare-dns.read-zone-metadata',
    ]);
    expect(touched('cloudflare-dns.account[acct_x].zone[zone_x].dnssec.R')).toEqual([
      'cloudflare-dns.read-zone-metadata',
    ]);
  });

  test('a zone-export.R slice touches read-zone-metadata and export-zone-file : the export needs both', () => {
    expect(touched('cloudflare-dns.account[acct_x].zone[zone_x].zone-export.R')).toEqual([
      'cloudflare-dns.read-zone-metadata',
      'cloudflare-dns.export-zone-file',
    ]);
  });

  // A categorized write touches its dedicated entries only ; the fallback
  // fires when no other entry matched (ADR fallback-risk-only-when-uncategorized).
  test('an ordinary record write touches record-write only (never the fallback)', () => {
    expect(touched('cloudflare-dns.account[acct_x].zone[zone_x].record.W')).toEqual([
      'cloudflare-dns.record-write',
    ]);
    expect(touched('cloudflare-dns.account[acct_x].zone[zone_x].record[rec_x].W')).toEqual([
      'cloudflare-dns.record-write',
    ]);
  });

  test('the critical overlay and the delete leaf layer on top of record-write', () => {
    expect(touched('cloudflare-dns.account[acct_x].zone[zone_x].record.critical.W')).toEqual([
      'cloudflare-dns.record-write',
      'cloudflare-dns.critical-record-write',
    ]);
    expect(touched('cloudflare-dns.account[acct_x].zone[zone_x].record[rec_x].critical.W')).toEqual(
      ['cloudflare-dns.record-write', 'cloudflare-dns.critical-record-write'],
    );
    expect(touched('cloudflare-dns.account[acct_x].zone[zone_x].record[rec_x].delete.W')).toEqual([
      'cloudflare-dns.record-write',
      'cloudflare-dns.record-delete',
    ]);
  });

  test('zone-level writes resolve to their own risk', () => {
    const zone = 'cloudflare-dns.account[acct_x].zone[zone_x]';
    expect(touched(`${zone}.zone-import.W`)).toEqual(['cloudflare-dns.import-records']);
    expect(touched(`${zone}.zone-settings.W`)).toEqual(['cloudflare-dns.zone-settings-write']);
    expect(touched(`${zone}.dnssec.W`)).toEqual(['cloudflare-dns.dnssec-write']);
    expect(touched(`${zone}.cache.W`)).toEqual(['cloudflare-dns.cache-purge']);
    expect(touched(`${zone}.W`)).toEqual(['cloudflare-dns.zone-delete']);
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
      `${zone}.record.critical.W`,
      `${zone}.record[rec_x].critical.W`,
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
