/**
 * `createdResources` of the Resend plugin (ADR created-resources-join-the-mission):
 * the domain or segment read from Resend's answer, described as discovery does.
 */
import { describe, expect, test } from 'vitest';

import { createdResendResources } from '../../src/created.ts';
import { resendPlugin } from '../../src/index.ts';

/** What `executeResend` returns: the service's JSON, pretty-printed. */
const answer = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
});

describe('resend createdResources', () => {
  test('create_domain: the domain, its id, status and region, empty recipient zones', () => {
    expect(
      createdResendResources(
        'resend__create_domain',
        { name: 'Mail.Acme.com' },
        answer({
          id: '4dd369bc-aa82-4ff3-97de-514ae3000ee0',
          name: 'Mail.Acme.com',
          status: 'not_started',
          region: 'us-east-1',
          records: [],
        }),
      ),
    ).toEqual([
      {
        service: 'resend',
        ref: 'mail.acme.com',
        displayName: 'Mail.Acme.com (not_started)',
        metadata: {
          kind: 'domain',
          domain_id: '4dd369bc-aa82-4ff3-97de-514ae3000ee0',
          status: 'not_started',
          region: 'us-east-1',
          internal_domains: [],
          allowlist_domains: [],
          allowlist_addresses: [],
        },
      },
    ]);
    expect(resendPlugin.createdResources).toBe(createdResendResources);
  });

  test('create_segment: the segment, ref = its id', () => {
    expect(
      createdResendResources(
        'resend__create_segment',
        { name: 'Beta users' },
        answer({
          object: 'segment',
          id: '78261eea-8f8b-4381-83c6-79fa7120f1cf',
          name: 'Beta users',
        }),
      ),
    ).toEqual([
      {
        service: 'resend',
        ref: '78261eea-8f8b-4381-83c6-79fa7120f1cf',
        displayName: 'Beta users',
        metadata: { kind: 'segment', segment_id: '78261eea-8f8b-4381-83c6-79fa7120f1cf' },
      },
    ]);
  });

  test('nothing from an id or a domain outside the grammar, or another tool', () => {
    expect(
      createdResendResources('resend__create_domain', {}, answer({ id: '../x', name: 'a.com' })),
    ).toEqual([]);
    expect(
      createdResendResources(
        'resend__create_domain',
        {},
        answer({ id: 'abc', name: 'not a domain' }),
      ),
    ).toEqual([]);
    expect(createdResendResources('resend__create_segment', {}, answer({ name: 'x' }))).toEqual([]);
    expect(createdResendResources('resend__create_segment', {}, { content: [] })).toEqual([]);
    expect(
      createdResendResources('resend__get_domain', {}, answer({ id: 'abc', name: 'a.com' })),
    ).toEqual([]);
  });
});
