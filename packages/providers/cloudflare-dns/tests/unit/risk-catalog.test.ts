/**
 * Catalog lint — parses the YAML, validates the static schema, parses every
 * `matches` slice pattern, walks every Cloudflare DNS MCP tool the classifier
 * supports, and asserts that AT LEAST ONE non-fallback risk matches each
 * tool's emitted slices.
 *
 * Spec     : docs/spec/gateway-risk-model.md §4, §14.
 * Research : .vaubaan/research/providers/cloudflare-dns.md §4.
 *
 * The lint fails the build (CI gate) on :
 *   - malformed YAML
 *   - duplicate RiskId
 *   - RiskId that breaks the wire-format regex (cf. shared/src/risk.ts)
 *   - a `matches` pattern that does not parse via `parseSlice`
 *   - missing fallback risk (`cloudflare-dns.uncategorized-*`)
 *   - any tool whose emitted slices are only covered by the fallback risk
 *     (signals a hole in the catalog).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, test } from 'vitest';
import yaml from 'js-yaml';
import type { ProviderBinding, RiskCatalog, RiskEntry, Slice } from '@vaubaan/shared';
import { matches, parseSlice, prepareCatalog, risksTouchedBy } from '@vaubaan/policy-engine';

import { classifyCloudflareDnsV4 } from '../../src/risk-classifier.ts';
import { cloudflareDnsRiskCatalog } from '../../src/risk-catalog.ts';

// ─── Load + parse the YAML catalog ──────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const yamlPath = resolve(here, '../../src/risk-catalog.yaml');
const rawYaml = readFileSync(yamlPath, 'utf8');
const parsedCatalog = yaml.load(rawYaml) as RiskCatalog;

const binding: ProviderBinding = {
  id: 'b1',
  project_id: 'p1',
  provider: 'cloudflare-dns',
  resource_ref: 'abc123account',
  display_name: null,
  metadata: {},
  created_at: '2026-01-01',
};

// Mirror the regex from shared/src/risk.ts so we can lint catalog ids without
// importing a private symbol (cf. risk-policy.ts:RISK_ID_REGEX).
const RISK_ID_REGEX =
  /^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*(\[[a-z][a-z0-9-]*\])?(\.[a-z][a-z0-9-]+)+$/;

describe('cloudflare-dns risk-catalog — YAML structural validation', () => {
  test('YAML parses into a valid RiskCatalog shape', () => {
    expect(parsedCatalog.provider).toBe('cloudflare-dns');
    expect(Array.isArray(parsedCatalog.risks)).toBe(true);
    // Expect 9 named risks + 1 fallback = 10.
    expect(parsedCatalog.risks.length).toBe(10);
  });

  test('every entry declares the required fields', () => {
    for (const entry of parsedCatalog.risks) {
      expect(typeof entry.id).toBe('string');
      expect(typeof entry.label).toBe('string');
      expect(typeof entry.reason).toBe('string');
      expect(entry.matches).toBeDefined();
      expect(entry.vector).toBeDefined();
    }
  });

  test('every RiskId matches the wire-format regex', () => {
    for (const entry of parsedCatalog.risks) {
      expect(entry.id, `risk id '${entry.id}' must match RISK_ID_REGEX`).toMatch(RISK_ID_REGEX);
    }
  });

  test('RiskIds are unique', () => {
    const seen = new Set<string>();
    for (const entry of parsedCatalog.risks) {
      expect(seen.has(entry.id), `duplicate risk id '${entry.id}'`).toBe(false);
      seen.add(entry.id);
    }
  });

  test('every 6D vector axis carries a valid value', () => {
    const axes: Record<keyof RiskEntry['vector'], readonly string[]> = {
      reversibility: ['reversible', 'costly', 'irreversible'],
      blast: ['single', 'env', 'account', 'bulk'],
      data: ['metadata', 'data', 'secret', 'pii'],
      cost: ['free', 'moderate', 'unbounded'],
      visibility: ['internal', 'team', 'public'],
      persistence: ['stateless', 'session', 'posture'],
    };
    for (const entry of parsedCatalog.risks) {
      for (const [axis, allowed] of Object.entries(axes) as Array<
        [keyof RiskEntry['vector'], readonly string[]]
      >) {
        expect(
          allowed,
          `risk '${entry.id}' axis '${axis}' has invalid value '${entry.vector[axis]}'`,
        ).toContain(entry.vector[axis]);
      }
    }
  });

  test('a fallback entry (uncategorized-*) is declared', () => {
    const hasFallback = parsedCatalog.risks.some((e) =>
      e.id.startsWith('cloudflare-dns.uncategorized'),
    );
    expect(hasFallback, 'catalog must declare a cloudflare-dns.uncategorized-* fallback').toBe(
      true,
    );
  });

  test('zone-delete is the only irreversible risk', () => {
    const irreversible = parsedCatalog.risks.filter(
      (r) => r.vector.reversibility === 'irreversible',
    );
    const ids = irreversible.map((r) => r.id).sort();
    expect(ids).toEqual(['cloudflare-dns.zone-delete']);
  });

  test('no risk declares acceptable_in_envs at MVP', () => {
    for (const entry of parsedCatalog.risks) {
      expect(
        entry.acceptable_in_envs,
        `risk '${entry.id}' should NOT carry acceptable_in_envs at MVP`,
      ).toBeUndefined();
    }
  });

  test('no risk declares caps at MVP', () => {
    for (const entry of parsedCatalog.risks) {
      expect(entry.caps, `risk '${entry.id}' should NOT carry caps at MVP`).toBeUndefined();
    }
  });

  test('no risk declares infra_limits at MVP', () => {
    for (const entry of parsedCatalog.risks) {
      expect(
        entry.infra_limits,
        `risk '${entry.id}' should NOT carry infra_limits at MVP`,
      ).toBeUndefined();
    }
  });
});

describe('cloudflare-dns risk-catalog — every `matches` pattern parses via parseSlice', () => {
  for (const entry of parsedCatalog.risks) {
    test(`'${entry.id}' parses`, () => {
      const raws: readonly string[] =
        typeof entry.matches === 'string' ? [entry.matches] : entry.matches;
      for (const raw of raws) {
        const parsed = parseSlice(raw);
        expect(parsed.provider).toBe('cloudflare-dns');
      }
    });
  }
});

describe('cloudflare-dns risk-catalog — prepareCatalog roundtrips OK', () => {
  test('prepareCatalog accepts the TS catalog', () => {
    const indexed = prepareCatalog(cloudflareDnsRiskCatalog);
    expect(indexed.provider).toBe('cloudflare-dns');
    expect(indexed.entries.length).toBe(parsedCatalog.risks.length);
  });
});

// ─── Build the parsed-pattern index once for lint usage ─────────────────────

/** Flatten one risk entry into one (entry, pattern) row per `matches` string. */
const indexed = parsedCatalog.risks.flatMap((entry) => {
  const raws: readonly string[] =
    typeof entry.matches === 'string' ? [entry.matches] : entry.matches;
  return raws.map((raw) => ({ entry, pattern: parseSlice(raw) }));
});

const FALLBACK_ID = 'cloudflare-dns.uncategorized-write';

/** The 15 tools the Cloudflare DNS classifier knows (7 reads + 8 writes). */
const CF_DNS_TOOLS = [
  // reads
  'cloudflare_dns__list_zones',
  'cloudflare_dns__get_zone',
  'cloudflare_dns__list_records',
  'cloudflare_dns__get_record',
  'cloudflare_dns__export_records',
  'cloudflare_dns__get_zone_settings',
  'cloudflare_dns__get_dnssec',
  // writes
  'cloudflare_dns__create_record',
  'cloudflare_dns__update_record',
  'cloudflare_dns__delete_record',
  'cloudflare_dns__import_records',
  'cloudflare_dns__edit_zone_settings',
  'cloudflare_dns__purge_cache',
  'cloudflare_dns__edit_dnssec',
  'cloudflare_dns__delete_zone',
] as const;

/** Synthesise argument shapes that exercise the classifier on each tool. */
function syntheticArgsForTool(tool: string): Array<Record<string, unknown>> {
  switch (tool) {
    case 'cloudflare_dns__get_zone':
    case 'cloudflare_dns__list_records':
    case 'cloudflare_dns__export_records':
    case 'cloudflare_dns__get_zone_settings':
    case 'cloudflare_dns__get_dnssec':
    case 'cloudflare_dns__create_record':
    case 'cloudflare_dns__import_records':
    case 'cloudflare_dns__edit_zone_settings':
    case 'cloudflare_dns__purge_cache':
    case 'cloudflare_dns__edit_dnssec':
    case 'cloudflare_dns__delete_zone':
      return [{ zone_id: 'zone_x' }];
    case 'cloudflare_dns__get_record':
    case 'cloudflare_dns__update_record':
    case 'cloudflare_dns__delete_record':
      return [{ zone_id: 'zone_x', record_id: 'rec_x' }];
    default:
      return [{}];
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
  const sl = slicesForTool(tool);
  const matched = new Set<string>();
  for (const slice of sl) {
    for (const { entry, pattern } of indexed) {
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
  const idx = prepareCatalog(cloudflareDnsRiskCatalog);

  test('a zone[Z].R slice touches cloudflare-dns.read-zone-metadata', () => {
    const sl = parseSlice('cloudflare-dns.account[acct_x].zone[zone_x].R');
    expect(risksTouchedBy(sl, idx)).toContain('cloudflare-dns.read-zone-metadata');
  });

  test('a record[R].R slice touches cloudflare-dns.read-records', () => {
    const sl = parseSlice('cloudflare-dns.account[acct_x].zone[zone_x].record[rec_x].R');
    expect(risksTouchedBy(sl, idx)).toContain('cloudflare-dns.read-records');
  });

  test('a zone-export.R slice touches cloudflare-dns.export-zone-file', () => {
    const sl = parseSlice('cloudflare-dns.account[acct_x].zone[zone_x].zone-export.R');
    expect(risksTouchedBy(sl, idx)).toContain('cloudflare-dns.export-zone-file');
  });

  test('a record.W slice touches cloudflare-dns.record-write', () => {
    const sl = parseSlice('cloudflare-dns.account[acct_x].zone[zone_x].record.W');
    expect(risksTouchedBy(sl, idx)).toContain('cloudflare-dns.record-write');
  });

  test('a zone-import.W slice touches cloudflare-dns.import-records', () => {
    const sl = parseSlice('cloudflare-dns.account[acct_x].zone[zone_x].zone-import.W');
    expect(risksTouchedBy(sl, idx)).toContain('cloudflare-dns.import-records');
  });

  test('a zone-settings.W slice touches cloudflare-dns.zone-settings-write', () => {
    const sl = parseSlice('cloudflare-dns.account[acct_x].zone[zone_x].zone-settings.W');
    expect(risksTouchedBy(sl, idx)).toContain('cloudflare-dns.zone-settings-write');
  });

  test('a dnssec.W slice touches cloudflare-dns.dnssec-write', () => {
    const sl = parseSlice('cloudflare-dns.account[acct_x].zone[zone_x].dnssec.W');
    expect(risksTouchedBy(sl, idx)).toContain('cloudflare-dns.dnssec-write');
  });

  test('a cache.W slice touches cloudflare-dns.cache-purge', () => {
    const sl = parseSlice('cloudflare-dns.account[acct_x].zone[zone_x].cache.W');
    expect(risksTouchedBy(sl, idx)).toContain('cloudflare-dns.cache-purge');
  });

  test('a zone[Z].W slice touches cloudflare-dns.zone-delete', () => {
    const sl = parseSlice('cloudflare-dns.account[acct_x].zone[zone_x].W');
    expect(risksTouchedBy(sl, idx)).toContain('cloudflare-dns.zone-delete');
  });

  test('the fallback catches a wholly novel write slice', () => {
    const sl = parseSlice('cloudflare-dns.account[acct_x].zone[zone_x].page-rule[**].W');
    expect(risksTouchedBy(sl, idx)).toContain('cloudflare-dns.uncategorized-write');
  });

  test('zone-settings.R touches read-zone-metadata but not read-records', () => {
    const settings = parseSlice('cloudflare-dns.account[acct_x].zone[zone_x].zone-settings.R');
    expect(risksTouchedBy(settings, idx)).toContain('cloudflare-dns.read-zone-metadata');
    expect(risksTouchedBy(settings, idx)).not.toContain('cloudflare-dns.read-records');
  });

  test('record.R touches both read-records and read-zone-metadata (zone[**].R is recursive)', () => {
    const records = parseSlice('cloudflare-dns.account[acct_x].zone[zone_x].record[rec_x].R');
    expect(risksTouchedBy(records, idx)).toContain('cloudflare-dns.read-records');
    // zone[**].R also matches deeper paths — this is intentional
    expect(risksTouchedBy(records, idx)).toContain('cloudflare-dns.read-zone-metadata');
  });
});
