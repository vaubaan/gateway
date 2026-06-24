/**
 * Unit tests for `classifyCloudflareDnsV4` — the Cloudflare DNS v4 risk-based
 * classifier.
 *
 * Spec     : docs/spec/gateway-risk-model.md §3, §7.
 * Research : .vaubaan/research/providers/cloudflare-dns.md §2.
 *
 * Each test pins down :
 *   - the slice(s) emitted for a given (tool, args) call,
 *   - the account propagation from the binding into every slice,
 *   - the denials (unknown tool, no binding),
 *   - the absence of mode segment (no envScopable).
 */
import { describe, expect, test } from 'vitest';
import type { ProviderBinding } from '@vaubaan/shared';
import { serializeSlice } from '@vaubaan/policy-engine';

import { classifyCloudflareDnsV4 } from '../../src/risk-classifier.ts';

const binding: ProviderBinding = {
  id: 'b1',
  project_id: 'p1',
  provider: 'cloudflare-dns',
  resource_ref: 'acct_cf123',
  display_name: null,
  metadata: {},
  created_at: '2026-01-01',
};

function classify(
  tool: string,
  args: Record<string, unknown> = {},
  bindings: ReadonlyArray<ProviderBinding> = [binding],
): string[] {
  const result = classifyCloudflareDnsV4(tool, args, bindings);
  if ('denied' in result) {
    throw new Error(`unexpected denial: ${result.denied}`);
  }
  return result.slices.map((s) => serializeSlice(s));
}

describe('classifyCloudflareDnsV4 — reads (zones)', () => {
  test('list_zones -> zone[*].R', () => {
    expect(classify('cloudflare_dns__list_zones')).toEqual([
      'cloudflare-dns.account[acct_cf123].zone[*].R',
    ]);
  });

  test('get_zone(zone_id=z1) -> zone[z1].R', () => {
    expect(classify('cloudflare_dns__get_zone', { zone_id: 'z1' })).toEqual([
      'cloudflare-dns.account[acct_cf123].zone[z1].R',
    ]);
  });
});

describe('classifyCloudflareDnsV4 — reads (records)', () => {
  test('list_records(zone_id=z1) -> zone[z1].record[*].R', () => {
    expect(classify('cloudflare_dns__list_records', { zone_id: 'z1' })).toEqual([
      'cloudflare-dns.account[acct_cf123].zone[z1].record[*].R',
    ]);
  });

  test('get_record(zone_id=z1, record_id=r1) -> zone[z1].record[r1].R', () => {
    expect(classify('cloudflare_dns__get_record', { zone_id: 'z1', record_id: 'r1' })).toEqual([
      'cloudflare-dns.account[acct_cf123].zone[z1].record[r1].R',
    ]);
  });
});

describe('classifyCloudflareDnsV4 — reads (export, settings, dnssec)', () => {
  test('export_records(zone_id=z1) -> zone[z1].zone-export.R', () => {
    expect(classify('cloudflare_dns__export_records', { zone_id: 'z1' })).toEqual([
      'cloudflare-dns.account[acct_cf123].zone[z1].zone-export.R',
    ]);
  });

  test('get_zone_settings(zone_id=z1) -> zone[z1].zone-settings.R', () => {
    expect(classify('cloudflare_dns__get_zone_settings', { zone_id: 'z1' })).toEqual([
      'cloudflare-dns.account[acct_cf123].zone[z1].zone-settings.R',
    ]);
  });

  test('get_dnssec(zone_id=z1) -> zone[z1].dnssec.R', () => {
    expect(classify('cloudflare_dns__get_dnssec', { zone_id: 'z1' })).toEqual([
      'cloudflare-dns.account[acct_cf123].zone[z1].dnssec.R',
    ]);
  });
});

describe('classifyCloudflareDnsV4 — writes (record CRUD)', () => {
  test('create_record(zone_id=z1) -> zone[z1].record.W (no ident)', () => {
    expect(classify('cloudflare_dns__create_record', { zone_id: 'z1' })).toEqual([
      'cloudflare-dns.account[acct_cf123].zone[z1].record.W',
    ]);
  });

  test('update_record(zone_id=z1, record_id=r1) -> zone[z1].record[r1].W', () => {
    expect(classify('cloudflare_dns__update_record', { zone_id: 'z1', record_id: 'r1' })).toEqual([
      'cloudflare-dns.account[acct_cf123].zone[z1].record[r1].W',
    ]);
  });

  test('delete_record(zone_id=z1, record_id=r1) -> zone[z1].record[r1].W', () => {
    expect(classify('cloudflare_dns__delete_record', { zone_id: 'z1', record_id: 'r1' })).toEqual([
      'cloudflare-dns.account[acct_cf123].zone[z1].record[r1].W',
    ]);
  });
});

describe('classifyCloudflareDnsV4 — writes (import, settings, cache, dnssec)', () => {
  test('import_records(zone_id=z1) -> zone[z1].zone-import.W', () => {
    expect(classify('cloudflare_dns__import_records', { zone_id: 'z1' })).toEqual([
      'cloudflare-dns.account[acct_cf123].zone[z1].zone-import.W',
    ]);
  });

  test('edit_zone_settings(zone_id=z1) -> zone[z1].zone-settings.W', () => {
    expect(classify('cloudflare_dns__edit_zone_settings', { zone_id: 'z1' })).toEqual([
      'cloudflare-dns.account[acct_cf123].zone[z1].zone-settings.W',
    ]);
  });

  test('purge_cache(zone_id=z1) -> zone[z1].cache.W', () => {
    expect(classify('cloudflare_dns__purge_cache', { zone_id: 'z1' })).toEqual([
      'cloudflare-dns.account[acct_cf123].zone[z1].cache.W',
    ]);
  });

  test('edit_dnssec(zone_id=z1) -> zone[z1].dnssec.W', () => {
    expect(classify('cloudflare_dns__edit_dnssec', { zone_id: 'z1' })).toEqual([
      'cloudflare-dns.account[acct_cf123].zone[z1].dnssec.W',
    ]);
  });
});

describe('classifyCloudflareDnsV4 — writes (zone delete)', () => {
  test('delete_zone(zone_id=z1) -> zone[z1].W (zone-level write, no sub-entity)', () => {
    expect(classify('cloudflare_dns__delete_zone', { zone_id: 'z1' })).toEqual([
      'cloudflare-dns.account[acct_cf123].zone[z1].W',
    ]);
  });
});

describe('classifyCloudflareDnsV4 — account propagation from binding', () => {
  test('account_id from resource_ref appears in slices', () => {
    expect(classify('cloudflare_dns__list_zones', {}, [binding])).toEqual([
      'cloudflare-dns.account[acct_cf123].zone[*].R',
    ]);
  });

  test('binding without resource_ref falls back to account[*] (safe wildcard)', () => {
    const noRef: ProviderBinding = {
      ...binding,
      resource_ref: '',
    };
    expect(classify('cloudflare_dns__list_zones', {}, [noRef])).toEqual([
      'cloudflare-dns.account[*].zone[*].R',
    ]);
  });

  test('no mode segment in slices (DNS has no test/live)', () => {
    const sl = classify('cloudflare_dns__list_zones');
    // Should NOT contain 'mode' anywhere in the serialized slice
    for (const s of sl) {
      expect(s).not.toContain('mode');
    }
  });
});

describe('classifyCloudflareDnsV4 — denials', () => {
  test('unknown tool -> denied', () => {
    const result = classifyCloudflareDnsV4('cloudflare_dns__bogus', {}, [binding]);
    expect(result).toEqual({ denied: "unknown cloudflare-dns tool 'cloudflare_dns__bogus'." });
  });

  test('no cloudflare-dns binding on the token -> denied', () => {
    const result = classifyCloudflareDnsV4('cloudflare_dns__list_zones', {}, []);
    expect(result).toEqual({
      denied: 'no cloudflare-dns binding is attached to this token.',
    });
  });

  test('non-cloudflare-dns bindings are ignored (binding picker)', () => {
    const other: ProviderBinding = {
      ...binding,
      provider: 'stripe',
    };
    const result = classifyCloudflareDnsV4('cloudflare_dns__list_zones', {}, [other]);
    expect(result).toEqual({
      denied: 'no cloudflare-dns binding is attached to this token.',
    });
  });
});

describe('classifyCloudflareDnsV4 — future tools fall through to denied (MVP scope)', () => {
  for (const tool of [
    'cloudflare_dns__create_zone',
    'cloudflare_dns__batch_records',
    'cloudflare_dns__delete_dnssec',
    'cloudflare_dns__list_firewall_rules',
  ]) {
    test(`'${tool}' is denied at the classifier (fail-loud)`, () => {
      const result = classifyCloudflareDnsV4(tool, {}, [binding]);
      expect(result).toHaveProperty('denied');
    });
  }
});
