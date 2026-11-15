/**
 * Identifier positions of the `resend` plugin : every value that reaches the
 * request path — from the arguments (`id`, `segment_id`, a contact selector),
 * from the mission's resources (a segment ref, a domain's `domain_id`) or
 * from the service's own answer (the id of a contact just created) — goes
 * through one grammar per kind (`pathIdent`, `contactSelector`, `domainName`
 * in `resources.ts`), in `classify` and in `execute` alike.
 *
 * The cases are the ones that turn an identifier into something else : dot
 * segments (`encodeURIComponent` leaves them and URL parsers collapse them),
 * separators, percent-escapes, query and fragment delimiters, control
 * characters, an overlong value. A refused value reaches no request.
 */
import { describe, expect, test } from 'vitest';

import { serializeSlice, type ExecuteContext, type Resource } from '@vaubaan/plugin-sdk';
import { mockFetch, type MockFetch, refusalText } from '@vaubaan/plugin-sdk/testing';

import { classifyResend } from '../../src/classify.ts';
import { RESEND_API_BASE } from '../../src/execute.ts';
import { resendPlugin } from '../../src/index.ts';
import { contactSelector, domainName, pathIdent } from '../../src/resources.ts';

const HOSTILE: readonly string[] = [
  '..',
  '.',
  'a/../b',
  'a/b',
  '%2e%2e',
  '%2f',
  '..%2f',
  '',
  'x'.repeat(5000),
  'id_1\nx',
  'id_1?x=1#y',
  'id_1\\x',
  'id 1',
  'a.b',
  'id_１',
];

const HOSTILE_EMAILS: readonly string[] = [
  '../domains@acme.com',
  'a/b@acme.com',
  '..%2fdomains@acme.com',
  'bob?x=1#y@acme.com',
  'bob\n@acme.com',
  ' bob@acme.com',
  'Bob <bob@acme.com>',
  `${'x'.repeat(5000)}@acme.com`,
  'bob@acme.com/../../domains',
  'bob@acme',
  'bob@..',
];

const UUID = '4dd369bc-aa82-4ff3-97de-514ae3000ee0';
const FROM = 'noreply@notifications.acme.com';

const prodDomain: Resource = {
  service: 'resend',
  ref: 'notifications.acme.com',
  displayName: 'notifications.acme.com',
  env: 'prod',
  metadata: { kind: 'domain', domain_id: 'dom_prod' },
};

const segment: Resource = {
  service: 'resend',
  ref: 'seg_news',
  displayName: 'Newsletter',
  env: 'prod',
  metadata: { kind: 'segment', segment_id: 'seg_news' },
};

const mission: readonly Resource[] = [prodDomain, segment];
const seg = { segment_id: 'seg_news' };

/** A Resend that answers anything : a refusal shows as "no call", not as a mock error. */
function permissiveFetch(body: unknown = { id: 'x', segment_id: 'seg_news' }): MockFetch {
  return mockFetch([{ url: () => true, body }]);
}

function ctx(fetch: MockFetch, resources: readonly Resource[] = mission): ExecuteContext {
  return {
    credential: { kind: 'api-key', fields: { api_key: 're_abc_123' }, metadata: {} },
    fetch,
    resources,
  };
}

function classify(
  tool: string,
  args: Record<string, unknown>,
  resources: readonly Resource[] = mission,
): string[] | { denied: string } {
  const outcome = classifyResend(tool, args, resources);
  return 'denied' in outcome ? outcome : outcome.slices.map((s) => serializeSlice(s));
}

/** Classify refuses with `reason` ; execute throws it and sends nothing. */
async function expectRefused(
  tool: string,
  args: Record<string, unknown>,
  reason: string,
  resources: readonly Resource[] = mission,
): Promise<void> {
  expect(classify(tool, args, resources)).toEqual({ denied: reason });
  const fetch = permissiveFetch();
  expect(await refusalText(resendPlugin.execute(ctx(fetch, resources), tool, args))).toMatch(
    `resend: ${reason}`,
  );
  expect(fetch.calls).toHaveLength(0);
}

async function urlsOf(
  tool: string,
  args: Record<string, unknown>,
  resources: readonly Resource[] = mission,
): Promise<string[]> {
  const fetch = permissiveFetch();
  await resendPlugin.execute(ctx(fetch, resources), tool, args);
  return fetch.calls.map((c) => `${c.method} ${c.url}`);
}

describe('the grammars', () => {
  test('pathIdent accepts the ids Resend issues and refuses anything else', () => {
    for (const id of [UUID, 'seg_news', 'brd_1', 'a'.repeat(64)]) expect(pathIdent(id)).toBe(id);
    for (const value of [...HOSTILE, 'a'.repeat(65), '~', 42, null, undefined, [UUID]]) {
      expect(pathIdent(value)).toBeNull();
    }
  });

  test('domainName accepts dotted host names, lower-cased, and refuses anything else', () => {
    expect(domainName('notifications.acme.com')).toBe('notifications.acme.com');
    expect(domainName('Notifications.Acme.COM')).toBe('notifications.acme.com');
    expect(domainName('xn--bcher-kva.example')).toBe('xn--bcher-kva.example');
    for (const value of [
      ...HOSTILE.filter((v) => v !== 'a.b'),
      'acme',
      'acme..com',
      '.acme.com',
      'acme.com.',
      '-a.com',
      'a_b.com',
      'acme.com/x',
      ' acme.com',
      `${'a'.repeat(64)}.com`,
      42,
      null,
    ]) {
      expect(domainName(value)).toBeNull();
    }
  });

  test('contactSelector : an id is itself, an address is one encoded segment and the glob', () => {
    expect(contactSelector(UUID)).toEqual({ segment: UUID, ident: UUID });
    expect(contactSelector("bob.o'neil+tag@example.com")).toEqual({
      segment: "bob.o'neil%2Btag%40example.com",
      ident: '*',
    });
    for (const value of [...HOSTILE, ...HOSTILE_EMAILS, 42, null, undefined]) {
      expect(contactSelector(value)).toBeNull();
    }
  });
});

describe('`id` of an email or a broadcast — a segment of the request path', () => {
  const TOOLS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['resend__get_email', {}],
    ['resend__get_broadcast', seg],
    ['resend__update_broadcast', { ...seg, subject: 'New' }],
    ['resend__send_broadcast', seg],
    ['resend__delete_broadcast', seg],
  ];

  for (const [tool, rest] of TOOLS) {
    test(`${tool} : a hostile id is refused by classify and reaches no request`, async () => {
      for (const id of [...HOSTILE, 'bob@acme.com']) {
        await expectRefused(tool, { ...rest, id }, 'id: missing or malformed identifier');
      }
      await expectRefused(tool, rest, 'id: missing or malformed identifier');
    });

    test(`${tool} : every request names exactly the object the slice names`, async () => {
      const slices = classify(tool, { ...rest, id: UUID });
      expect(Array.isArray(slices) && slices.some((s) => s.includes(`[${UUID}]`))).toBe(true);
      const urls = await urlsOf(tool, { ...rest, id: UUID });
      expect(urls.length).toBeGreaterThan(0);
      const collection = tool === 'resend__get_email' ? 'emails' : 'broadcasts';
      for (const url of urls) {
        expect(url).toMatch(
          new RegExp(`^[A-Z]+ ${RESEND_API_BASE}/${collection}/${UUID}(/send)?$`),
        );
      }
    });
  }
});

describe('a contact selector — an id or an email address in the request path', () => {
  const TOOLS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['resend__get_contact', {}],
    ['resend__update_contact', { first_name: 'Bob' }],
    ['resend__delete_contact', {}],
    ['resend__add_contact_to_segment', seg],
    ['resend__remove_contact_from_segment', seg],
  ];

  for (const [tool, rest] of TOOLS) {
    test(`${tool} : a hostile selector is refused by classify and reaches no request`, async () => {
      for (const id of [...HOSTILE, ...HOSTILE_EMAILS]) {
        await expectRefused(tool, { ...rest, id }, 'id: missing or malformed contact id or email');
      }
    });

    test(`${tool} : an id is sent as it is, an address as one encoded segment`, async () => {
      const suffix = 'segment_id' in rest ? '/segments/seg_news' : '';
      expect(await urlsOf(tool, { ...rest, id: UUID })).toEqual([
        expect.stringMatching(new RegExp(`^[A-Z]+ ${RESEND_API_BASE}/contacts/${UUID}${suffix}$`)),
      ]);
      const [byEmail] = await urlsOf(tool, { ...rest, id: "bob.o'neil+tag@example.com" });
      expect(byEmail!.split(' ')[1]).toBe(
        `${RESEND_API_BASE}/contacts/bob.o'neil%2Btag%40example.com${suffix}`,
      );
      // What a URL parser resolves is what was written : nothing is collapsed.
      expect(new URL(byEmail!.split(' ')[1]!).href).toBe(byEmail!.split(' ')[1]);
    });
  }

  test('a contact named by address is the glob : the slice never embeds the address', () => {
    expect(classify('resend__delete_contact', { id: 'bob@example.com' })).toEqual([
      'resend.contact[*].W',
    ]);
  });
});

describe('`segment_id` — a mission resource, in the path, the query and the body', () => {
  const TOOLS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['resend__get_segment', {}],
    ['resend__delete_segment', {}],
    ['resend__list_contacts', {}],
    ['resend__create_contact', { email: 'new@example.com' }],
    ['resend__add_contact_to_segment', { id: UUID }],
    ['resend__remove_contact_from_segment', { id: UUID }],
    ['resend__create_broadcast', { from: FROM, subject: 'News' }],
    ['resend__get_broadcast', { id: UUID }],
    ['resend__send_broadcast', { id: UUID }],
    ['resend__delete_broadcast', { id: UUID }],
  ];

  for (const [tool, rest] of TOOLS) {
    test(`${tool} : a hostile segment_id is refused by classify and reaches no request`, async () => {
      for (const segment_id of HOSTILE) {
        await expectRefused(tool, { ...rest, segment_id }, 'segment_id: missing or malformed ref');
      }
    });

    test(`${tool} : a hostile ref is refused even when a mission resource carries it`, async () => {
      for (const ref of ['..', '.', 'a/../b', 'seg_news/..', '%2e%2e', 'a.b']) {
        const poisoned: Resource = { ...segment, ref };
        await expectRefused(
          tool,
          { ...rest, segment_id: ref },
          'segment_id: missing or malformed ref',
          [prodDomain, poisoned],
        );
      }
    });
  }

  test('the segment in the path, the query and the body is the mission resource', async () => {
    expect(await urlsOf('resend__get_segment', seg)).toEqual([
      `GET ${RESEND_API_BASE}/segments/seg_news`,
    ]);
    expect(await urlsOf('resend__list_contacts', seg)).toEqual([
      `GET ${RESEND_API_BASE}/contacts?segment_id=seg_news`,
    ]);
    const fetch = permissiveFetch();
    await resendPlugin.execute(ctx(fetch), 'resend__create_broadcast', {
      ...seg,
      from: FROM,
      subject: 'News',
    });
    expect(fetch.calls[0]!.json).toEqual({ from: FROM, subject: 'News', segment_id: 'seg_news' });
  });
});

describe('`domain` — a mission resource ; the path carries its `domain_id`', () => {
  const TOOLS: readonly string[] = [
    'resend__get_domain',
    'resend__update_domain',
    'resend__delete_domain',
    'resend__verify_domain',
  ];

  for (const tool of TOOLS) {
    test(`${tool} : a hostile domain is refused by classify and reaches no request`, async () => {
      for (const domain of HOSTILE.filter((v) => v !== 'a.b')) {
        await expectRefused(tool, { domain }, 'domain: missing or malformed ref');
      }
      for (const domain of ['notifications.acme.com/..', 'notifications.acme.com.', 'acme..com']) {
        await expectRefused(tool, { domain }, 'domain: missing or malformed ref');
      }
    });

    test(`${tool} : a domain_id that is not one path segment reaches no request`, async () => {
      for (const domain_id of [
        '..',
        '.',
        'a/../b',
        'a/b',
        '%2e%2e',
        'dom_prod/verify',
        'a.b',
        'x'.repeat(5000),
      ]) {
        const poisoned: Resource = { ...prodDomain, metadata: { kind: 'domain', domain_id } };
        const fetch = permissiveFetch();
        expect(
          await refusalText(
            resendPlugin.execute(ctx(fetch, [poisoned]), tool, {
              domain: 'notifications.acme.com',
            }),
          ),
        ).toMatch(/domain_id/);
        expect(fetch.calls).toHaveLength(0);
      }
    });

    test(`${tool} : the path carries the domain_id of the resource the slice names`, async () => {
      for (const domain of ['notifications.acme.com', 'Notifications.Acme.COM']) {
        const slices = classify(tool, { domain });
        expect(
          Array.isArray(slices) && slices.every((s) => s.includes('[notifications.acme.com]')),
        ).toBe(true);
        expect(await urlsOf(tool, { domain })).toEqual([
          expect.stringMatching(
            new RegExp(`^[A-Z]+ ${RESEND_API_BASE}/domains/dom_prod(/verify)?$`),
          ),
        ]);
      }
    });
  }
});

describe('an id the service answers — the contact just created', () => {
  test('a created id that is not one path segment is not used to build the membership path', async () => {
    for (const id of ['..', '.', 'a/../b', 'a/b', '%2e%2e', 'ct_1?x=1#y', 'a.b']) {
      const fetch = permissiveFetch({ id });
      await expect(
        resendPlugin.execute(ctx(fetch), 'resend__create_contact', {
          email: 'new@example.com',
          segment_id: 'seg_news',
        }),
      ).rejects.toThrow(/it was not added to segment 'seg_news'/);
      expect(fetch.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        `POST ${RESEND_API_BASE}/contacts`,
      ]);
    }
  });
});
