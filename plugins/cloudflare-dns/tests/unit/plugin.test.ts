/**
 * Mandatory suite of the Cloudflare DNS plugin : the SDK kit, the v5
 * classifier (zone resolution, critical / delete overlays, malformed ids),
 * `execute` and `discoverResources` against `mockFetch`, the credential spec
 * and the presets. The v4 classifier cases live unchanged in
 * `risk-classifier.test.ts`.
 */
import { describe, expect, test } from 'vitest';

import {
  parseSlice,
  serializeSlice,
  type ConnectionContext,
  type ExecuteContext,
  type Resource,
} from '@vaubaan/plugin-sdk';
import {
  assertCatalogCoverage,
  assertNoWildcard,
  assertPluginWellFormed,
  assertPresetsValid,
  mockFetch,
} from '@vaubaan/plugin-sdk/testing';

import {
  CLOUDFLARE_API_BASE,
  MAX_DISCOVERED_ZONES,
  classifyCloudflareDns,
  cloudflareDnsPlugin,
  isCriticalRecord,
  recordSensitivity,
} from '../../src/index.ts';

const BASE = CLOUDFLARE_API_BASE;

const exampleCom: Resource = {
  provider: 'cloudflare-dns',
  ref: 'z1',
  displayName: 'example.com',
  metadata: { account_id: 'acct1', zone_name: 'example.com' },
};
const exampleOrg: Resource = {
  provider: 'cloudflare-dns',
  ref: 'z2',
  displayName: 'example.org',
  metadata: { account_id: 'acct1', zone_name: 'example.org' },
};
const otherNet: Resource = {
  provider: 'cloudflare-dns',
  ref: 'z3',
  displayName: 'other.net',
  metadata: { account_id: 'acct2', zone_name: 'other.net' },
};
const github: Resource = { provider: 'github', ref: 'acme/app', displayName: 'app' };

const slices = (
  tool: string,
  args: Record<string, unknown> = {},
  resources: readonly Resource[] = [exampleCom],
) => {
  const out = classifyCloudflareDns(tool, args, resources);
  if ('denied' in out) throw new Error(out.denied);
  return out.slices.map(serializeSlice);
};
const denied = (
  tool: string,
  args: Record<string, unknown> = {},
  resources: readonly Resource[] = [exampleCom],
) => {
  const out = classifyCloudflareDns(tool, args, resources);
  return 'denied' in out ? out.denied : null;
};

describe('cloudflare-dns plugin — structural kit', () => {
  test('well-formed, presets valid, no wildcard', () => {
    assertPluginWellFormed(cloudflareDnsPlugin);
    assertPresetsValid(cloudflareDnsPlugin);
    assertNoWildcard(cloudflareDnsPlugin);
  });

  test('every tool classifies to slices the catalog covers ; every risk is touched', () => {
    const report = assertCatalogCoverage(
      cloudflareDnsPlugin,
      {
        cloudflare_dns__list_zones: [
          { args: {} },
          { args: {}, resources: [github], expectDenied: true },
        ],
        cloudflare_dns__get_zone: [{ args: { zone_id: 'z1' } }],
        cloudflare_dns__list_records: [{ args: { zone_id: 'z1', type: 'A' } }],
        cloudflare_dns__get_record: [{ args: { zone_id: 'z1', record_id: 'r1' } }],
        cloudflare_dns__export_records: [{ args: { zone_id: 'z1' } }],
        cloudflare_dns__get_zone_settings: [{ args: { zone_id: 'z1' } }],
        cloudflare_dns__get_dnssec: [{ args: { zone_id: 'z1' } }],
        cloudflare_dns__create_record: [
          { args: { zone_id: 'z1', type: 'A', name: 'www.example.com', content: '192.0.2.1' } },
          { args: { zone_id: 'z1', type: 'A', name: 'example.com', content: '192.0.2.1' } },
        ],
        cloudflare_dns__update_record: [
          { args: { zone_id: 'z1', record_id: 'r1', type: 'A', name: 'www.example.com' } },
          { args: { zone_id: 'z1', record_id: 'r1', type: 'MX', name: 'example.com' } },
          { args: { zone_id: 'z1', type: 'A', name: 'www.example.com' }, expectDenied: true },
        ],
        cloudflare_dns__delete_record: [{ args: { zone_id: 'z1', record_id: 'r1' } }],
        cloudflare_dns__import_records: [{ args: { zone_id: 'z1', file: ';; bind' } }],
        cloudflare_dns__edit_zone_settings: [
          { args: { zone_id: 'z1', items: [{ id: 'ssl', value: 'strict' }] } },
        ],
        cloudflare_dns__purge_cache: [{ args: { zone_id: 'z1', purge_everything: true } }],
        cloudflare_dns__edit_dnssec: [{ args: { zone_id: 'z1', status: 'active' } }],
        cloudflare_dns__delete_zone: [{ args: { zone_id: 'z1' } }],
      },
      { resources: [exampleCom] },
    );
    expect(report.toolsChecked).toBe(15);
    expect(report.risksUntouched).toEqual([]);
  });
});

describe('classifyCloudflareDns — zone resolution', () => {
  test('the single zone of the mission is the target ; account from metadata', () => {
    expect(slices('cloudflare_dns__get_zone', {})).toEqual([
      'cloudflare-dns.account[acct1].zone[z1].R',
    ]);
    expect(slices('cloudflare_dns__get_zone', { zone_id: 'z1' })).toEqual([
      'cloudflare-dns.account[acct1].zone[z1].R',
    ]);
  });

  test('the explicit zone_id picks among several zones', () => {
    const both = [exampleCom, exampleOrg];
    expect(slices('cloudflare_dns__list_records', { zone_id: 'z2' }, both)).toEqual([
      'cloudflare-dns.account[acct1].zone[z2].record[*].R',
    ]);
  });

  test('refuses an ambiguous, absent, unknown or malformed zone', () => {
    const both = [exampleCom, exampleOrg];
    expect(denied('cloudflare_dns__get_zone', {}, both)).toMatch(/touches 2 Cloudflare DNS zones/);
    expect(denied('cloudflare_dns__get_zone', {}, [])).toMatch(/touches no Cloudflare DNS zone/);
    expect(denied('cloudflare_dns__get_zone', { zone_id: 'z9' }, both)).toMatch(
      /not a Cloudflare DNS zone of this mission/,
    );
    expect(denied('cloudflare_dns__get_zone', { zone_id: 'z 1' })).toBe(
      'zone_id: malformed zone id',
    );
    expect(denied('cloudflare_dns__get_zone', { zone_id: 42 })).toBe('zone_id: malformed zone id');
  });

  test('ignores resources of other providers ; account[*] when the metadata lacks it', () => {
    const bare: Resource = { provider: 'cloudflare-dns', ref: 'z7', displayName: 'bare.io' };
    expect(slices('cloudflare_dns__get_zone', {}, [github, bare])).toEqual([
      'cloudflare-dns.account[*].zone[z7].R',
    ]);
  });

  test('list_zones is account-wide : shared account, else account[*] ; denied without a zone', () => {
    expect(slices('cloudflare_dns__list_zones', {}, [exampleCom, exampleOrg])).toEqual([
      'cloudflare-dns.account[acct1].zone[*].R',
    ]);
    expect(slices('cloudflare_dns__list_zones', {}, [exampleCom, otherNet])).toEqual([
      'cloudflare-dns.account[*].zone[*].R',
    ]);
    expect(denied('cloudflare_dns__list_zones', {}, [github])).toBe(
      'the mission touches no Cloudflare DNS zone',
    );
  });
});

describe('classifyCloudflareDns — record writes', () => {
  test('an ordinary subdomain record write emits record.W only', () => {
    expect(
      slices('cloudflare_dns__create_record', {
        zone_id: 'z1',
        type: 'A',
        name: 'www.example.com',
        content: '192.0.2.1',
      }),
    ).toEqual(['cloudflare-dns.account[acct1].zone[z1].record.W']);
    expect(
      slices('cloudflare_dns__update_record', {
        zone_id: 'z1',
        record_id: 'r1',
        type: 'CNAME',
        name: 'api.example.com',
      }),
    ).toEqual(['cloudflare-dns.account[acct1].zone[z1].record[r1].W']);
  });

  test('apex, wildcard, MX and NS writes also emit the critical overlay', () => {
    const critical = (args: Record<string, unknown>) =>
      slices('cloudflare_dns__create_record', { zone_id: 'z1', content: 'x', ...args });
    const expected = [
      'cloudflare-dns.account[acct1].zone[z1].record.W',
      'cloudflare-dns.account[acct1].zone[z1].record.critical.W',
    ];
    expect(critical({ type: 'A', name: 'example.com' })).toEqual(expected);
    expect(critical({ type: 'A', name: 'EXAMPLE.COM.' })).toEqual(expected);
    expect(critical({ type: 'TXT', name: '@' })).toEqual(expected);
    expect(critical({ type: 'A', name: '*.example.com' })).toEqual(expected);
    expect(critical({ type: 'mx', name: 'mail.example.com' })).toEqual(expected);
    expect(critical({ type: 'NS', name: 'sub.example.com' })).toEqual(expected);
    expect(
      slices('cloudflare_dns__update_record', {
        zone_id: 'z1',
        record_id: 'r1',
        type: 'MX',
        name: 'example.com',
      }),
    ).toEqual([
      'cloudflare-dns.account[acct1].zone[z1].record[r1].W',
      'cloudflare-dns.account[acct1].zone[z1].record[r1].critical.W',
    ]);
  });

  test('an under-specified write, or an unknown zone name, is critical by default', () => {
    expect(
      slices('cloudflare_dns__update_record', { zone_id: 'z1', record_id: 'r1', content: 'x' }),
    ).toEqual([
      'cloudflare-dns.account[acct1].zone[z1].record[r1].W',
      'cloudflare-dns.account[acct1].zone[z1].record[r1].critical.W',
    ]);
    const nameless: Resource = { provider: 'cloudflare-dns', ref: 'z8', displayName: '' };
    expect(
      slices(
        'cloudflare_dns__create_record',
        { type: 'A', name: 'www.example.com', content: 'x' },
        [nameless],
      ),
    ).toHaveLength(2);
  });

  test('deletion emits the delete verb leaf ; record_id is required and validated', () => {
    expect(slices('cloudflare_dns__delete_record', { zone_id: 'z1', record_id: 'r1' })).toEqual([
      'cloudflare-dns.account[acct1].zone[z1].record[r1].delete.W',
    ]);
    expect(denied('cloudflare_dns__delete_record', { zone_id: 'z1' })).toBe('record_id: missing');
    expect(denied('cloudflare_dns__get_record', { zone_id: 'z1', record_id: 'r 1' })).toBe(
      'record_id: malformed identifier',
    );
    expect(denied('cloudflare_dns__update_record', { zone_id: 'z1', record_id: ['r1'] })).toBe(
      'record_id: malformed identifier',
    );
  });

  test('zone-level writes and the unknown tool', () => {
    expect(slices('cloudflare_dns__delete_zone', { zone_id: 'z1' })).toEqual([
      'cloudflare-dns.account[acct1].zone[z1].W',
    ]);
    expect(slices('cloudflare_dns__edit_dnssec', { zone_id: 'z1', status: 'active' })).toEqual([
      'cloudflare-dns.account[acct1].zone[z1].dnssec.W',
    ]);
    expect(denied('cloudflare_dns__create_zone', { name: 'new.com' })).toBe(
      "unknown cloudflare-dns tool 'cloudflare_dns__create_zone'.",
    );
  });

  test('emitted slices parse back (round-trip)', () => {
    for (const s of slices('cloudflare_dns__update_record', {
      zone_id: 'z1',
      record_id: 'r1',
      type: 'MX',
      name: 'example.com',
    })) {
      expect(serializeSlice(parseSlice(s))).toBe(s);
    }
  });
});

describe('isCriticalRecord / recordSensitivity', () => {
  test('conservative on empty, non-ASCII, unknown zone', () => {
    expect(isCriticalRecord('A', '', 'example.com')).toBe(true);
    expect(isCriticalRecord('A', 'bücher.example.com', 'example.com')).toBe(true);
    expect(isCriticalRecord('A', 'www.example.com', null)).toBe(true);
    expect(isCriticalRecord('A', 'www.example.com', 'example.com')).toBe(false);
    expect(isCriticalRecord('A', 'www.example.com.', 'Example.com')).toBe(false);
    expect(isCriticalRecord('A', '*.dev.example.com', 'example.com')).toBe(false);
    expect(isCriticalRecord('A', '*', 'example.com')).toBe(true);
  });

  test('recordSensitivity needs both type and name as strings', () => {
    expect(recordSensitivity({ type: 'A', name: 'www.example.com' }, 'example.com')).toBe(
      'regular',
    );
    expect(recordSensitivity({ type: 'A' }, 'example.com')).toBe('critical');
    expect(recordSensitivity({ type: 1, name: 'www.example.com' }, 'example.com')).toBe('critical');
  });
});

describe('executeCloudflareDns with mockFetch', () => {
  const credential = {
    kind: 'api-key' as const,
    fields: { api_token: 'cf_token_0123456789abcdef' },
    metadata: {},
  };
  const ctx = (
    fetch: typeof globalThis.fetch,
    resources: readonly Resource[] = [exampleCom],
  ): ExecuteContext => ({ credential, appConfig: {}, fetch, resources });
  const text = (r: { content: readonly unknown[] }) => (r.content[0] as { text: string }).text;

  test('GET with the bearer ; zone from the resource ; zone_id consumed, filters forwarded', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: `${BASE}/zones/z1/dns_records?type=A&per_page=5`,
        body: { result: [{ id: 'r1' }] },
      },
    ]);
    const result = await cloudflareDnsPlugin.execute(ctx(fetch), 'cloudflare_dns__list_records', {
      zone_id: 'z1',
      type: 'A',
      per_page: 5,
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(text(result))).toEqual({ result: [{ id: 'r1' }] });
    expect(fetch.calls[0]!.headers.authorization).toBe('Bearer cf_token_0123456789abcdef');
  });

  test('list_zones is filtered to the zones of the mission', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: `${BASE}/zones?per_page=50`,
        body: {
          result: [
            { id: 'z1', name: 'example.com' },
            { id: 'z9', name: 'secret.io' },
          ],
          result_info: { count: 2 },
        },
      },
    ]);
    const result = await cloudflareDnsPlugin.execute(ctx(fetch), 'cloudflare_dns__list_zones', {
      per_page: 50,
    });
    expect(JSON.parse(text(result))).toEqual({
      result: [{ id: 'z1', name: 'example.com' }],
      result_info: { count: 2 },
    });
  });

  test('refuses to run without a resolvable zone or with a foreign zone id', async () => {
    const fetch = mockFetch([]);
    await expect(
      cloudflareDnsPlugin.execute(
        ctx(fetch, [exampleCom, exampleOrg]),
        'cloudflare_dns__get_zone',
        {},
      ),
    ).rejects.toThrow(/touches 2 Cloudflare DNS zones/);
    await expect(
      cloudflareDnsPlugin.execute(ctx(fetch), 'cloudflare_dns__get_zone', { zone_id: 'z9' }),
    ).rejects.toThrow(/not a Cloudflare DNS zone of this mission/);
    expect(fetch.calls).toHaveLength(0);
  });

  test('create_record POSTs JSON without zone_id ; delete sends no body', async () => {
    const fetch = mockFetch([
      { method: 'POST', url: `${BASE}/zones/z1/dns_records`, body: { result: { id: 'r2' } } },
      { method: 'DELETE', url: `${BASE}/zones/z1/dns_records/r2`, body: { result: { id: 'r2' } } },
    ]);
    await cloudflareDnsPlugin.execute(ctx(fetch), 'cloudflare_dns__create_record', {
      zone_id: 'z1',
      type: 'A',
      name: 'www.example.com',
      content: '192.0.2.1',
      proxied: true,
    });
    expect(fetch.calls[0]!.headers['content-type']).toBe('application/json');
    expect(fetch.calls[0]!.json).toEqual({
      type: 'A',
      name: 'www.example.com',
      content: '192.0.2.1',
      proxied: true,
    });
    await cloudflareDnsPlugin.execute(ctx(fetch), 'cloudflare_dns__delete_record', {
      zone_id: 'z1',
      record_id: 'r2',
    });
    expect(fetch.calls[1]!.body).toBeNull();
    expect(fetch.pending()).toEqual([]);
  });

  test('update_record declared ordinary : reads the record first, then PATCHes', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: `${BASE}/zones/z1/dns_records/r1`,
        body: { result: { id: 'r1', type: 'A', name: 'www.example.com' } },
        times: 1,
      },
      {
        method: 'PATCH',
        url: `${BASE}/zones/z1/dns_records/r1`,
        body: { result: { id: 'r1' } },
        times: 1,
      },
    ]);
    await cloudflareDnsPlugin.execute(ctx(fetch), 'cloudflare_dns__update_record', {
      zone_id: 'z1',
      record_id: 'r1',
      type: 'A',
      name: 'www.example.com',
      content: '192.0.2.2',
    });
    expect(fetch.calls.map((c) => c.method)).toEqual(['GET', 'PATCH']);
    expect(fetch.calls[1]!.json).toEqual({
      type: 'A',
      name: 'www.example.com',
      content: '192.0.2.2',
    });
    expect(fetch.pending()).toEqual([]);
  });

  test('update_record declared ordinary on a critical record is refused before the PATCH', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: `${BASE}/zones/z1/dns_records/r1`,
        body: { result: { id: 'r1', type: 'A', name: 'example.com' } },
      },
    ]);
    await expect(
      cloudflareDnsPlugin.execute(ctx(fetch), 'cloudflare_dns__update_record', {
        zone_id: 'z1',
        record_id: 'r1',
        type: 'A',
        name: 'www.example.com',
        content: '192.0.2.2',
      }),
    ).rejects.toThrow(/critical record \(A example.com\)/);
    expect(fetch.calls.map((c) => c.method)).toEqual(['GET']);
  });

  test('update_record declared critical goes straight to the PATCH', async () => {
    const fetch = mockFetch([
      { method: 'PATCH', url: `${BASE}/zones/z1/dns_records/r1`, body: { result: { id: 'r1' } } },
    ]);
    await cloudflareDnsPlugin.execute(ctx(fetch), 'cloudflare_dns__update_record', {
      zone_id: 'z1',
      record_id: 'r1',
      type: 'MX',
      name: 'example.com',
      content: 'mail.example.com',
      priority: 10,
    });
    expect(fetch.calls.map((c) => c.method)).toEqual(['PATCH']);
  });

  test('import_records sends the BIND file as multipart ; export returns the BIND text', async () => {
    const bind = '$ORIGIN example.com.\nwww 300 IN A 192.0.2.1\n';
    const fetch = mockFetch([
      {
        method: 'POST',
        url: `${BASE}/zones/z1/dns_records/import`,
        body: { result: { recs_added: 1 } },
      },
      { method: 'GET', url: `${BASE}/zones/z1/dns_records/export`, body: bind },
    ]);
    await cloudflareDnsPlugin.execute(ctx(fetch), 'cloudflare_dns__import_records', {
      zone_id: 'z1',
      file: bind,
    });
    expect(fetch.calls[0]!.headers['content-type']).toBeUndefined();
    expect(fetch.calls[0]!.body).toContain('name="file"');
    expect(fetch.calls[0]!.body).toContain('www 300 IN A 192.0.2.1');
    const exported = await cloudflareDnsPlugin.execute(
      ctx(fetch),
      'cloudflare_dns__export_records',
      {
        zone_id: 'z1',
      },
    );
    expect(text(exported)).toBe(bind);
  });

  test('zone-level routes : settings, purge, dnssec, delete_zone', async () => {
    const fetch = mockFetch([
      { method: 'PATCH', url: `${BASE}/zones/z1/settings`, body: { result: [] } },
      { method: 'POST', url: `${BASE}/zones/z1/purge_cache`, body: { result: { id: 'z1' } } },
      { method: 'PATCH', url: `${BASE}/zones/z1/dnssec`, body: { result: { status: 'active' } } },
      { method: 'DELETE', url: `${BASE}/zones/z1`, body: { result: { id: 'z1' } } },
    ]);
    const c = ctx(fetch);
    await cloudflareDnsPlugin.execute(c, 'cloudflare_dns__edit_zone_settings', {
      zone_id: 'z1',
      items: [{ id: 'ssl', value: 'strict' }],
    });
    await cloudflareDnsPlugin.execute(c, 'cloudflare_dns__purge_cache', {
      zone_id: 'z1',
      purge_everything: true,
    });
    await cloudflareDnsPlugin.execute(c, 'cloudflare_dns__edit_dnssec', {
      zone_id: 'z1',
      status: 'active',
    });
    await cloudflareDnsPlugin.execute(c, 'cloudflare_dns__delete_zone', { zone_id: 'z1' });
    expect(fetch.calls[0]!.json).toEqual({ items: [{ id: 'ssl', value: 'strict' }] });
    expect(fetch.calls[1]!.json).toEqual({ purge_everything: true });
    expect(fetch.calls[2]!.json).toEqual({ status: 'active' });
    expect(fetch.calls[3]!.body).toBeNull();
  });

  test('401 and 403 become UpstreamAuthError ; other errors are plain', async () => {
    const fetch = mockFetch([
      { url: /\/zones\/z1$/, status: 403, body: { success: false, errors: [{ code: 9109 }] } },
      { url: /\/dns_records$/, status: 429, body: { success: false } },
    ]);
    await expect(
      cloudflareDnsPlugin.execute(ctx(fetch), 'cloudflare_dns__get_zone', { zone_id: 'z1' }),
    ).rejects.toMatchObject({ name: 'UpstreamAuthError', upstreamStatus: 403 });
    await expect(
      cloudflareDnsPlugin.execute(ctx(fetch), 'cloudflare_dns__list_records', { zone_id: 'z1' }),
    ).rejects.toThrow(/429/);
  });

  test('unknown tool is an error result, not a call ; a secret of another kind is refused', async () => {
    const fetch = mockFetch([]);
    const result = await cloudflareDnsPlugin.execute(ctx(fetch), 'cloudflare_dns__nope', {});
    expect(result.isError).toBe(true);
    const oauth: ExecuteContext = {
      ...ctx(fetch),
      credential: {
        kind: 'oauth2',
        accessToken: 't',
        refreshToken: null,
        expiresAt: null,
        scopes: [],
        metadata: {},
      },
    };
    await expect(
      cloudflareDnsPlugin.execute(oauth, 'cloudflare_dns__get_zone', { zone_id: 'z1' }),
    ).rejects.toMatchObject({ name: 'CredentialKindMismatch' });
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('discoverCloudflareDnsResources with mockFetch', () => {
  const ctx = (
    fetch: typeof globalThis.fetch,
    token = 'cf_token_0123456789abcdef',
  ): ConnectionContext => ({
    credential: { kind: 'api-key', fields: { api_token: token }, metadata: {} },
    appConfig: {},
    fetch,
  });
  const zone = (i: number, account = 'acct1') => ({
    id: `z${i}`,
    name: `zone${i}.example`,
    status: 'active',
    account: { id: account, name: 'Acme' },
  });
  const pageOf = (url: string) => Number(new URL(url).searchParams.get('page'));

  test('one resource per zone, ref = zone id, metadata carries account and zone name', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: `${BASE}/zones?page=1&per_page=50`,
        body: { result: [zone(1), zone(2, 'acct2')], result_info: { total_pages: 1 } },
      },
    ]);
    const resources = await cloudflareDnsPlugin.discoverResources(ctx(fetch));
    expect(resources).toEqual([
      {
        provider: 'cloudflare-dns',
        ref: 'z1',
        displayName: 'zone1.example',
        metadata: {
          zone_name: 'zone1.example',
          account_id: 'acct1',
          account_name: 'Acme',
          status: 'active',
        },
      },
      {
        provider: 'cloudflare-dns',
        ref: 'z2',
        displayName: 'zone2.example',
        metadata: {
          zone_name: 'zone2.example',
          account_id: 'acct2',
          account_name: 'Acme',
          status: 'active',
        },
      },
    ]);
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]!.headers.authorization).toBe('Bearer cf_token_0123456789abcdef');
    expect(fetch.calls[0]!.url).not.toContain('account');
  });

  test('follows result_info.total_pages and stops at the cap', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: (u) => u.startsWith(`${BASE}/zones?page=`),
        respond: (call) => {
          const page = pageOf(call.url);
          const count = page === 2 ? 3 : 50;
          return {
            result: Array.from({ length: count }, (_, i) => zone((page - 1) * 50 + i + 1)),
            result_info: { total_pages: 2 },
          };
        },
      },
    ]);
    const resources = await cloudflareDnsPlugin.discoverResources(ctx(fetch));
    expect(resources).toHaveLength(53);
    expect(fetch.calls.map((c) => pageOf(c.url))).toEqual([1, 2]);

    const endless = mockFetch([
      {
        method: 'GET',
        url: (u) => u.startsWith(`${BASE}/zones?page=`),
        respond: (call) => ({
          result: Array.from({ length: 50 }, (_, i) => zone((pageOf(call.url) - 1) * 50 + i + 1)),
          result_info: { total_pages: 1000 },
        }),
      },
    ]);
    const capped = await cloudflareDnsPlugin.discoverResources(ctx(endless));
    expect(capped).toHaveLength(MAX_DISCOVERED_ZONES);
    expect(endless.calls).toHaveLength(MAX_DISCOVERED_ZONES / 50);
  });

  test('a rejected token surfaces as UpstreamAuthError ; an empty token never calls out', async () => {
    const fetch = mockFetch([
      { url: /\/zones\?/, status: 401, body: { success: false, errors: [{ code: 10000 }] } },
    ]);
    await expect(cloudflareDnsPlugin.discoverResources(ctx(fetch))).rejects.toMatchObject({
      name: 'UpstreamAuthError',
      upstreamStatus: 401,
    });
    const silent = mockFetch([]);
    await expect(cloudflareDnsPlugin.discoverResources(ctx(silent, ''))).rejects.toThrow(
      /no 'api_token' field/,
    );
    expect(silent.calls).toHaveLength(0);
  });
});

describe('credential spec and presets', () => {
  test('api-key with one required secret field ; the pattern refuses a Global API Key', () => {
    const spec = cloudflareDnsPlugin.credential;
    expect(spec.kind).toBe('api-key');
    if (spec.kind !== 'api-key') return;
    expect(spec.createUrl).toBe('https://dash.cloudflare.com/profile/api-tokens');
    expect(spec.fields.map((f) => [f.name, f.secret, f.required])).toEqual([
      ['api_token', true, true],
    ]);
    const pattern = new RegExp(spec.fields[0]!.pattern ?? '(?!)');
    expect(pattern.test('Sn3lZJTBX6kkg7OdcBUAxOO963GEIyGQqnFTOFYY')).toBe(true);
    expect(pattern.test('user@example.com|144c9defac04969c7bfad8efaa8ea194')).toBe(false);
    expect(pattern.test('short')).toBe(false);
  });

  test('presets : read-only, dns-operator, zone-admin ; approval on the destructive entries', () => {
    const presets = cloudflareDnsPlugin.catalog.presets;
    expect(presets.map((p) => p.id)).toEqual(['read-only', 'dns-operator', 'zone-admin']);

    const ids = (id: string) => presets.find((p) => p.id === id)!.entries.map((e) => e.risk_id);
    expect(ids('read-only')).toEqual([
      'cloudflare-dns.read-zone-metadata',
      'cloudflare-dns.read-records',
    ]);
    const operator = ids('dns-operator');
    expect(operator).toContain('cloudflare-dns.record-write');
    for (const excluded of [
      'cloudflare-dns.critical-record-write',
      'cloudflare-dns.record-delete',
      'cloudflare-dns.import-records',
      'cloudflare-dns.zone-settings-write',
      'cloudflare-dns.dnssec-write',
      'cloudflare-dns.export-zone-file',
    ]) {
      expect(operator, excluded).not.toContain(excluded);
    }

    const admin = presets.find((p) => p.id === 'zone-admin')!;
    const approval = admin.entries
      .filter((e) => e.gate === 'approval')
      .map((e) => e.risk_id)
      .sort();
    expect(approval).toEqual([
      'cloudflare-dns.critical-record-write',
      'cloudflare-dns.dnssec-write',
      'cloudflare-dns.import-records',
      'cloudflare-dns.record-delete',
      'cloudflare-dns.zone-settings-write',
    ]);

    for (const preset of presets) {
      const risks = preset.entries.map((e) => e.risk_id);
      expect(risks, preset.id).not.toContain('cloudflare-dns.uncategorized-write');
      expect(risks, preset.id).not.toContain('cloudflare-dns.zone-delete');
    }
  });
});
