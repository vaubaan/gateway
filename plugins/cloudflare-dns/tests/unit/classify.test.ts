/**
 * Unit tests for `classifyCloudflareDns` — the per-tool security suite of the
 * Cloudflare DNS classifier ("a classification error is a security hole").
 *
 * Spec : docs/spec/gateway-risk-model.md §3, §7.
 *
 * Each test pins down :
 *   - the slice(s) emitted for a given (tool, args) call,
 *   - the account propagation from the zone resource into every slice,
 *   - the denials (unknown tool, no Cloudflare DNS zone in the mission),
 *   - the absence of mode segment (no envScopable).
 *
 * Zone resolution, the critical overlay and malformed identifiers are
 * covered in depth by `plugin.test.ts`.
 */
import { describe, expect, test } from 'vitest';

import { serializeSlice, type Resource } from '@vaubaan/plugin-sdk';

import { classifyCloudflareDns } from '../../src/classify.ts';

const zone: Resource = {
  provider: 'cloudflare-dns',
  ref: 'z1',
  displayName: 'example.com',
  metadata: { account_id: 'acct_cf123', zone_name: 'example.com' },
};

/** An ordinary subdomain record : keeps a record write out of the critical overlay. */
const ordinary = { type: 'A', name: 'www.example.com' };

function classify(
  tool: string,
  args: Record<string, unknown> = {},
  resources: readonly Resource[] = [zone],
): string[] {
  const result = classifyCloudflareDns(tool, args, resources);
  if ('denied' in result) {
    throw new Error(`unexpected denial: ${result.denied}`);
  }
  return result.slices.map((s) => serializeSlice(s));
}

describe('classifyCloudflareDns — reads (zones)', () => {
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

describe('classifyCloudflareDns — reads (records)', () => {
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

describe('classifyCloudflareDns — reads (export, settings, dnssec)', () => {
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

describe('classifyCloudflareDns — writes (record CRUD)', () => {
  test('create_record(zone_id=z1, ordinary record) -> zone[z1].record.W (no ident)', () => {
    expect(classify('cloudflare_dns__create_record', { zone_id: 'z1', ...ordinary })).toEqual([
      'cloudflare-dns.account[acct_cf123].zone[z1].record.W',
    ]);
  });

  test('update_record(zone_id=z1, record_id=r1, ordinary record) -> zone[z1].record[r1].W', () => {
    expect(
      classify('cloudflare_dns__update_record', { zone_id: 'z1', record_id: 'r1', ...ordinary }),
    ).toEqual(['cloudflare-dns.account[acct_cf123].zone[z1].record[r1].W']);
  });

  test('delete_record(zone_id=z1, record_id=r1) -> zone[z1].record[r1].delete.W', () => {
    expect(classify('cloudflare_dns__delete_record', { zone_id: 'z1', record_id: 'r1' })).toEqual([
      'cloudflare-dns.account[acct_cf123].zone[z1].record[r1].delete.W',
    ]);
  });
});

describe('classifyCloudflareDns — writes (import, settings, cache, dnssec)', () => {
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

describe('classifyCloudflareDns — writes (zone delete)', () => {
  test('delete_zone(zone_id=z1) -> zone[z1].W (zone-level write, no sub-entity)', () => {
    expect(classify('cloudflare_dns__delete_zone', { zone_id: 'z1' })).toEqual([
      'cloudflare-dns.account[acct_cf123].zone[z1].W',
    ]);
  });
});

describe('classifyCloudflareDns — account propagation from the zone resource', () => {
  test('account_id from the resource metadata appears in slices', () => {
    expect(classify('cloudflare_dns__list_zones', {}, [zone])).toEqual([
      'cloudflare-dns.account[acct_cf123].zone[*].R',
    ]);
  });

  test('resource without account_id falls back to account[*] (safe wildcard)', () => {
    const noAccount: Resource = {
      provider: 'cloudflare-dns',
      ref: 'z1',
      displayName: 'example.com',
    };
    expect(classify('cloudflare_dns__list_zones', {}, [noAccount])).toEqual([
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

describe('classifyCloudflareDns — denials', () => {
  test('unknown tool -> denied', () => {
    const result = classifyCloudflareDns('cloudflare_dns__bogus', {}, [zone]);
    expect(result).toEqual({ denied: "unknown cloudflare-dns tool 'cloudflare_dns__bogus'." });
  });

  test('no cloudflare-dns resource in the mission -> denied', () => {
    const result = classifyCloudflareDns('cloudflare_dns__list_zones', {}, []);
    expect(result).toEqual({ denied: 'the mission touches no Cloudflare DNS zone' });
  });

  test('resources of other providers are ignored', () => {
    const other: Resource = { ...zone, provider: 'stripe' };
    const result = classifyCloudflareDns('cloudflare_dns__list_zones', {}, [other]);
    expect(result).toEqual({ denied: 'the mission touches no Cloudflare DNS zone' });
  });
});

describe('classifyCloudflareDns — undeclared tools are denied (fail-loud)', () => {
  for (const tool of [
    'cloudflare_dns__create_zone',
    'cloudflare_dns__batch_records',
    'cloudflare_dns__delete_dnssec',
    'cloudflare_dns__list_firewall_rules',
  ]) {
    test(`'${tool}' is denied at the classifier (fail-loud)`, () => {
      const result = classifyCloudflareDns(tool, {}, [zone]);
      expect(result).toHaveProperty('denied');
    });
  }
});
