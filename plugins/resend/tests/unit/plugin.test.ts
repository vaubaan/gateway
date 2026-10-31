/**
 * Mandatory suite of the Resend plugin : the SDK kit, the v5 classifier
 * (resource resolution, recipient zones, batch, out-of-scope refusals,
 * broadcasts), `execute` and `discoverResources` against `mockFetch`, the
 * credential spec and the macro-actions. The per-tool classifier scenarios live in
 * `classify.test.ts`.
 */
import { describe, expect, test } from 'vitest';

import {
  UpstreamHttpError,
  UpstreamProtocolError,
  catalogPathIssues,
  parseSlice,
  serializeSlice,
  slicePathIssue,
  type ConnectionContext,
  type ExecuteContext,
  type Resource,
} from '@vaubaan/plugin-sdk';
import {
  assertCatalogCoverage,
  assertIdentifiersRefused,
  assertNoWildcard,
  assertPluginWellFormed,
  assertSlicesOnDataModel,
  mockFetch,
  policyFromMacroActions,
  refusalText,
  resourceEnvResolver,
  type ToolSamples,
} from '@vaubaan/plugin-sdk/testing';

import {
  RESEND_API_BASE,
  classifyResend,
  parseAddress,
  resendPlugin,
  zoneConfigOf,
} from '../../src/index.ts';

const prodDomain: Resource = {
  provider: 'resend',
  ref: 'notifications.acme.com',
  env: 'prod',
  displayName: 'notifications.acme.com',
  metadata: {
    kind: 'domain',
    domain_id: 'dom_prod',
    status: 'verified',
    internal_domains: ['acme.com', 'acme.io'],
    allowlist_domains: ['partner.com'],
    allowlist_addresses: ['Support@Vendor.com'],
  },
};
const stagingDomain: Resource = {
  provider: 'resend',
  ref: 'staging.acme.dev',
  env: 'staging',
  displayName: 'staging.acme.dev',
  metadata: {
    kind: 'domain',
    domain_id: 'dom_stg',
    internal_domains: ['acme.com'],
    allowlist_domains: [],
    allowlist_addresses: [],
  },
};
const newsletter: Resource = {
  provider: 'resend',
  ref: 'seg_news',
  env: 'prod',
  displayName: 'Newsletter',
  metadata: { kind: 'segment', segment_id: 'seg_news' },
};
const testSegment: Resource = {
  provider: 'resend',
  ref: 'seg_test',
  env: 'staging',
  displayName: 'QA list',
  metadata: { kind: 'segment', segment_id: 'seg_test' },
};
const mission = [prodDomain, stagingDomain, newsletter, testSegment];

const FROM = 'Acme <noreply@notifications.acme.com>';

const slices = (
  tool: string,
  args: Record<string, unknown> = {},
  resources: readonly Resource[] = mission,
) => {
  const out = classifyResend(tool, args, resources);
  if ('denied' in out) throw new Error(out.denied);
  return out.slices.map(serializeSlice);
};
const denied = (
  tool: string,
  args: Record<string, unknown> = {},
  resources: readonly Resource[] = mission,
) => {
  const out = classifyResend(tool, args, resources);
  return 'denied' in out ? out.denied : null;
};

describe('resend plugin — structural kit', () => {
  test('well-formed, no wildcard', () => {
    assertPluginWellFormed(resendPlugin);
    assertNoWildcard(resendPlugin);
  });

  const seg = { segment_id: 'seg_news' };
  // One table for the catalog coverage and for the identifier proof.
  const SAMPLES: ToolSamples = {
    resend__get_email: [{ args: { id: 'em_1' } }],
    resend__list_domains: [{ args: {} }],
    resend__get_domain: [{ args: { domain: 'notifications.acme.com' } }],
    resend__list_segments: [{ args: {} }],
    resend__get_segment: [{ args: seg }],
    resend__list_contacts: [{ args: {} }, { args: seg }],
    resend__get_contact: [{ args: { id: 'ct_1' } }, { args: { id: 'bob@example.com' } }],
    resend__list_broadcasts: [{ args: {} }],
    resend__get_broadcast: [{ args: { ...seg, id: 'brd_1' } }],
    resend__send_email: [
      { args: { from: FROM, to: ['alice@acme.com'], subject: 'hi' } },
      { args: { from: FROM, to: 'bob@partner.com', subject: 'hi' } },
      { args: { from: 'x@staging.acme.dev', to: ['who@evil.com'], subject: 'hi' } },
      {
        args: {
          from: FROM,
          to: ['alice@acme.com'],
          cc: ['bob@acme.io'],
          bcc: 'carol@acme.com',
          subject: 'hi',
          html: '<p>hi</p>',
          text: 'hi',
          reply_to: ['help@acme.com'],
          headers: { 'X-Entity-Ref-ID': 'ref-1' },
          tags: [{ name: 'kind', value: 'welcome' }],
        },
      },
      {
        args: { from: FROM, to: ['alice@acme.com'], subject: 'hi', attachments: [{}] },
        expectDenied: true,
      },
      {
        args: { from: FROM, to: ['alice@acme.com'], subject: 'hi', headers: { Bcc: 'x@e.io' } },
        expectDenied: true,
      },
    ],
    resend__send_batch_emails: [
      { args: { emails: [{ from: FROM, to: ['alice@acme.com'], subject: 'hi' }] } },
      {
        args: {
          emails: [
            { from: FROM, to: ['bob@partner.com'], subject: 'hi' },
            { from: 'x@staging.acme.dev', to: ['who@evil.com'], subject: 'hi' },
          ],
        },
      },
    ],
    resend__create_domain: [{ args: { name: 'mail.acme.com' } }],
    resend__update_domain: [{ args: { domain: 'notifications.acme.com', tls: 'enforced' } }],
    resend__delete_domain: [{ args: { domain: 'staging.acme.dev' } }],
    resend__verify_domain: [{ args: { domain: 'staging.acme.dev' } }],
    resend__create_segment: [{ args: { name: 'Beta' } }],
    resend__delete_segment: [{ args: { segment_id: 'seg_test' } }],
    resend__create_contact: [
      { args: { email: 'new@example.com' } },
      { args: { email: 'new@example.com', ...seg } },
    ],
    resend__update_contact: [{ args: { id: 'ct_1', unsubscribed: true } }],
    resend__delete_contact: [{ args: { id: 'ct_1' } }],
    resend__add_contact_to_segment: [{ args: { ...seg, id: 'ct_1' } }],
    resend__remove_contact_from_segment: [{ args: { ...seg, id: 'ct_1' } }],
    resend__create_broadcast: [
      { args: { ...seg, from: FROM, subject: 'News' } },
      { args: { ...seg, from: FROM, subject: 'News', send: true }, expectDenied: true },
    ],
    resend__update_broadcast: [{ args: { ...seg, id: 'brd_1', subject: 'News 2' } }],
    resend__send_broadcast: [{ args: { ...seg, id: 'brd_1' } }],
    resend__delete_broadcast: [{ args: { ...seg, id: 'brd_1' } }],
    resend__describe_zones: [{ args: {} }],
  };

  test('every tool classifies to slices the catalog covers', () => {
    const report = assertCatalogCoverage(resendPlugin, SAMPLES, { resources: mission });
    // Paths only : this model's cardinalities count instances, not how a slice names them.
    assertSlicesOnDataModel(resendPlugin, SAMPLES, { resources: mission, cardinalities: false });
    expect(report.toolsChecked).toBe(27);
    // No documented call reaches the fallback : every write slice has a named risk.
    expect(report.fallbackHits).toEqual([]);
    // Only the two retired catalog ids (account-rooted patterns) are never touched.
    expect(report.risksUntouched).toEqual(['resend.read-audiences', 'resend.audience-write']);
  });

  // `catalogPathIssues` skips deprecated entries, and so does the check of the
  // live ones below. A deprecated entry's patterns are kept for the id missions
  // store ; the classifier emits nothing they match (`risksUntouched` above
  // pins that), so they are not maintained against the data model. This test
  // says so, and pins what they are today : rooted at an `account` the model
  // does not have.
  test('the patterns of the live entries walk the data model ; the deprecated ones are pinned as they are', () => {
    expect(catalogPathIssues(resendPlugin)).toEqual([]);
    const deprecated = Object.fromEntries(
      resendPlugin.catalog.risks
        .filter((risk) => risk.deprecated === true)
        .map((risk) => [
          risk.id,
          Object.fromEntries(
            [risk.matches]
              .flat()
              .map((pattern) => [
                pattern,
                slicePathIssue(resendPlugin.dataModel, parseSlice(pattern), 'pattern'),
              ]),
          ),
        ]),
    );
    const noAccount = "'account' is not an entity of the data model";
    expect(deprecated).toEqual({
      'resend.read-audiences': {
        'resend.account[**].audience[**].R': noAccount,
        'resend.account[**].audience[**].contact[**].R': noAccount,
      },
      'resend.audience-write': { 'resend.account[**].audience[**].W': noAccount },
    });
  });

  // What is executed is what was classified (SDK kit) : every string argument of
  // every sample above is fed the hostile identifiers, through `classify` and
  // through `execute`. The finer cases are in this plugin's identifier tests.
  test('hostile identifiers are refused by classify and by execute, or named exactly', async () => {
    const report = await assertIdentifiersRefused(resendPlugin, SAMPLES, {
      resources: mission,
      context: (fetch, resources) => ctxOf(fetch, resources),
    });
    expect(report.toolsChecked).toBe(27);
    // Found by running the samples : the arguments that are a segment of a request path.
    expect([...new Set(report.pathIdentifiers.map((p) => p.argument))].sort()).toEqual([
      'id',
      'segment_id',
    ]);
    // Whatever classify refused, execute sent nothing for.
    expect(report.refusedByClassify).toBeGreaterThan(0);
    expect(report.nothingSent).toBeGreaterThanOrEqual(report.refusedByClassify);
  });
});

describe('classifyResend — the from domain is the resource', () => {
  test('a send is rooted at the domain of its from address, display name and case ignored', () => {
    expect(
      slices('resend__send_email', { from: FROM, to: ['alice@acme.com'], subject: 'x' }),
    ).toEqual(['resend.domain[notifications.acme.com].to-zone[internal].W']);
    expect(
      slices('resend__send_email', {
        from: 'NoReply@Staging.Acme.DEV',
        to: 'alice@acme.com',
        subject: 'x',
      })[0],
    ).toBe('resend.domain[staging.acme.dev].to-zone[internal].W');
  });

  test('a from outside the mission, or malformed, is refused — never widened', () => {
    expect(
      denied('resend__send_email', { from: 'x@acme.com', to: ['a@acme.com'], subject: 's' }),
    ).toBe("from: 'acme.com' is not a sending domain of this mission");
    expect(
      denied('resend__send_email', { from: 'x@mail.notifications.acme.com', to: ['a@acme.com'] }),
    ).toMatch(/not a sending domain/);
    expect(denied('resend__send_email', { to: ['a@acme.com'], subject: 's' })).toBe(
      'from: missing or malformed address',
    );
    expect(denied('resend__send_email', { from: 'not an address', to: ['a@acme.com'] })).toBe(
      'from: missing or malformed address',
    );
    expect(denied('resend__send_email', { from: FROM, to: ['a@acme.com'] }, [newsletter])).toMatch(
      /not a sending domain/,
    );
  });

  test('the env resolver qualifies from the domain or the segment the slice names', () => {
    const resolver = resourceEnvResolver(mission);
    const send = classifyResend(
      'resend__send_email',
      { from: 'x@staging.acme.dev', to: ['who@evil.com'], subject: 's' },
      mission,
    );
    if ('denied' in send) throw new Error(send.denied);
    expect(resolver.resolveEnv(send.slices[0]!)).toBe('staging');
    const broadcast = classifyResend(
      'resend__send_broadcast',
      { segment_id: 'seg_news', id: 'brd_1' },
      mission,
    );
    if ('denied' in broadcast) throw new Error(broadcast.denied);
    expect(resolver.resolveEnv(broadcast.slices[0]!)).toBe('prod');
  });
});

describe('classifyResend — recipient zones', () => {
  const send = (args: Record<string, unknown>) =>
    slices('resend__send_email', { from: FROM, subject: 's', ...args });

  test('internal, allowlist address, allowlist domain, external', () => {
    expect(send({ to: ['alice@acme.io'] })[0]).toContain('to-zone[internal]');
    expect(send({ to: ['support@vendor.com'] })[0]).toContain('to-zone[allowlist]');
    expect(send({ to: ['Bob <bob@partner.com>'] })[0]).toContain('to-zone[allowlist]');
    expect(send({ to: ['who@evil.com'] })[0]).toContain('to-zone[external-unbounded]');
  });

  test('worst case wins across to, cc and bcc', () => {
    expect(send({ to: ['alice@acme.com'], cc: ['bob@partner.com'] })[0]).toContain(
      'to-zone[allowlist]',
    );
    expect(send({ to: ['alice@acme.com'], bcc: 'spy@evil.com' })[0]).toContain(
      'to-zone[external-unbounded]',
    );
  });

  test('one recipient or several : a single send is its zone slice, never a count marker', () => {
    const internal = ['resend.domain[notifications.acme.com].to-zone[internal].W'];
    expect(send({ to: 'alice@acme.com' })).toEqual(internal);
    expect(send({ to: ['alice@acme.com'], cc: ['bob@acme.io'] })).toEqual(internal);
  });

  test('zone lists come from the domain resource and are lower-cased', () => {
    expect(zoneConfigOf(prodDomain).allowlist_addresses).toEqual(['support@vendor.com']);
    expect(zoneConfigOf({ ...prodDomain, metadata: { kind: 'domain' } })).toEqual({
      internal_domains: [],
      allowlist_domains: [],
      allowlist_addresses: [],
    });
    // Empty lists : every recipient is external.
    expect(
      slices('resend__send_email', { from: FROM, to: ['alice@acme.com'], subject: 's' }, [
        { ...prodDomain, metadata: { kind: 'domain' } },
      ])[0],
    ).toContain('to-zone[external-unbounded]');
  });

  test('malformed recipients, no recipients, attachments and scheduling are refused', () => {
    expect(denied('resend__send_email', { from: FROM, to: ['alice@acme.com', 'nope'] })).toBe(
      "to: malformed address 'nope'",
    );
    expect(denied('resend__send_email', { from: FROM, cc: [42] })).toBe(
      "cc: malformed address '42'",
    );
    expect(denied('resend__send_email', { from: FROM, subject: 's' })).toBe(
      'to: at least one recipient is required',
    );
    expect(
      denied('resend__send_email', {
        from: FROM,
        to: ['a@acme.com'],
        attachments: [{ filename: 'f' }],
      }),
    ).toBe('attachments: not supported in v1');
    expect(
      denied('resend__send_email', { from: FROM, to: ['a@acme.com'], scheduled_at: 'in 1 min' }),
    ).toBe('scheduled_at: scheduling is not supported in v1');
  });

  test('parseAddress accepts the angle form and rejects junk', () => {
    expect(parseAddress('Alice Smith <Alice@Acme.com>')).toEqual({
      address: 'alice@acme.com',
      domain: 'acme.com',
    });
    for (const bad of ['', 'alice', 'alice@', '@acme.com', 'a b@acme.com', '<a@b.c', 42, null]) {
      expect(parseAddress(bad), String(bad)).toBeNull();
    }
  });
});

describe('classifyResend — batch sends', () => {
  const email = (from: string, to: string) => ({ from, to: [to], subject: 's' });

  test('one zone slice per sending domain plus the batch marker, worst zone per domain', () => {
    expect(
      slices('resend__send_batch_emails', {
        emails: [
          email(FROM, 'alice@acme.com'),
          email(FROM, 'bob@partner.com'),
          email('x@staging.acme.dev', 'who@evil.com'),
        ],
      }),
    ).toEqual([
      'resend.domain[notifications.acme.com].to-zone[allowlist].W',
      'resend.domain[notifications.acme.com].recipient-count[batch].W',
      'resend.domain[staging.acme.dev].to-zone[external-unbounded].W',
      'resend.domain[staging.acme.dev].recipient-count[batch].W',
    ]);
  });

  test('refuses an empty batch, more than 100 emails, a non-object, a foreign from, an attachment', () => {
    expect(denied('resend__send_batch_emails', { emails: [] })).toMatch(/non-empty list/);
    expect(denied('resend__send_batch_emails', {})).toMatch(/non-empty list/);
    expect(
      denied('resend__send_batch_emails', {
        emails: Array.from({ length: 101 }, () => email(FROM, 'a@acme.com')),
      }),
    ).toBe('emails: Resend accepts at most 100 emails per batch');
    expect(denied('resend__send_batch_emails', { emails: ['nope'] })).toBe(
      'emails[0]: expected an email object',
    );
    expect(
      denied('resend__send_batch_emails', {
        emails: [email(FROM, 'a@acme.com'), email('x@other.com', 'a@acme.com')],
      }),
    ).toBe("emails[1].from: 'other.com' is not a sending domain of this mission");
    expect(
      denied('resend__send_batch_emails', {
        emails: [{ ...email(FROM, 'a@acme.com'), attachments: [{}] }],
      }),
    ).toBe('emails[0].attachments: not supported in v1');
  });
});

describe('classifyResend — domains, segments, contacts', () => {
  test('domain tools name a mission domain ; unknown or malformed refs are refused', () => {
    expect(slices('resend__get_domain', { domain: 'notifications.acme.com' })).toEqual([
      'resend.domain[notifications.acme.com].R',
      'resend.domain[notifications.acme.com].dns-record[*].R',
    ]);
    expect(slices('resend__verify_domain', { domain: 'Staging.Acme.dev' })).toEqual([
      'resend.domain[staging.acme.dev].dns-record[*].W',
    ]);
    expect(slices('resend__create_domain', { name: 'mail.acme.com' })).toEqual(['resend.domain.W']);
    expect(denied('resend__delete_domain', { domain: 'acme.com' })).toBe(
      "domain: 'acme.com' is not a sending domain of this mission",
    );
    expect(denied('resend__update_domain', { domain: 'a b' })).toBe(
      'domain: missing or malformed ref',
    );
    expect(denied('resend__update_domain', {})).toBe('domain: missing or malformed ref');
    expect(denied('resend__create_domain', {})).toBe('name: missing domain name');
  });

  test('segment tools name a mission segment', () => {
    expect(slices('resend__get_segment', { segment_id: 'seg_test' })).toEqual([
      'resend.segment[seg_test].R',
    ]);
    expect(slices('resend__delete_segment', { segment_id: 'seg_test' })).toEqual([
      'resend.segment[seg_test].W',
    ]);
    expect(slices('resend__create_segment', { name: 'Beta' })).toEqual(['resend.segment.W']);
    expect(denied('resend__get_segment', { segment_id: 'seg_other' })).toBe(
      "segment_id: 'seg_other' is not a segment of this mission",
    );
    // A domain ref is not a segment id : a dotted name is not one path segment.
    expect(denied('resend__get_segment', { segment_id: 'notifications.acme.com' })).toBe(
      'segment_id: missing or malformed ref',
    );
  });

  test('contacts are account-level ; an email selector is the unknown member', () => {
    expect(slices('resend__list_contacts')).toEqual(['resend.contact[*].R']);
    expect(slices('resend__list_contacts', { segment_id: 'seg_news' })).toEqual([
      'resend.segment[seg_news].member[*].R',
    ]);
    expect(slices('resend__get_contact', { id: 'ct_1' })).toEqual(['resend.contact[ct_1].R']);
    expect(slices('resend__delete_contact', { id: 'bob@example.com' })).toEqual([
      'resend.contact[*].W',
    ]);
    expect(
      slices('resend__create_contact', { email: 'new@example.com', segment_id: 'seg_news' }),
    ).toEqual(['resend.contact.W', 'resend.segment[seg_news].member[*].W']);
    expect(
      slices('resend__add_contact_to_segment', { segment_id: 'seg_news', id: 'ct_1' }),
    ).toEqual(['resend.segment[seg_news].member[ct_1].W']);
    expect(denied('resend__get_contact', { id: 'not valid' })).toBe(
      'id: missing or malformed contact id or email',
    );
    expect(denied('resend__create_contact', { email: 'nope' })).toBe(
      'email: missing or malformed address',
    );
  });
});

describe('classifyResend — broadcasts', () => {
  const seg = { segment_id: 'seg_news' };

  test('draft, update, send and delete are distinct leaves under the segment', () => {
    expect(slices('resend__create_broadcast', { ...seg, from: FROM, subject: 'News' })).toEqual([
      'resend.segment[seg_news].broadcast.W',
    ]);
    expect(slices('resend__update_broadcast', { ...seg, id: 'brd_1', html: '<p/>' })).toEqual([
      'resend.segment[seg_news].broadcast[brd_1].W',
    ]);
    expect(slices('resend__send_broadcast', { ...seg, id: 'brd_1' })).toEqual([
      'resend.segment[seg_news].broadcast[brd_1].send.W',
    ]);
    expect(slices('resend__delete_broadcast', { ...seg, id: 'brd_1' })).toEqual([
      'resend.segment[seg_news].broadcast[brd_1].delete.W',
    ]);
    expect(slices('resend__get_broadcast', { ...seg, id: 'brd_1' })).toEqual([
      'resend.segment[seg_news].broadcast[brd_1].R',
    ]);
  });

  test('a draft can never be dispatched from create or update', () => {
    expect(
      denied('resend__create_broadcast', { ...seg, from: FROM, subject: 's', send: true }),
    ).toMatch(/^send: a broadcast is sent with resend__send_broadcast/);
    expect(
      denied('resend__create_broadcast', {
        ...seg,
        from: FROM,
        subject: 's',
        scheduled_at: 'in 1 hour',
      }),
    ).toBe('scheduled_at: scheduling is not supported in v1');
    expect(denied('resend__update_broadcast', { ...seg, id: 'brd_1', send: false })).toMatch(
      /^send:/,
    );
    expect(
      denied('resend__send_broadcast', { ...seg, id: 'brd_1', scheduled_at: 'in 1 min' }),
    ).toBe('scheduled_at: scheduling is not supported in v1');
  });

  test('the from of a broadcast must be on a mission domain ; the segment must be in the mission', () => {
    expect(denied('resend__create_broadcast', { ...seg, from: 'x@other.com', subject: 's' })).toBe(
      "from: 'other.com' is not a sending domain of this mission",
    );
    expect(denied('resend__create_broadcast', { ...seg, subject: 's' })).toBe(
      'from: missing or malformed address',
    );
    expect(denied('resend__update_broadcast', { ...seg, id: 'brd_1', from: 'junk' })).toBe(
      'from: malformed address',
    );
    expect(denied('resend__send_broadcast', { segment_id: 'seg_other', id: 'brd_1' })).toMatch(
      /not a segment of this mission/,
    );
    expect(denied('resend__send_broadcast', { ...seg, id: 'brd 1' })).toBe(
      'id: missing or malformed identifier',
    );
  });
});

describe('classifyResend — misc', () => {
  test('unknown tool is denied', () => {
    expect(denied('resend__create_api_key', {})).toBe(
      "unknown resend tool 'resend__create_api_key'.",
    );
  });

  test('emitted slices parse back (round-trip)', () => {
    for (const s of [
      ...slices('resend__send_email', { from: FROM, to: ['alice@acme.com'], subject: 's' }),
      ...slices('resend__get_domain', { domain: 'notifications.acme.com' }),
      ...slices('resend__send_broadcast', { segment_id: 'seg_news', id: 'brd_1' }),
    ]) {
      expect(serializeSlice(parseSlice(s))).toBe(s);
    }
  });
});

// ─── execute ─────────────────────────────────────────────────────────────────

const credential = { kind: 'api-key' as const, fields: { api_key: 're_abc_123' }, metadata: {} };
const ctxOf = (
  fetch: typeof globalThis.fetch,
  resources: readonly Resource[] = mission,
): ExecuteContext => ({ credential, fetch, resources });
const textOf = (r: { content: readonly unknown[] }) => (r.content[0] as { text: string }).text;
const jsonOf = (r: { content: readonly unknown[] }) => JSON.parse(textOf(r)) as unknown;

describe('executeResend with mockFetch', () => {
  test('send_email posts JSON with the bearer ; the declared fields are forwarded', async () => {
    const fetch = mockFetch([
      { method: 'POST', url: `${RESEND_API_BASE}/emails`, body: { id: 'em_1' } },
    ]);
    const args = { from: FROM, to: ['alice@acme.com'], subject: 'Hi', html: '<p>x</p>' };
    const result = await resendPlugin.execute(ctxOf(fetch), 'resend__send_email', args);
    expect(result.isError).toBeUndefined();
    expect(jsonOf(result)).toEqual({ id: 'em_1' });
    const call = fetch.calls[0]!;
    expect(call.headers.authorization).toBe('Bearer re_abc_123');
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.json).toEqual(args);
  });

  test('the batch endpoint receives the bare array', async () => {
    const fetch = mockFetch([
      { method: 'POST', url: `${RESEND_API_BASE}/emails/batch`, body: { data: [{ id: 'em_1' }] } },
    ]);
    const emails = [{ from: FROM, to: ['alice@acme.com'], subject: 's' }];
    await resendPlugin.execute(ctxOf(fetch), 'resend__send_batch_emails', { emails });
    expect(fetch.calls[0]!.json).toEqual(emails);
  });

  test('only the declared fields of a tool reach Resend', async () => {
    const fetch = mockFetch([
      { method: 'POST', url: `${RESEND_API_BASE}/emails`, body: { id: 'em_1' } },
      { method: 'POST', url: `${RESEND_API_BASE}/emails/batch`, body: { data: [] } },
      { method: 'POST', url: `${RESEND_API_BASE}/domains`, body: { id: 'dom_new' } },
      { method: 'PATCH', url: `${RESEND_API_BASE}/domains/dom_stg`, body: { id: 'dom_stg' } },
      { method: 'POST', url: `${RESEND_API_BASE}/contacts`, body: { id: 'ct_new' } },
      { method: 'PATCH', url: `${RESEND_API_BASE}/contacts/ct_1`, body: { id: 'ct_1' } },
      { method: 'GET', url: `${RESEND_API_BASE}/contacts?limit=5`, body: { data: [] } },
      { method: 'POST', url: `${RESEND_API_BASE}/broadcasts`, body: { id: 'brd_2' } },
      {
        method: 'GET',
        url: `${RESEND_API_BASE}/broadcasts/brd_1`,
        body: { id: 'brd_1', segment_id: 'seg_news' },
      },
      { method: 'PATCH', url: `${RESEND_API_BASE}/broadcasts/brd_1`, body: { id: 'brd_1' } },
    ]);
    const ctx = ctxOf(fetch);
    // Fields no tool declares : a legacy audience target, a template, a topic.
    const undeclared = { audience_id: 'aud_other', template_id: 'tpl_1', topic_id: 'top_1' };
    const email = {
      from: FROM,
      to: ['alice@acme.com'],
      cc: ['bob@acme.io'],
      subject: 'Hi',
      html: '<p>x</p>',
      text: 'x',
      reply_to: ['help@acme.com'],
      headers: { 'X-Entity-Ref-ID': 'ref-1' },
      tags: [{ name: 'kind', value: 'welcome' }],
    };

    await resendPlugin.execute(ctx, 'resend__send_email', {
      ...email,
      ...undeclared,
      attachments: [],
    });
    expect(fetch.calls[0]!.json).toEqual(email);

    await resendPlugin.execute(ctx, 'resend__send_batch_emails', {
      emails: [{ ...email, ...undeclared }],
      ...undeclared,
    });
    expect(fetch.calls[1]!.json).toEqual([email]);

    await resendPlugin.execute(ctx, 'resend__create_domain', {
      name: 'mail.acme.com',
      region: 'eu-west-1',
      custom_return_path: 'bounce',
    });
    expect(fetch.calls[2]!.json).toEqual({ name: 'mail.acme.com', region: 'eu-west-1' });

    await resendPlugin.execute(ctx, 'resend__update_domain', {
      domain: 'staging.acme.dev',
      tls: 'enforced',
      name: 'other.acme.com',
    });
    expect(fetch.calls[3]!.json).toEqual({ tls: 'enforced' });

    await resendPlugin.execute(ctx, 'resend__create_contact', {
      email: 'new@example.com',
      first_name: 'New',
      ...undeclared,
    });
    expect(fetch.calls[4]!.json).toEqual({ email: 'new@example.com', first_name: 'New' });

    await resendPlugin.execute(ctx, 'resend__update_contact', {
      id: 'ct_1',
      unsubscribed: true,
      ...undeclared,
    });
    expect(fetch.calls[5]!.json).toEqual({ unsubscribed: true });

    await resendPlugin.execute(ctx, 'resend__list_contacts', { limit: 5, ...undeclared });

    await resendPlugin.execute(ctx, 'resend__create_broadcast', {
      segment_id: 'seg_news',
      from: FROM,
      subject: 'News',
      ...undeclared,
    });
    expect(fetch.calls[7]!.json).toEqual({ from: FROM, subject: 'News', segment_id: 'seg_news' });

    await resendPlugin.execute(ctx, 'resend__update_broadcast', {
      segment_id: 'seg_news',
      id: 'brd_1',
      subject: 'v2',
      ...undeclared,
    });
    expect(fetch.calls[9]!.json).toEqual({ subject: 'v2' });
    expect(fetch.pending()).toEqual([]);
  });

  test('an envelope header or a non-array attachments value never reaches Resend', async () => {
    const fetch = mockFetch([]);
    const ctx = ctxOf(fetch);
    const base = { from: FROM, to: ['alice@acme.com'], subject: 's' };
    expect(
      await refusalText(
        resendPlugin.execute(ctx, 'resend__send_email', {
          ...base,
          headers: { Bcc: 'x@evil.com' },
        }),
      ),
    ).toMatch(/^resend: headers: 'Bcc' is an envelope header/);
    expect(
      await refusalText(
        resendPlugin.execute(ctx, 'resend__send_email', { ...base, attachments: { path: 'x' } }),
      ),
    ).toMatch(/^resend: attachments: not supported in v1/);
    expect(
      await refusalText(
        resendPlugin.execute(ctx, 'resend__send_batch_emails', {
          emails: [{ ...base, headers: { 'Reply-To': 'x@evil.com' } }],
        }),
      ),
    ).toMatch(/^resend: emails\[0\]\.headers: 'Reply-To' is an envelope header/);
    expect(fetch.calls).toHaveLength(0);
  });

  test('a created contact without an id is not added to a segment through a guessed URL', async () => {
    const fetch = mockFetch([
      { method: 'POST', url: `${RESEND_API_BASE}/contacts`, body: { object: 'contact' } },
    ]);
    const created = resendPlugin.execute(ctxOf(fetch), 'resend__create_contact', {
      email: 'new@example.com',
      segment_id: 'seg_news',
    });
    // Resend's failure to say what its API promises, not the plugin's.
    await expect(created).rejects.toBeInstanceOf(UpstreamProtocolError);
    await expect(created).rejects.toThrow(
      /Resend returned no id — it was not added to segment 'seg_news'/,
    );
    expect(fetch.calls).toHaveLength(1);
  });

  test('a call the classifier refuses is never executed', async () => {
    const fetch = mockFetch([]);
    expect(
      await refusalText(
        resendPlugin.execute(ctxOf(fetch), 'resend__send_email', {
          from: 'x@other.com',
          to: ['a@acme.com'],
          subject: 's',
        }),
      ),
    ).toMatch(/not a sending domain of this mission/);
    expect(
      await refusalText(
        resendPlugin.execute(ctxOf(fetch), 'resend__create_broadcast', {
          segment_id: 'seg_news',
          from: FROM,
          subject: 's',
          send: true,
        }),
      ),
    ).toMatch(/^resend: send:/);
    expect(fetch.calls).toHaveLength(0);
  });

  test('unknown tool is an error result, not a call', async () => {
    const fetch = mockFetch([]);
    const result = await resendPlugin.execute(ctxOf(fetch), 'resend__nope', {});
    expect(result.isError).toBe(true);
    expect(fetch.calls).toHaveLength(0);
  });

  test('domain tools use the Resend domain id from the resource ; the ref never reaches the body', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: `${RESEND_API_BASE}/domains/dom_prod`,
        body: { id: 'dom_prod', records: [] },
      },
      { method: 'PATCH', url: `${RESEND_API_BASE}/domains/dom_stg`, body: { id: 'dom_stg' } },
      { method: 'POST', url: `${RESEND_API_BASE}/domains/dom_stg/verify`, body: { id: 'dom_stg' } },
      { method: 'DELETE', url: `${RESEND_API_BASE}/domains/dom_stg`, body: { deleted: true } },
    ]);
    const ctx = ctxOf(fetch);
    await resendPlugin.execute(ctx, 'resend__get_domain', { domain: 'notifications.acme.com' });
    await resendPlugin.execute(ctx, 'resend__update_domain', {
      domain: 'staging.acme.dev',
      tls: 'enforced',
    });
    await resendPlugin.execute(ctx, 'resend__verify_domain', { domain: 'staging.acme.dev' });
    await resendPlugin.execute(ctx, 'resend__delete_domain', { domain: 'staging.acme.dev' });
    expect(fetch.calls[1]!.json).toEqual({ tls: 'enforced' });
    expect(fetch.calls[2]!.body).toBeNull();
    expect(fetch.pending()).toEqual([]);
  });

  test('a domain resource without domain_id asks for a resource refresh', async () => {
    const fetch = mockFetch([]);
    const stale: Resource = { ...prodDomain, metadata: { kind: 'domain' } };
    expect(
      await refusalText(
        resendPlugin.execute(ctxOf(fetch, [stale]), 'resend__get_domain', {
          domain: 'notifications.acme.com',
        }),
      ),
    ).toMatch(/carries no domain_id/);
  });

  test('list_domains, list_segments and list_broadcasts return only the mission resources', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: `${RESEND_API_BASE}/domains?limit=100`,
        body: {
          data: [
            { id: 'dom_prod', name: 'Notifications.acme.com' },
            { id: 'dom_x', name: 'other.acme.com' },
          ],
          has_more: false,
        },
      },
      {
        method: 'GET',
        url: `${RESEND_API_BASE}/segments?limit=100`,
        body: { data: [{ id: 'seg_news' }, { id: 'seg_vip' }], has_more: false },
      },
      {
        method: 'GET',
        url: `${RESEND_API_BASE}/broadcasts?limit=100`,
        body: {
          data: [
            { id: 'brd_1', segment_id: 'seg_news' },
            { id: 'brd_2', audience_id: 'seg_test' },
            { id: 'brd_3', segment_id: 'seg_vip' },
          ],
          has_more: false,
        },
      },
    ]);
    const ctx = ctxOf(fetch);
    expect(jsonOf(await resendPlugin.execute(ctx, 'resend__list_domains', {}))).toEqual({
      data: [{ id: 'dom_prod', name: 'Notifications.acme.com' }],
    });
    expect(jsonOf(await resendPlugin.execute(ctx, 'resend__list_segments', {}))).toEqual({
      data: [{ id: 'seg_news' }],
    });
    expect(jsonOf(await resendPlugin.execute(ctx, 'resend__list_broadcasts', {}))).toEqual({
      data: [
        { id: 'brd_1', segment_id: 'seg_news' },
        { id: 'brd_2', audience_id: 'seg_test' },
      ],
    });
  });

  test('an answer that is not JSON, or not the shape the executor reads, is an UpstreamProtocolError', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: `${RESEND_API_BASE}/emails/em_1`, body: '<html>maintenance</html>' },
      { method: 'GET', url: `${RESEND_API_BASE}/domains?limit=100`, body: { data: 'none' } },
      { method: 'GET', url: `${RESEND_API_BASE}/broadcasts/brd_1`, body: { segment_id: 7 } },
      { method: 'DELETE', url: `${RESEND_API_BASE}/contacts/ct_1`, status: 204 },
    ]);
    const ctx = ctxOf(fetch);
    await expect(
      resendPlugin.execute(ctx, 'resend__get_email', { id: 'em_1' }),
    ).rejects.toBeInstanceOf(UpstreamProtocolError);
    await expect(resendPlugin.execute(ctx, 'resend__list_domains', {})).rejects.toThrow(
      /GET \/domains: a page of .* unexpected answer/,
    );
    await expect(
      resendPlugin.execute(ctx, 'resend__get_broadcast', { id: 'brd_1', segment_id: 'seg_news' }),
    ).rejects.toThrow(/GET \/broadcasts\/brd_1: a broadcast: unexpected answer/);
    // An answer without content is still a confirmation.
    expect(
      jsonOf(await resendPlugin.execute(ctx, 'resend__delete_contact', { id: 'ct_1' })),
    ).toEqual({});
  });

  test('send_broadcast re-reads the broadcast and refuses one of another segment', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: `${RESEND_API_BASE}/broadcasts/brd_1`,
        body: { id: 'brd_1', segment_id: 'seg_news', status: 'draft' },
      },
      { method: 'POST', url: `${RESEND_API_BASE}/broadcasts/brd_1/send`, body: { id: 'brd_1' } },
      {
        method: 'GET',
        url: `${RESEND_API_BASE}/broadcasts/brd_9`,
        body: { id: 'brd_9', audience_id: 'seg_vip' },
      },
    ]);
    const ctx = ctxOf(fetch);
    const sent = await resendPlugin.execute(ctx, 'resend__send_broadcast', {
      segment_id: 'seg_news',
      id: 'brd_1',
    });
    expect(jsonOf(sent)).toEqual({ id: 'brd_1' });
    expect(fetch.calls[1]!.body).toBe('{}');
    expect(
      await refusalText(
        resendPlugin.execute(ctx, 'resend__send_broadcast', {
          segment_id: 'seg_news',
          id: 'brd_9',
        }),
      ),
    ).toMatch("broadcast 'brd_9' targets segment 'seg_vip', not 'seg_news'");
    expect(fetch.calls).toHaveLength(3);
  });

  test('get, update and delete a broadcast go through the same check ; create carries the segment', async () => {
    const draft = { id: 'brd_1', segment_id: 'seg_news', subject: 'News' };
    const fetch = mockFetch([
      { method: 'GET', url: `${RESEND_API_BASE}/broadcasts/brd_1`, body: draft, times: 3 },
      { method: 'PATCH', url: `${RESEND_API_BASE}/broadcasts/brd_1`, body: { id: 'brd_1' } },
      { method: 'DELETE', url: `${RESEND_API_BASE}/broadcasts/brd_1`, body: { deleted: true } },
      { method: 'POST', url: `${RESEND_API_BASE}/broadcasts`, body: { id: 'brd_2' } },
    ]);
    const ctx = ctxOf(fetch);
    const seg = { segment_id: 'seg_news' };
    expect(
      jsonOf(await resendPlugin.execute(ctx, 'resend__get_broadcast', { ...seg, id: 'brd_1' })),
    ).toEqual(draft);
    await resendPlugin.execute(ctx, 'resend__update_broadcast', {
      ...seg,
      id: 'brd_1',
      subject: 'v2',
    });
    expect(fetch.calls[2]!.json).toEqual({ subject: 'v2' });
    await resendPlugin.execute(ctx, 'resend__delete_broadcast', { ...seg, id: 'brd_1' });
    await resendPlugin.execute(ctx, 'resend__create_broadcast', {
      ...seg,
      from: FROM,
      subject: 'New',
    });
    expect(fetch.calls[5]!.json).toEqual({ from: FROM, subject: 'New', segment_id: 'seg_news' });
    expect(fetch.pending()).toEqual([]);
  });

  test('contacts : create then add to the segment, membership endpoints, filtered list', async () => {
    const fetch = mockFetch([
      { method: 'POST', url: `${RESEND_API_BASE}/contacts`, body: { id: 'ct_new' } },
      {
        method: 'POST',
        url: `${RESEND_API_BASE}/contacts/ct_new/segments/seg_news`,
        body: { id: 'seg_news' },
      },
      {
        method: 'DELETE',
        url: `${RESEND_API_BASE}/contacts/bob%40example.com/segments/seg_news`,
        body: {},
      },
      {
        method: 'GET',
        url: `${RESEND_API_BASE}/contacts?limit=10&segment_id=seg_news`,
        body: { data: [] },
      },
      { method: 'PATCH', url: `${RESEND_API_BASE}/contacts/ct_1`, body: { id: 'ct_1' } },
    ]);
    const ctx = ctxOf(fetch);
    const created = await resendPlugin.execute(ctx, 'resend__create_contact', {
      email: 'new@example.com',
      first_name: 'New',
      segment_id: 'seg_news',
    });
    expect(fetch.calls[0]!.json).toEqual({ email: 'new@example.com', first_name: 'New' });
    expect(jsonOf(created)).toEqual({ id: 'ct_new', segment: { id: 'seg_news' } });
    await resendPlugin.execute(ctx, 'resend__remove_contact_from_segment', {
      segment_id: 'seg_news',
      id: 'bob@example.com',
    });
    await resendPlugin.execute(ctx, 'resend__list_contacts', { segment_id: 'seg_news', limit: 10 });
    await resendPlugin.execute(ctx, 'resend__update_contact', { id: 'ct_1', unsubscribed: true });
    expect(fetch.calls[4]!.json).toEqual({ unsubscribed: true });
    expect(fetch.pending()).toEqual([]);
  });

  test('describe_zones answers from the mission resources without any call', async () => {
    const fetch = mockFetch([]);
    const out = jsonOf(await resendPlugin.execute(ctxOf(fetch), 'resend__describe_zones', {}));
    expect(out).toEqual({
      domains: [
        {
          domain: 'notifications.acme.com',
          env: 'prod',
          internal_domains: ['acme.com', 'acme.io'],
          allowlist_domains: ['partner.com'],
          allowlist_addresses: ['support@vendor.com'],
        },
        {
          domain: 'staging.acme.dev',
          env: 'staging',
          internal_domains: ['acme.com'],
          allowlist_domains: [],
          allowlist_addresses: [],
        },
      ],
    });
    expect(fetch.calls).toHaveLength(0);
  });

  test('401 and 403 are UpstreamAuthError, except a 403 validation_error ; other errors are plain', async () => {
    const fetch = mockFetch([
      { url: /\/emails\/em_401$/, status: 401, body: { statusCode: 401, name: 'missing_api_key' } },
      { url: /\/emails\/em_403$/, status: 403, body: { statusCode: 403, name: 'invalid_api_Key' } },
      {
        url: /\/emails$/,
        status: 403,
        body: { statusCode: 403, name: 'validation_error', message: 'domain is not verified' },
      },
      { url: /\/emails\/em_429$/, status: 429, body: { name: 'rate_limit_exceeded' } },
    ]);
    const ctx = ctxOf(fetch);
    await expect(
      resendPlugin.execute(ctx, 'resend__get_email', { id: 'em_401' }),
    ).rejects.toMatchObject({
      name: 'UpstreamAuthError',
      upstreamStatus: 401,
    });
    await expect(
      resendPlugin.execute(ctx, 'resend__get_email', { id: 'em_403' }),
    ).rejects.toMatchObject({
      name: 'UpstreamAuthError',
      upstreamStatus: 403,
    });
    const validation = resendPlugin.execute(ctx, 'resend__send_email', {
      from: FROM,
      to: ['a@acme.com'],
      subject: 's',
    });
    await expect(validation).rejects.toThrow(/403/);
    await expect(validation).rejects.toBeInstanceOf(UpstreamHttpError);
    await expect(validation).rejects.not.toMatchObject({ name: 'UpstreamAuthError' });
    await expect(resendPlugin.execute(ctx, 'resend__get_email', { id: 'em_429' })).rejects.toThrow(
      /429/,
    );
  });

  test('refuses a secret of another kind before any call', async () => {
    const fetch = mockFetch([]);
    const oauth: ExecuteContext = {
      ...ctxOf(fetch),
      credential: {
        kind: 'oauth2',
        accessToken: 't',
        refreshToken: null,
        expiresAt: null,
        scopes: [],
        metadata: {},
      },
    };
    await expect(resendPlugin.execute(oauth, 'resend__list_segments', {})).rejects.toMatchObject({
      name: 'CredentialKindMismatch',
    });
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('discoverResendResources with mockFetch', () => {
  const connection = (fetch: typeof globalThis.fetch): ConnectionContext => ({
    credential,
    fetch,
  });

  test('one resource per domain (empty zone lists) and per segment, paging with after', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: `${RESEND_API_BASE}/domains?limit=100`,
        body: {
          data: [
            {
              id: 'dom_1',
              name: 'Notifications.acme.com',
              status: 'verified',
              region: 'eu-west-1',
            },
          ],
          has_more: true,
        },
      },
      {
        method: 'GET',
        url: `${RESEND_API_BASE}/domains?limit=100&after=dom_1`,
        body: {
          data: [{ id: 'dom_2', name: 'staging.acme.dev', status: 'pending' }],
          has_more: false,
        },
      },
      {
        method: 'GET',
        url: `${RESEND_API_BASE}/segments?limit=100`,
        body: { data: [{ id: 'seg_news', name: 'Newsletter' }], has_more: false },
      },
    ]);
    const resources = await resendPlugin.discoverResources(connection(fetch));
    expect(resources).toEqual([
      {
        provider: 'resend',
        ref: 'notifications.acme.com',
        displayName: 'Notifications.acme.com',
        metadata: {
          kind: 'domain',
          domain_id: 'dom_1',
          status: 'verified',
          region: 'eu-west-1',
          internal_domains: [],
          allowlist_domains: [],
          allowlist_addresses: [],
        },
      },
      {
        provider: 'resend',
        ref: 'staging.acme.dev',
        displayName: 'staging.acme.dev (pending)',
        metadata: {
          kind: 'domain',
          domain_id: 'dom_2',
          status: 'pending',
          internal_domains: [],
          allowlist_domains: [],
          allowlist_addresses: [],
        },
      },
      {
        provider: 'resend',
        ref: 'seg_news',
        displayName: 'Newsletter',
        metadata: { kind: 'segment', segment_id: 'seg_news' },
      },
    ]);
    expect(fetch.calls.every((c) => c.headers.authorization === 'Bearer re_abc_123')).toBe(true);
    expect(fetch.pending()).toEqual([]);
  });

  test('an account with no domain and no segment yields no resource (the owner adds a domain first)', async () => {
    const fetch = mockFetch([
      { url: /\/domains\?limit=100$/, body: { data: [], has_more: false } },
      { url: /\/segments\?limit=100$/, body: { data: [], has_more: false } },
    ]);
    expect(await resendPlugin.discoverResources(connection(fetch))).toEqual([]);
  });

  test('a restricted or invalid key surfaces as UpstreamAuthError', async () => {
    const fetch = mockFetch([
      { url: /\/domains/, status: 403, body: { statusCode: 403, name: 'restricted_api_key' } },
    ]);
    await expect(resendPlugin.discoverResources(connection(fetch))).rejects.toMatchObject({
      name: 'UpstreamAuthError',
      upstreamStatus: 403,
    });
  });

  test('refuses a secret of another kind', async () => {
    const fetch = mockFetch([]);
    await expect(
      resendPlugin.discoverResources({
        credential: {
          kind: 'oauth2',
          accessToken: 't',
          refreshToken: null,
          expiresAt: null,
          scopes: [],
          metadata: {},
        },
        fetch,
      }),
    ).rejects.toMatchObject({ name: 'CredentialKindMismatch' });
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('credential spec and macro-actions', () => {
  test('api-key with one secret field pinned to the re_ prefix', () => {
    const spec = resendPlugin.credential;
    expect(spec.kind).toBe('api-key');
    if (spec.kind !== 'api-key') return;
    expect(spec.createUrl).toBe('https://resend.com/api-keys');
    expect(spec.fields.map((f) => [f.name, f.secret])).toEqual([['api_key', true]]);
    const pattern = new RegExp(spec.fields[0]!.pattern!);
    expect(pattern.test('re_123456789_AbCdEf')).toBe(true);
    expect(pattern.test('sk_live_abc')).toBe(false);
    expect(pattern.test('re_a b')).toBe(false);
  });

  test('macro-actions : at Confiant, bulk sends, segment writes and domain mutations ask first', () => {
    const actions = resendPlugin.catalog.macro_actions ?? [];
    expect(actions.map((a) => a.id)).toEqual(['check', 'send', 'campaign', 'domains']);
    const trustLevels = Object.fromEntries(actions.map((a) => [a.id, 'confiant' as const]));
    const approvals = policyFromMacroActions(resendPlugin, trustLevels)
      .filter((e) => e.gate === 'approval')
      .map((e) => e.risk_id);
    expect(approvals).toEqual(
      expect.arrayContaining([
        'resend.send-batch',
        'resend.broadcast-send',
        'resend.segment-write',
        'resend.domain-write',
      ]),
    );
    // Bulk sends are irreversible : they ask first even at Autonome.
    const autonome = Object.fromEntries(actions.map((a) => [a.id, 'autonome' as const]));
    const gate = (id: string) =>
      policyFromMacroActions(resendPlugin, autonome).find((e) => e.risk_id === id)?.gate;
    expect(gate('resend.send-batch')).toBe('approval');
    expect(gate('resend.broadcast-send')).toBe('approval');
    expect(gate('resend.read-email-status')).toBe('auto');
  });
});
