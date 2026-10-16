/**
 * Unit tests for `classifyResend` — the Resend risk classifier
 * (`(tool, args, resources) → slices`), one scenario per tool.
 *
 * Spec : docs/spec/resend.md §7 ; docs/spec/vaubaan-gateway.md §10
 *        ("a classification error is a security hole").
 *
 * Each test pins down :
 *   - the slice(s) emitted for a given (tool, args) call,
 *   - the to-zone classification from the sending domain's metadata,
 *   - the batch marker (`recipient-count[batch]`), emitted by a batch only,
 *   - the attachment denial (v1) and the envelope-header denial,
 *   - the broadcast send/delete slice paths,
 *   - the domain operations,
 *   - the denials (unknown tool, no sending domain in the mission).
 *
 * The cross-cutting rules (malformed input, batch limits, broadcast dispatch,
 * env resolution) are in `plugin.test.ts`.
 */
import { describe, expect, test } from 'vitest';

import { serializeSlice, type Resource } from '@vaubaan/plugin-sdk';

import { classifyResend } from '../../src/classify.ts';

const prodDomain: Resource = {
  provider: 'resend',
  ref: 'notifications.acme.com',
  displayName: 'notifications.acme.com',
  env: 'prod',
  metadata: {
    kind: 'domain',
    domain_id: 'dom_prod',
    internal_domains: ['acme.com', 'acme.io'],
    allowlist_domains: ['partner.com'],
    allowlist_addresses: ['support@vendor.com'],
  },
};

const stagingDomain: Resource = {
  provider: 'resend',
  ref: 'staging.acme.dev',
  displayName: 'staging.acme.dev',
  env: 'staging',
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
  ref: 'seg_x',
  displayName: 'Newsletter',
  env: 'prod',
  metadata: { kind: 'segment', segment_id: 'seg_x' },
};

const mission: readonly Resource[] = [prodDomain, newsletter];

const FROM = 'noreply@notifications.acme.com';
const DOMAIN = 'resend.domain[notifications.acme.com]';
const SEGMENT = 'resend.segment[seg_x]';

function classify(
  tool: string,
  args: Record<string, unknown> = {},
  resources: readonly Resource[] = mission,
): string[] {
  const result = classifyResend(tool, args, resources);
  if ('denied' in result) {
    throw new Error(`unexpected denial: ${result.denied}`);
  }
  return result.slices.map((s) => serializeSlice(s));
}

describe('classifyResend — reads (email status)', () => {
  test('get_email(id=email_x) -> email[email_x].R', () => {
    expect(classify('resend__get_email', { id: 'email_x' })).toEqual(['resend.email[email_x].R']);
  });
});

describe('classifyResend — reads (domains)', () => {
  test('list_domains -> domain[*].R', () => {
    expect(classify('resend__list_domains')).toEqual(['resend.domain[*].R']);
  });

  test('get_domain(domain) -> domain[D].R + domain[D].dns-record[*].R', () => {
    const sl = classify('resend__get_domain', { domain: 'notifications.acme.com' });
    expect(sl).toContain(`${DOMAIN}.R`);
    expect(sl).toContain(`${DOMAIN}.dns-record[*].R`);
  });
});

describe('classifyResend — reads (segments + contacts)', () => {
  test('list_segments -> segment[*].R', () => {
    expect(classify('resend__list_segments')).toEqual(['resend.segment[*].R']);
  });

  test('list_contacts(segment_id=seg_x) -> segment[seg_x].member[*].R', () => {
    expect(classify('resend__list_contacts', { segment_id: 'seg_x' })).toEqual([
      `${SEGMENT}.member[*].R`,
    ]);
  });

  test('get_contact(id=contact_x) -> contact[contact_x].R', () => {
    expect(classify('resend__get_contact', { id: 'contact_x' })).toEqual([
      'resend.contact[contact_x].R',
    ]);
  });
});

describe('classifyResend — reads (broadcasts)', () => {
  test('list_broadcasts -> segment[*].broadcast[*].R', () => {
    expect(classify('resend__list_broadcasts')).toEqual(['resend.segment[*].broadcast[*].R']);
  });

  test('get_broadcast(segment_id, id=brd_x) -> segment[seg_x].broadcast[brd_x].R', () => {
    expect(classify('resend__get_broadcast', { segment_id: 'seg_x', id: 'brd_x' })).toEqual([
      `${SEGMENT}.broadcast[brd_x].R`,
    ]);
  });
});

describe('classifyResend — writes (transactional email — to-zone)', () => {
  test('send_email to internal recipient -> to-zone[internal], and no other slice', () => {
    const sl = classify('resend__send_email', {
      from: FROM,
      to: ['alice@acme.com'],
      subject: 'hello',
    });
    expect(sl).toEqual([`${DOMAIN}.to-zone[internal].W`]);
  });

  test('send_email to allowlist domain recipient -> to-zone[allowlist]', () => {
    const sl = classify('resend__send_email', {
      from: FROM,
      to: ['bob@partner.com'],
      subject: 'hello',
    });
    expect(sl).toContain(`${DOMAIN}.to-zone[allowlist].W`);
  });

  test('send_email to allowlist address -> to-zone[allowlist]', () => {
    const sl = classify('resend__send_email', {
      from: FROM,
      to: ['support@vendor.com'],
      subject: 'hello',
    });
    expect(sl).toContain(`${DOMAIN}.to-zone[allowlist].W`);
  });

  test('send_email to external recipient -> to-zone[external-unbounded]', () => {
    const sl = classify('resend__send_email', {
      from: FROM,
      to: ['unknown@attacker.com'],
      subject: 'hello',
    });
    expect(sl).toContain(`${DOMAIN}.to-zone[external-unbounded].W`);
  });

  test('send_email worst-case across mixed recipients', () => {
    // One internal + one external = worst-case external-unbounded
    const sl = classify('resend__send_email', {
      from: FROM,
      to: ['alice@acme.com', 'unknown@evil.com'],
      subject: 'hello',
    });
    expect(sl).toEqual([`${DOMAIN}.to-zone[external-unbounded].W`]);
  });

  test('send_email multi-recipient (all internal) -> the zone slice only, no count marker', () => {
    const sl = classify('resend__send_email', {
      from: FROM,
      to: ['alice@acme.com'],
      cc: ['bob@acme.io'],
      subject: 'hello',
    });
    expect(sl).toEqual([`${DOMAIN}.to-zone[internal].W`]);
  });

  test('send_email with cc/bcc recipients are included in zone classification', () => {
    const sl = classify('resend__send_email', {
      from: FROM,
      to: ['alice@acme.com'],
      bcc: ['spy@evil.com'],
      subject: 'hello',
    });
    expect(sl).toContain(`${DOMAIN}.to-zone[external-unbounded].W`);
  });
});

describe('classifyResend — writes (batch sends)', () => {
  test('send_batch_emails emits 2 slices per sending domain (to-zone + recipient-count[batch])', () => {
    const sl = classify('resend__send_batch_emails', {
      emails: [
        { from: FROM, to: ['alice@acme.com'], subject: 'hi' },
        { from: FROM, to: ['bob@partner.com'], subject: 'hi' },
      ],
    });
    expect(sl).toEqual([`${DOMAIN}.to-zone[allowlist].W`, `${DOMAIN}.recipient-count[batch].W`]);
  });

  test('send_batch_emails with external recipient -> worst-case to-zone', () => {
    const sl = classify('resend__send_batch_emails', {
      emails: [
        { from: FROM, to: ['alice@acme.com'], subject: 'hi' },
        { from: FROM, to: ['unknown@external.com'], subject: 'hi' },
      ],
    });
    expect(sl).toContain(`${DOMAIN}.to-zone[external-unbounded].W`);
  });
});

describe('classifyResend — writes (domains)', () => {
  const domain = { domain: 'notifications.acme.com' };

  test('create_domain -> domain.W', () => {
    expect(classify('resend__create_domain', { name: 'mail.acme.com' })).toEqual([
      'resend.domain.W',
    ]);
  });

  test('update_domain(domain) -> domain[D].W', () => {
    expect(classify('resend__update_domain', domain)).toEqual([`${DOMAIN}.W`]);
  });

  test('delete_domain(domain) -> domain[D].W', () => {
    expect(classify('resend__delete_domain', domain)).toEqual([`${DOMAIN}.W`]);
  });

  test('verify_domain(domain) -> domain[D].dns-record[*].W', () => {
    expect(classify('resend__verify_domain', domain)).toEqual([`${DOMAIN}.dns-record[*].W`]);
  });
});

describe('classifyResend — writes (contacts)', () => {
  test('create_contact(segment_id=seg_x) -> contact.W + segment[seg_x].member[*].W', () => {
    expect(
      classify('resend__create_contact', { segment_id: 'seg_x', email: 'bob@acme.com' }),
    ).toEqual(['resend.contact.W', `${SEGMENT}.member[*].W`]);
  });

  test('update_contact(id=contact_x) -> contact[contact_x].W', () => {
    expect(classify('resend__update_contact', { id: 'contact_x' })).toEqual([
      'resend.contact[contact_x].W',
    ]);
  });

  test('delete_contact(id=contact_x) -> contact[contact_x].W', () => {
    expect(classify('resend__delete_contact', { id: 'contact_x' })).toEqual([
      'resend.contact[contact_x].W',
    ]);
  });
});

describe('classifyResend — writes (broadcasts)', () => {
  const target = { segment_id: 'seg_x', id: 'brd_x' };

  test('create_broadcast(segment_id=seg_x) -> segment[seg_x].broadcast.W', () => {
    expect(
      classify('resend__create_broadcast', { segment_id: 'seg_x', from: FROM, subject: 'news' }),
    ).toEqual([`${SEGMENT}.broadcast.W`]);
  });

  test('update_broadcast(id=brd_x) -> segment[seg_x].broadcast[brd_x].W', () => {
    expect(classify('resend__update_broadcast', target)).toEqual([`${SEGMENT}.broadcast[brd_x].W`]);
  });

  test('send_broadcast(id=brd_x) -> segment[seg_x].broadcast[brd_x].send.W', () => {
    expect(classify('resend__send_broadcast', target)).toEqual([
      `${SEGMENT}.broadcast[brd_x].send.W`,
    ]);
  });

  test('delete_broadcast(id=brd_x) -> segment[seg_x].broadcast[brd_x].delete.W', () => {
    expect(classify('resend__delete_broadcast', target)).toEqual([
      `${SEGMENT}.broadcast[brd_x].delete.W`,
    ]);
  });
});

describe('classifyResend — attachment denial (v1)', () => {
  test('send_email with attachments -> denied', () => {
    const result = classifyResend(
      'resend__send_email',
      {
        from: FROM,
        to: ['a@acme.com'],
        subject: 'hi',
        attachments: [{ filename: 'f.txt', content: 'x' }],
      },
      mission,
    );
    expect(result).toEqual({ denied: 'attachments: not supported in v1' });
  });

  test('send_email without attachments -> succeeds', () => {
    const result = classifyResend(
      'resend__send_email',
      { from: FROM, to: ['a@acme.com'], subject: 'hi' },
      mission,
    );
    expect('slices' in result).toBe(true);
  });

  test('send_batch_emails with attachments in one email -> denied', () => {
    const result = classifyResend(
      'resend__send_batch_emails',
      {
        emails: [
          { from: FROM, to: ['a@acme.com'], subject: 'hi' },
          {
            from: FROM,
            to: ['b@acme.com'],
            subject: 'hi',
            attachments: [{ filename: 'f.txt', content: 'x' }],
          },
        ],
      },
      mission,
    );
    expect(result).toEqual({ denied: 'emails[1].attachments: not supported in v1' });
  });
});

describe('classifyResend — fields that would escape the classification', () => {
  const send = (extra: Record<string, unknown>) =>
    classifyResend(
      'resend__send_email',
      { from: FROM, to: ['a@acme.com'], subject: 'hi', ...extra },
      mission,
    );
  const deniedReason = (extra: Record<string, unknown>) => {
    const result = send(extra);
    return 'denied' in result ? result.denied : null;
  };

  test.each([
    'To',
    'Cc',
    'Bcc',
    'bcc',
    'BCC',
    'From',
    'Sender',
    'Reply-To',
    'reply-to',
    'Return-Path',
    'Resent-To',
    'Resent-Cc',
    'Resent-Bcc',
    'Resent-From',
    'Resent-Sender',
  ])('a %s header is refused — an internal send stays internal', (header) => {
    expect(deniedReason({ headers: { [header]: 'spy@evil.com' } })).toBe(
      `headers: '${header}' is an envelope header — use the from, to, cc, bcc and reply_to fields`,
    );
  });

  test('a header name or value the classifier cannot read as one header is refused', () => {
    expect(deniedReason({ headers: { 'X-A\r\nBcc': 'spy@evil.com' } })).toBe(
      'headers: malformed header name',
    );
    expect(deniedReason({ headers: { 'Bcc ': 'spy@evil.com' } })).toBe(
      'headers: malformed header name',
    );
    expect(deniedReason({ headers: { 'Bcc:': 'spy@evil.com' } })).toBe(
      'headers: malformed header name',
    );
    expect(deniedReason({ headers: { '': 'x' } })).toBe('headers: malformed header name');
    expect(deniedReason({ headers: { 'X-Ref': 'a\r\nBcc: spy@evil.com' } })).toBe(
      "headers: 'X-Ref' must be a single-line string",
    );
    expect(deniedReason({ headers: { 'X-Ref': ['a', 'b'] } })).toBe(
      "headers: 'X-Ref' must be a single-line string",
    );
    expect(deniedReason({ headers: { 'X-Ref': 42 } })).toBe(
      "headers: 'X-Ref' must be a single-line string",
    );
  });

  test('headers of another shape than an object are refused', () => {
    for (const headers of ['Bcc: spy@evil.com', ['Bcc', 'spy@evil.com'], null, 42, true]) {
      expect(deniedReason({ headers }), JSON.stringify(headers)).toBe(
        'headers: expected an object of header names and string values',
      );
    }
  });

  test('ordinary custom headers are accepted and do not change the slice', () => {
    const result = send({
      headers: { 'X-Entity-Ref-ID': 'abc-123', 'List-Unsubscribe': '<https://acme.com/u>' },
    });
    expect(result).toEqual(send({}));
    expect(send({ headers: {} })).toEqual(send({}));
  });

  test('an envelope header in one email of a batch refuses the batch', () => {
    const result = classifyResend(
      'resend__send_batch_emails',
      {
        emails: [
          { from: FROM, to: ['a@acme.com'], subject: 'hi' },
          { from: FROM, to: ['b@acme.com'], subject: 'hi', headers: { Bcc: 'spy@evil.com' } },
        ],
      },
      mission,
    );
    expect(result).toEqual({
      denied:
        "emails[1].headers: 'Bcc' is an envelope header — use the from, to, cc, bcc and reply_to fields",
    });
  });

  test('attachments in any shape but an empty list are refused', () => {
    for (const attachments of [{ filename: 'f.txt' }, 'f.txt', null, 1, true, [null]]) {
      expect(deniedReason({ attachments }), JSON.stringify(attachments)).toBe(
        'attachments: not supported in v1',
      );
    }
    expect(deniedReason({ attachments: [] })).toBeNull();
    expect(
      classifyResend(
        'resend__send_batch_emails',
        { emails: [{ from: FROM, to: ['a@acme.com'], subject: 'hi', attachments: 'f.txt' }] },
        mission,
      ),
    ).toEqual({ denied: 'emails[0].attachments: not supported in v1' });
  });

  test('an id made of dots only is refused — it would collapse the URL path', () => {
    for (const id of ['.', '..', '...']) {
      expect(classifyResend('resend__get_email', { id }, mission)).toEqual({
        denied: 'id: missing or malformed identifier',
      });
      expect(classifyResend('resend__delete_contact', { id }, mission)).toEqual({
        denied: 'id: missing or malformed contact id or email',
      });
      expect(
        classifyResend('resend__send_broadcast', { segment_id: 'seg_x', id }, mission),
      ).toEqual({ denied: 'id: missing or malformed identifier' });
    }
    // Resend ids are UUIDs : a dot is refused wherever it stands, not only alone.
    expect(classifyResend('resend__get_email', { id: 'a.b' }, mission)).toEqual({
      denied: 'id: missing or malformed identifier',
    });
  });
});

describe('classifyResend — describe_zones synthetic tool', () => {
  test('describe_zones -> domain[*].R (metadata-level, no risk)', () => {
    expect(classify('resend__describe_zones')).toEqual(['resend.domain[*].R']);
  });
});

describe('classifyResend — resource propagation', () => {
  const both = [prodDomain, stagingDomain, newsletter];
  const send = (from: string) =>
    classify('resend__send_email', { from, to: ['bob@acme.io'], subject: 'hi' }, both);

  test('a send from the prod domain is rooted at it and zoned by its lists', () => {
    expect(send(FROM)).toEqual([`${DOMAIN}.to-zone[internal].W`]);
  });

  test('a send from the staging domain is rooted at it and zoned by its own lists', () => {
    // acme.io is internal for the prod domain only.
    expect(send('noreply@staging.acme.dev')).toEqual([
      'resend.domain[staging.acme.dev].to-zone[external-unbounded].W',
    ]);
  });

  test('a from on no mission domain is denied — never widened to domain[*]', () => {
    const result = classifyResend(
      'resend__send_email',
      { from: 'noreply@acme.com', to: ['alice@acme.com'], subject: 'hi' },
      both,
    );
    expect(result).toEqual({ denied: "from: 'acme.com' is not a sending domain of this mission" });
  });
});

describe('classifyResend — denials', () => {
  const send = { from: FROM, to: ['alice@acme.com'], subject: 'hi' };
  const notASendingDomain = {
    denied: "from: 'notifications.acme.com' is not a sending domain of this mission",
  };

  test('unknown tool -> denied', () => {
    const result = classifyResend('resend__bogus', {}, mission);
    expect(result).toEqual({ denied: "unknown resend tool 'resend__bogus'." });
  });

  test('no resend resource in the mission -> a send is denied', () => {
    expect(classifyResend('resend__send_email', send, [])).toEqual(notASendingDomain);
  });

  test('resources of another provider are ignored (resource picker)', () => {
    const other: Resource = { ...prodDomain, provider: 'stripe' };
    expect(classifyResend('resend__send_email', send, [other])).toEqual(notASendingDomain);
    expect(classifyResend('resend__get_domain', { domain: prodDomain.ref }, [other])).toEqual({
      denied: "domain: 'notifications.acme.com' is not a sending domain of this mission",
    });
  });
});

describe('classifyResend — spec §7.2 examples', () => {
  test('single transactional email to internal recipient', () => {
    const sl = classify('resend__send_email', {
      from: FROM,
      to: ['alice@acme.com'],
      subject: 'hi',
    });
    expect(sl).toEqual([`${DOMAIN}.to-zone[internal].W`]);
  });

  test('single email to an external recipient', () => {
    const sl = classify('resend__send_email', {
      from: FROM,
      to: ['unknown@attacker.com'],
      subject: 'hi',
    });
    expect(sl).toEqual([`${DOMAIN}.to-zone[external-unbounded].W`]);
  });

  test('batch send to mixed recipients', () => {
    const sl = classify('resend__send_batch_emails', {
      emails: [
        { from: FROM, to: ['alice@acme.com'], subject: 'hi' },
        { from: FROM, to: ['unknown@external.com'], subject: 'hi' },
      ],
    });
    expect(sl).toContain(`${DOMAIN}.to-zone[external-unbounded].W`);
    expect(sl).toContain(`${DOMAIN}.recipient-count[batch].W`);
    expect(sl).not.toContain(`${DOMAIN}.batch.W`);
  });

  test('broadcast send', () => {
    const sl = classify('resend__send_broadcast', { segment_id: 'seg_x', id: 'brd_xxx' });
    expect(sl).toEqual([`${SEGMENT}.broadcast[brd_xxx].send.W`]);
  });

  test('add a new sending domain', () => {
    const sl = classify('resend__create_domain', { name: 'mail.acme.com' });
    expect(sl).toEqual(['resend.domain.W']);
  });
});
