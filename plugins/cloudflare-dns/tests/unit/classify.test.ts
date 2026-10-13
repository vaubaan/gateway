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
 *   - the absence of any segment outside the data model (no mode, no env),
 *   - the refusal of identifiers that are not safe in a URL path.
 *
 * Zone resolution and the critical overlay are covered in depth by
 * `plugin.test.ts`.
 */
import { describe, expect, test } from 'vitest';

import { serializeSlice, type Resource } from '@vaubaan/plugin-sdk';

import { classifyCloudflareDns } from '../../src/classify.ts';
import { cloudflareDnsDataModel } from '../../src/data-model.ts';
import { cloudflareDnsTools } from '../../src/tools.ts';

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

  test('delete_record(zone_id=z1, record_id=r1, ordinary record) -> zone[z1].record[r1].delete.W', () => {
    expect(
      classify('cloudflare_dns__delete_record', { zone_id: 'z1', record_id: 'r1', ...ordinary }),
    ).toEqual(['cloudflare-dns.account[acct_cf123].zone[z1].record[r1].delete.W']);
  });

  test('delete_record of an apex / MX / NS record also emits the critical overlay', () => {
    const expected = [
      'cloudflare-dns.account[acct_cf123].zone[z1].record[r1].delete.W',
      'cloudflare-dns.account[acct_cf123].zone[z1].record[r1].critical.W',
    ];
    for (const record of [
      { type: 'A', name: 'example.com' },
      { type: 'TXT', name: '@' },
      { type: 'A', name: '*.example.com' },
      { type: 'MX', name: 'mail.example.com' },
      { type: 'NS', name: 'sub.example.com' },
    ]) {
      expect(
        classify('cloudflare_dns__delete_record', { zone_id: 'z1', record_id: 'r1', ...record }),
        `${record.type} ${record.name}`,
      ).toEqual(expected);
    }
  });

  test('delete_record without type and name is critical (the record cannot be told apart)', () => {
    const expected = [
      'cloudflare-dns.account[acct_cf123].zone[z1].record[r1].delete.W',
      'cloudflare-dns.account[acct_cf123].zone[z1].record[r1].critical.W',
    ];
    expect(classify('cloudflare_dns__delete_record', { zone_id: 'z1', record_id: 'r1' })).toEqual(
      expected,
    );
    expect(
      classify('cloudflare_dns__delete_record', { zone_id: 'z1', record_id: 'r1', type: 'A' }),
    ).toEqual(expected);
    expect(
      classify('cloudflare_dns__delete_record', {
        zone_id: 'z1',
        record_id: 'r1',
        name: 'www.example.com',
      }),
    ).toEqual(expected);
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

  test('every tool emits slices rooted at the account, made of data-model entities only', () => {
    const entityNames = new Set(
      cloudflareDnsDataModel.planes.flatMap((plane) => plane.entities.map((e) => e.name)),
    );
    for (const { name: tool } of cloudflareDnsTools) {
      for (const args of [
        { zone_id: 'z1', record_id: 'r1' },
        { zone_id: 'z1', record_id: 'r1', ...ordinary },
      ]) {
        const result = classifyCloudflareDns(tool, args, [zone]);
        if ('denied' in result) throw new Error(`${tool}: unexpected denial: ${result.denied}`);
        expect(result.slices.length, tool).toBeGreaterThan(0);
        for (const s of result.slices) {
          expect(serializeSlice(s), tool).toMatch(/^cloudflare-dns\.account\[/);
          for (const segment of s.path) {
            if (segment.kind === 'name') {
              expect(entityNames.has(segment.value), `${tool}: '${segment.value}'`).toBe(true);
            }
          }
        }
      }
    }
  });
});

describe('classifyCloudflareDns — identifiers that reach the URL path', () => {
  const RECORD_TOOLS = [
    'cloudflare_dns__get_record',
    'cloudflare_dns__update_record',
    'cloudflare_dns__delete_record',
  ];

  test('a record_id that is a dot segment or holds a separator is refused', () => {
    for (const record_id of ['.', '..', '../..', 'r1/../r2', '~', 'a/b', 'a.b', 'r1?x=1', 'r1#x']) {
      for (const tool of RECORD_TOOLS) {
        expect(
          classifyCloudflareDns(tool, { zone_id: 'z1', record_id, ...ordinary }, [zone]),
          `${tool} ${record_id}`,
        ).toEqual({ denied: 'record_id: malformed identifier' });
      }
    }
  });

  test('a record_id longer than 64 characters is refused ; a 32-hex Cloudflare id passes', () => {
    expect(
      classifyCloudflareDns(
        'cloudflare_dns__get_record',
        { zone_id: 'z1', record_id: 'a'.repeat(65) },
        [zone],
      ),
    ).toEqual({ denied: 'record_id: malformed identifier' });
    expect(
      classify('cloudflare_dns__get_record', {
        zone_id: 'z1',
        record_id: '372e67954025e0ba6aaa6d586b9e0b59',
      }),
    ).toEqual([
      'cloudflare-dns.account[acct_cf123].zone[z1].record[372e67954025e0ba6aaa6d586b9e0b59].R',
    ]);
  });

  test('a missing, null or empty record_id is refused', () => {
    for (const record_id of [undefined, null, '']) {
      for (const tool of RECORD_TOOLS) {
        expect(
          classifyCloudflareDns(tool, { zone_id: 'z1', record_id, ...ordinary }, [zone]),
          `${tool} ${String(record_id)}`,
        ).toEqual({ denied: 'record_id: missing' });
      }
    }
  });

  test('a zone_id that is a dot segment, a wildcard or holds a separator is refused', () => {
    for (const zone_id of ['.', '..', '*', 'z1/..', 'z1/dns_records', 'a.b', '~']) {
      for (const tool of ['cloudflare_dns__get_zone', 'cloudflare_dns__delete_zone']) {
        expect(classifyCloudflareDns(tool, { zone_id }, [zone]), `${tool} ${zone_id}`).toEqual({
          denied: 'zone_id: malformed zone id',
        });
      }
    }
  });

  test('a mission zone whose ref is not path-safe is never targeted, even as the single zone', () => {
    const unsafe: Resource = { ...zone, ref: '..' };
    for (const args of [{}, { zone_id: '..' }]) {
      expect(classifyCloudflareDns('cloudflare_dns__delete_zone', args, [unsafe])).toEqual({
        denied: 'zone_id: malformed zone id',
      });
    }
  });

  test('an empty or null zone_id falls back to the single zone of the mission', () => {
    expect(classify('cloudflare_dns__get_zone', { zone_id: '' })).toEqual([
      'cloudflare-dns.account[acct_cf123].zone[z1].R',
    ]);
    expect(classify('cloudflare_dns__get_zone', { zone_id: null })).toEqual([
      'cloudflare-dns.account[acct_cf123].zone[z1].R',
    ]);
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
      expect(result).toEqual({ denied: `unknown cloudflare-dns tool '${tool}'.` });
    });
  }
});
