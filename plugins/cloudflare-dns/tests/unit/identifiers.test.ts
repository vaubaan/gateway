/**
 * Identifier positions of the `cloudflare-dns` plugin, one grammar per kind
 * (`resources.ts`), shared by `classify` and `execute` :
 *
 *   - `zone_id`, `record_id`      request path            `pathIdent`
 *   - the zone's `account_id`     slice only              `pathIdent`
 *   - a record's `type` / `name`  JSON body, and the      `recordType` / `dnsName` —
 *                                 critical-record verdict  anything else is critical
 *   - list filters                query string            percent-encoded
 *
 * The cases are the ones that turn an identifier into something else : dot
 * segments (`encodeURIComponent` leaves them and URL parsers collapse them),
 * separators, percent-escapes, query and fragment delimiters, control
 * characters, an overlong value. A refused value reaches no request.
 */
import { describe, expect, test } from 'vitest';

import { serializeSlice, type ExecuteContext, type Resource } from '@vaubaan/plugin-sdk';
import { declaredOnly, mockFetch, type MockFetch } from '@vaubaan/plugin-sdk/testing';

import { classifyCloudflareDns } from '../../src/classify.ts';
import { CLOUDFLARE_API_BASE } from '../../src/execute.ts';
import { cloudflareDnsPlugin } from '../../src/index.ts';
import {
  accountIdOf,
  dnsName,
  isCriticalRecord,
  pathIdent,
  recordSensitivity,
  recordType,
} from '../../src/resources.ts';

const HOSTILE: readonly string[] = [
  '..',
  '.',
  'a/../b',
  'a/b',
  '%2e%2e',
  '%2f',
  '..%2f',
  'x'.repeat(5000),
  'r1\nx',
  'r1?x=1#y',
  'r1\\x',
  'r 1',
  'a.b',
  '*',
  'r１',
];

const ZONE_ID = '023e105f4ecef8ad9ca31a8372d0c353';
const RECORD_ID = '372e67954025e0ba6aaa6d586b9e0b59';
const ACCOUNT_ID = '01a7362d577a6c3019a474fd6f485823';

const zone: Resource = {
  provider: 'cloudflare-dns',
  ref: ZONE_ID,
  displayName: 'example.com',
  metadata: { account_id: ACCOUNT_ID, zone_name: 'example.com' },
};
const ROOT = `cloudflare-dns.account[${ACCOUNT_ID}].zone[${ZONE_ID}]`;

/** A Cloudflare that answers anything : a refusal shows as "no call", not as a mock error. */
function permissiveFetch(): MockFetch {
  return mockFetch([{ url: () => true, body: { result: { type: 'A', name: 'www.example.com' } } }]);
}

function ctx(fetch: MockFetch, resources: readonly Resource[] = [zone]): ExecuteContext {
  return {
    credential: { kind: 'api-key', fields: { api_token: 'cf_token' }, metadata: {} },
    appConfig: {},
    fetch,
    resources,
  };
}

function classify(
  tool: string,
  args: Record<string, unknown>,
  resources: readonly Resource[] = [zone],
): string[] | { denied: string } {
  const outcome = classifyCloudflareDns(tool, args, resources);
  return 'denied' in outcome ? outcome : outcome.slices.map((s) => serializeSlice(s));
}

/** Classify refuses with `reason` ; execute declines with it (an `isError` result) and sends nothing. */
async function expectRefused(
  tool: string,
  args: Record<string, unknown>,
  reason: string,
  executorReason: RegExp,
  resources: readonly Resource[] = [zone],
): Promise<void> {
  expect(classify(tool, args, resources), `${tool} ${JSON.stringify(args).slice(0, 80)}`).toEqual({
    denied: reason,
  });
  const fetch = permissiveFetch();
  const result = await cloudflareDnsPlugin.execute(ctx(fetch, resources), tool, args);
  expect(result.isError).toBe(true);
  expect((result.content[0] as { text: string }).text).toMatch(executorReason);
  expect(fetch.calls).toHaveLength(0);
}

/** The arguments of a matrix row that `tool` declares (one row serves a family of tools). */
const declared = (tool: string, args: Record<string, unknown>): Record<string, unknown> =>
  declaredOnly(cloudflareDnsPlugin, tool, args);

const ZONE_TOOLS: readonly string[] = [
  'cloudflare_dns__get_zone',
  'cloudflare_dns__list_records',
  'cloudflare_dns__export_records',
  'cloudflare_dns__get_zone_settings',
  'cloudflare_dns__get_dnssec',
  'cloudflare_dns__create_record',
  'cloudflare_dns__import_records',
  'cloudflare_dns__edit_zone_settings',
  'cloudflare_dns__purge_cache',
  'cloudflare_dns__edit_dnssec',
  'cloudflare_dns__delete_zone',
];

const RECORD_TOOLS: readonly string[] = [
  'cloudflare_dns__get_record',
  'cloudflare_dns__update_record',
  'cloudflare_dns__delete_record',
];

describe('the grammars', () => {
  test('pathIdent accepts Cloudflare ids and refuses anything else', () => {
    for (const id of [ZONE_ID, RECORD_ID, 'z1', 'a'.repeat(64)]) expect(pathIdent(id)).toBe(id);
    for (const value of [...HOSTILE, '', 'a'.repeat(65), '~', 42, null, undefined, [ZONE_ID]]) {
      expect(pathIdent(value)).toBeNull();
    }
  });

  test('dnsName accepts host names, wildcards and service labels, normalised', () => {
    expect(dnsName('www.example.com')).toBe('www.example.com');
    expect(dnsName('WWW.Example.COM.')).toBe('www.example.com');
    expect(dnsName('*.dev.example.com')).toBe('*.dev.example.com');
    expect(dnsName('_dmarc.example.com')).toBe('_dmarc.example.com');
    expect(dnsName('_sip._tcp.example.com')).toBe('_sip._tcp.example.com');
    expect(dnsName('selector1._domainkey')).toBe('selector1._domainkey');
    expect(dnsName('www')).toBe('www');
    expect(dnsName('xn--bcher-kva.example')).toBe('xn--bcher-kva.example');
  });

  test('dnsName refuses what is not a DNS name', () => {
    for (const value of [
      ...HOSTILE.filter((v) => v !== 'a.b'),
      '',
      '@',
      'example.com .',
      'example .com',
      'exam\tple.com',
      'example.com\u0000',
      'example.com​',
      'еxample.com',
      'example..com',
      '.example.com',
      'www.*.example.com',
      '**.example.com',
      'example\\.com',
      `${'a'.repeat(64)}.example.com`,
      `${'a.'.repeat(130)}com`,
      42,
      null,
    ]) {
      expect(dnsName(value), JSON.stringify(value).slice(0, 40)).toBeNull();
    }
  });

  test('recordType accepts a record type name, upper-cased, and refuses anything else', () => {
    expect(recordType('A')).toBe('A');
    expect(recordType('cname')).toBe('CNAME');
    for (const value of [...HOSTILE, '', ' mx ', 'M X', 'MX​', 'A,MX', 42, null]) {
      expect(recordType(value), JSON.stringify(value).slice(0, 40)).toBeNull();
    }
  });
});

describe('`zone_id` — the zone segment of the request path', () => {
  for (const tool of [...ZONE_TOOLS, ...RECORD_TOOLS]) {
    test(`${tool} : a hostile zone_id is refused by classify and reaches no request`, async () => {
      for (const zone_id of HOSTILE) {
        await expectRefused(
          tool,
          declared(tool, { zone_id, record_id: RECORD_ID }),
          'zone_id: malformed zone id',
          /zone_id: malformed zone id/,
        );
      }
    });

    test(`${tool} : a hostile ref is refused even when the mission zone carries it`, async () => {
      for (const ref of ['..', '.', 'a/../b', `${ZONE_ID}/..`, '%2e%2e', 'a.b']) {
        const poisoned: Resource = { ...zone, ref };
        for (const args of [{ record_id: RECORD_ID }, { zone_id: ref, record_id: RECORD_ID }]) {
          await expectRefused(
            tool,
            declared(tool, args),
            'zone_id: malformed zone id',
            /zone_id: malformed zone id/,
            [poisoned],
          );
        }
      }
    });
  }

  for (const tool of ZONE_TOOLS) {
    test(`${tool} : every request runs on the zone the slices name`, async () => {
      const args = declared(tool, {
        zone_id: ZONE_ID,
        type: 'A',
        name: 'www.example.com',
        content: '192.0.2.1',
      });
      const slices = classify(tool, args);
      expect(Array.isArray(slices) && slices.every((s) => s.startsWith(ROOT))).toBe(true);
      const fetch = permissiveFetch();
      const result = await cloudflareDnsPlugin.execute(ctx(fetch), tool, args);
      expect(result.isError).toBeUndefined();
      expect(fetch.calls).toHaveLength(1);
      const url = fetch.calls[0]!.url;
      expect(url).toMatch(
        new RegExp(`^${CLOUDFLARE_API_BASE}/zones/${ZONE_ID}(/[a-z_]+(/[a-z]+)?)?(\\?.*)?$`),
      );
      // What a URL parser resolves is what was written : nothing is collapsed.
      expect(new URL(url).href).toBe(url);
    });
  }

  test('an empty or null zone_id is the single zone of the mission, for classify and execute alike', async () => {
    for (const zone_id of ['', null, undefined]) {
      expect(classify('cloudflare_dns__get_zone', { zone_id })).toEqual([`${ROOT}.R`]);
      const fetch = permissiveFetch();
      await cloudflareDnsPlugin.execute(ctx(fetch), 'cloudflare_dns__get_zone', { zone_id });
      expect(fetch.calls.map((c) => c.url)).toEqual([`${CLOUDFLARE_API_BASE}/zones/${ZONE_ID}`]);
    }
  });
});

describe('`record_id` — the record segment of the request path', () => {
  for (const tool of RECORD_TOOLS) {
    test(`${tool} : a hostile record_id is refused by classify and reaches no request`, async () => {
      for (const record_id of HOSTILE) {
        await expectRefused(
          tool,
          declared(tool, { zone_id: ZONE_ID, record_id, type: 'A', name: 'www.example.com' }),
          'record_id: malformed identifier',
          /record_id: missing or malformed identifier/,
        );
      }
      for (const record_id of ['', null, undefined]) {
        await expectRefused(
          tool,
          declared(tool, { zone_id: ZONE_ID, record_id, type: 'A', name: 'www.example.com' }),
          'record_id: missing',
          /record_id: missing or malformed identifier/,
        );
      }
    });

    test(`${tool} : every request names exactly the record the slices name`, async () => {
      const args = declared(tool, {
        zone_id: ZONE_ID,
        record_id: RECORD_ID,
        type: 'A',
        name: 'www.example.com',
      });
      const slices = classify(tool, args);
      expect(
        Array.isArray(slices) && slices.every((s) => s.startsWith(`${ROOT}.record[${RECORD_ID}]`)),
      ).toBe(true);
      const fetch = permissiveFetch();
      await cloudflareDnsPlugin.execute(ctx(fetch), tool, args);
      expect(fetch.calls.length).toBeGreaterThan(0);
      for (const call of fetch.calls) {
        expect(call.url).toBe(`${CLOUDFLARE_API_BASE}/zones/${ZONE_ID}/dns_records/${RECORD_ID}`);
      }
    });
  }
});

describe('the `account_id` of a zone — a slice ident, never a request', () => {
  test('an account id that is not one identifier is the glob, never embedded', () => {
    for (const account_id of [...HOSTILE, '']) {
      const odd: Resource = { ...zone, metadata: { account_id, zone_name: 'example.com' } };
      expect(accountIdOf(odd)).toBeNull();
      expect(classify('cloudflare_dns__get_zone', {}, [odd])).toEqual([
        `cloudflare-dns.account[*].zone[${ZONE_ID}].R`,
      ]);
      expect(classify('cloudflare_dns__list_zones', {}, [odd])).toEqual([
        'cloudflare-dns.account[*].zone[*].R',
      ]);
    }
    expect(accountIdOf(zone)).toBe(ACCOUNT_ID);
  });
});

describe('a record `name` and `type` — the critical-record verdict', () => {
  /** Names Cloudflare could read as the apex although they are not spelled as it. */
  const NOT_A_NAME: readonly string[] = [
    'example.com .',
    'example .com',
    'example.com\t.',
    'example.com\u0000',
    'example.com​',
    'example.com/',
    'example.com?x=1#y',
    'example.com\\.',
    '%65xample.com',
    'a/../example.com',
    '..',
    '.',
    'a/b',
    '%2e%2e',
    '%2f',
    '..%2f',
    'x'.repeat(5000),
    'www\nexample.com',
    'www.*.example.com',
  ];

  test('a name that is not a DNS name is a critical record, never an ordinary one', () => {
    for (const name of NOT_A_NAME) {
      expect(isCriticalRecord('A', name, 'example.com'), JSON.stringify(name).slice(0, 40)).toBe(
        true,
      );
      expect(recordSensitivity({ type: 'A', name }, 'example.com')).toBe('critical');
    }
  });

  test('a type that is not a record type name is a critical record', () => {
    for (const type of ['', 'M X', 'MX​', 'A,MX', 'A\nMX', 'x'.repeat(5000), '..', '%4dX']) {
      expect(isCriticalRecord(type, 'www.example.com', 'example.com'), JSON.stringify(type)).toBe(
        true,
      );
    }
    expect(isCriticalRecord('a', 'www.example.com', 'example.com')).toBe(false);
    expect(isCriticalRecord(' mx ', 'www.example.com', 'example.com')).toBe(true);
    expect(isCriticalRecord('ns', 'www.example.com', 'example.com')).toBe(true);
  });

  test('ordinary names stay ordinary', () => {
    for (const name of [
      'www.example.com',
      'WWW.Example.com.',
      'www',
      '_dmarc.example.com',
      '_sip._tcp.example.com',
      '*.dev.example.com',
      'a.b.c.example.com',
    ]) {
      expect(isCriticalRecord('A', name, 'example.com'), name).toBe(false);
    }
  });

  for (const tool of ['cloudflare_dns__create_record', ...RECORD_TOOLS.slice(1)]) {
    test(`${tool} : a write naming such a record carries the critical slice`, () => {
      for (const name of NOT_A_NAME) {
        const slices = classify(
          tool,
          declared(tool, { zone_id: ZONE_ID, record_id: RECORD_ID, type: 'A', name }),
        );
        expect(
          Array.isArray(slices) && slices.some((s) => s.endsWith('.critical.W')),
          JSON.stringify(name).slice(0, 40),
        ).toBe(true);
      }
    });
  }

  test('the name is sent in the JSON body as given, on the record the slices name', async () => {
    const name = 'example.com .';
    const fetch = permissiveFetch();
    await cloudflareDnsPlugin.execute(ctx(fetch), 'cloudflare_dns__update_record', {
      zone_id: ZONE_ID,
      record_id: RECORD_ID,
      type: 'A',
      name,
      content: '192.0.2.1',
    });
    // Declared critical : no read-back, one PATCH on the record.
    expect(fetch.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `PATCH ${CLOUDFLARE_API_BASE}/zones/${ZONE_ID}/dns_records/${RECORD_ID}`,
    ]);
    expect(fetch.calls[0]!.json).toEqual({ type: 'A', name, content: '192.0.2.1' });
  });
});

describe('list filters — the query string', () => {
  test('a filter value cannot leave its parameter or reach the path', async () => {
    const hostile = '../../zones?x=1&type=NS#frag\n';
    const fetch = permissiveFetch();
    await cloudflareDnsPlugin.execute(ctx(fetch), 'cloudflare_dns__list_records', {
      zone_id: ZONE_ID,
      name: hostile,
      type: 'A',
    });
    const url = new URL(fetch.calls[0]!.url);
    expect(url.pathname).toBe(`/client/v4/zones/${ZONE_ID}/dns_records`);
    expect([...url.searchParams.entries()]).toEqual([
      ['name', hostile],
      ['type', 'A'],
    ]);
    expect(url.hash).toBe('');
  });
});
