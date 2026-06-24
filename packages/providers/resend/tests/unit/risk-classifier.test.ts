/**
 * Unit tests for `classifyResendV4` — the Resend v4 risk-based classifier.
 *
 * Spec : docs/spec/resend.md §7.
 *
 * Each test pins down :
 *   - the slice(s) emitted for a given (tool, args) call,
 *   - the to-zone classification from binding metadata,
 *   - the recipient-count emission (single / multi / batch),
 *   - the attachment denial (v1),
 *   - the broadcast send/delete slice paths,
 *   - the domain operations,
 *   - the denials (unknown tool, no binding).
 */
import { describe, expect, test } from 'vitest';
import type { ProviderBinding } from '@vaubaan/shared';
import { serializeSlice } from '@vaubaan/policy-engine';

import { classifyResendV4 } from '../../src/risk-classifier.ts';

const prodBinding: ProviderBinding = {
  id: 'b1',
  project_id: 'p1',
  provider: 'resend',
  resource_ref: 'prod-email',
  display_name: null,
  environment: 'prod',
  metadata: {
    internal_domains: ['acme.com', 'acme.io'],
    allowlist_domains: ['partner.com'],
    allowlist_addresses: ['support@vendor.com'],
    sending_domains: ['notifications.acme.com'],
  },
  created_at: '2026-01-01',
};

const stagingBinding: ProviderBinding = {
  id: 'b2',
  project_id: 'p1',
  provider: 'resend',
  resource_ref: 'staging-notif',
  display_name: null,
  environment: 'staging',
  metadata: {
    internal_domains: ['acme.com'],
    allowlist_domains: [],
    allowlist_addresses: [],
  },
  created_at: '2026-01-01',
};

function classify(
  tool: string,
  args: Record<string, unknown> = {},
  bindings: ReadonlyArray<ProviderBinding> = [prodBinding],
): string[] {
  const result = classifyResendV4(tool, args, bindings);
  if ('denied' in result) {
    throw new Error(`unexpected denial: ${result.denied}`);
  }
  return result.slices.map((s) => serializeSlice(s));
}

describe('classifyResendV4 — reads (email status)', () => {
  test('get_email(id=email_x) -> email[email_x].R', () => {
    expect(classify('resend__get_email', { id: 'email_x' })).toEqual([
      'resend.account[prod-email].email[email_x].R',
    ]);
  });
});

describe('classifyResendV4 — reads (domains)', () => {
  test('list_domains -> domain[*].R', () => {
    expect(classify('resend__list_domains')).toEqual(['resend.account[prod-email].domain[*].R']);
  });

  test('get_domain(id=dom_x) -> domain[dom_x].R + domain[dom_x].dns-record[*].R', () => {
    const sl = classify('resend__get_domain', { id: 'dom_x' });
    expect(sl).toContain('resend.account[prod-email].domain[dom_x].R');
    expect(sl).toContain('resend.account[prod-email].domain[dom_x].dns-record[*].R');
  });
});

describe('classifyResendV4 — reads (audiences + contacts)', () => {
  test('list_audiences -> audience[*].R', () => {
    expect(classify('resend__list_audiences')).toEqual([
      'resend.account[prod-email].audience[*].R',
    ]);
  });

  test('get_audience(id=aud_x) -> audience[aud_x].R', () => {
    expect(classify('resend__get_audience', { id: 'aud_x' })).toEqual([
      'resend.account[prod-email].audience[aud_x].R',
    ]);
  });

  test('list_contacts(audience_id=aud_x) -> audience[aud_x].contact[*].R', () => {
    expect(classify('resend__list_contacts', { audience_id: 'aud_x' })).toEqual([
      'resend.account[prod-email].audience[aud_x].contact[*].R',
    ]);
  });

  test('get_contact(id=contact_x) -> audience[*].contact[contact_x].R', () => {
    expect(classify('resend__get_contact', { id: 'contact_x' })).toEqual([
      'resend.account[prod-email].audience[*].contact[contact_x].R',
    ]);
  });
});

describe('classifyResendV4 — reads (broadcasts)', () => {
  test('list_broadcasts -> audience[*].broadcast[*].R', () => {
    expect(classify('resend__list_broadcasts')).toEqual([
      'resend.account[prod-email].audience[*].broadcast[*].R',
    ]);
  });

  test('get_broadcast(id=brd_x) -> audience[*].broadcast[brd_x].R', () => {
    expect(classify('resend__get_broadcast', { id: 'brd_x' })).toEqual([
      'resend.account[prod-email].audience[*].broadcast[brd_x].R',
    ]);
  });
});

describe('classifyResendV4 — writes (transactional email — to-zone)', () => {
  test('send_email to internal recipient -> to-zone[internal] + recipient-count[single]', () => {
    const sl = classify('resend__send_email', {
      from: 'noreply@acme.com',
      to: ['alice@acme.com'],
      subject: 'hello',
    });
    expect(sl).toContain('resend.account[prod-email].to-zone[internal].W');
    expect(sl).toContain('resend.account[prod-email].recipient-count[single].W');
  });

  test('send_email to allowlist domain recipient -> to-zone[allowlist]', () => {
    const sl = classify('resend__send_email', {
      from: 'noreply@acme.com',
      to: ['bob@partner.com'],
      subject: 'hello',
    });
    expect(sl).toContain('resend.account[prod-email].to-zone[allowlist].W');
  });

  test('send_email to allowlist address -> to-zone[allowlist]', () => {
    const sl = classify('resend__send_email', {
      from: 'noreply@acme.com',
      to: ['support@vendor.com'],
      subject: 'hello',
    });
    expect(sl).toContain('resend.account[prod-email].to-zone[allowlist].W');
  });

  test('send_email to external recipient -> to-zone[external-unbounded]', () => {
    const sl = classify('resend__send_email', {
      from: 'noreply@acme.com',
      to: ['unknown@attacker.com'],
      subject: 'hello',
    });
    expect(sl).toContain('resend.account[prod-email].to-zone[external-unbounded].W');
  });

  test('send_email worst-case across mixed recipients', () => {
    // One internal + one external = worst-case external-unbounded
    const sl = classify('resend__send_email', {
      from: 'noreply@acme.com',
      to: ['alice@acme.com', 'unknown@evil.com'],
      subject: 'hello',
    });
    expect(sl).toContain('resend.account[prod-email].to-zone[external-unbounded].W');
    expect(sl).toContain('resend.account[prod-email].recipient-count[multi].W');
  });

  test('send_email multi-recipient (all internal) -> recipient-count[multi]', () => {
    const sl = classify('resend__send_email', {
      from: 'noreply@acme.com',
      to: ['alice@acme.com'],
      cc: ['bob@acme.io'],
      subject: 'hello',
    });
    expect(sl).toContain('resend.account[prod-email].to-zone[internal].W');
    expect(sl).toContain('resend.account[prod-email].recipient-count[multi].W');
  });

  test('send_email with cc/bcc recipients are included in zone classification', () => {
    const sl = classify('resend__send_email', {
      from: 'noreply@acme.com',
      to: ['alice@acme.com'],
      bcc: ['spy@evil.com'],
      subject: 'hello',
    });
    expect(sl).toContain('resend.account[prod-email].to-zone[external-unbounded].W');
  });
});

describe('classifyResendV4 — writes (batch sends)', () => {
  test('send_batch_emails emits 3 slices (to-zone + recipient-count[batch] + batch.W)', () => {
    const sl = classify('resend__send_batch_emails', {
      emails: [
        { from: 'noreply@acme.com', to: ['alice@acme.com'], subject: 'hi' },
        { from: 'noreply@acme.com', to: ['bob@partner.com'], subject: 'hi' },
      ],
    });
    expect(sl).toHaveLength(3);
    expect(sl).toContain('resend.account[prod-email].to-zone[allowlist].W');
    expect(sl).toContain('resend.account[prod-email].recipient-count[batch].W');
    expect(sl).toContain('resend.account[prod-email].batch.W');
  });

  test('send_batch_emails with external recipient -> worst-case to-zone', () => {
    const sl = classify('resend__send_batch_emails', {
      emails: [
        { from: 'noreply@acme.com', to: ['alice@acme.com'], subject: 'hi' },
        { from: 'noreply@acme.com', to: ['unknown@external.com'], subject: 'hi' },
      ],
    });
    expect(sl).toContain('resend.account[prod-email].to-zone[external-unbounded].W');
  });
});

describe('classifyResendV4 — writes (domains)', () => {
  test('create_domain -> domain.W', () => {
    expect(classify('resend__create_domain', { name: 'mail.acme.com' })).toEqual([
      'resend.account[prod-email].domain.W',
    ]);
  });

  test('update_domain(id=dom_x) -> domain[dom_x].W', () => {
    expect(classify('resend__update_domain', { id: 'dom_x' })).toEqual([
      'resend.account[prod-email].domain[dom_x].W',
    ]);
  });

  test('delete_domain(id=dom_x) -> domain[dom_x].W', () => {
    expect(classify('resend__delete_domain', { id: 'dom_x' })).toEqual([
      'resend.account[prod-email].domain[dom_x].W',
    ]);
  });

  test('verify_domain(id=dom_x) -> domain[dom_x].dns-record[*].W', () => {
    expect(classify('resend__verify_domain', { id: 'dom_x' })).toEqual([
      'resend.account[prod-email].domain[dom_x].dns-record[*].W',
    ]);
  });
});

describe('classifyResendV4 — writes (audiences)', () => {
  test('create_audience -> audience.W', () => {
    expect(classify('resend__create_audience', { name: 'Newsletter' })).toEqual([
      'resend.account[prod-email].audience.W',
    ]);
  });

  test('delete_audience(id=aud_x) -> audience[aud_x].W', () => {
    expect(classify('resend__delete_audience', { id: 'aud_x' })).toEqual([
      'resend.account[prod-email].audience[aud_x].W',
    ]);
  });
});

describe('classifyResendV4 — writes (contacts)', () => {
  test('create_contact(audience_id=aud_x) -> audience[aud_x].contact.W', () => {
    expect(
      classify('resend__create_contact', { audience_id: 'aud_x', email: 'bob@acme.com' }),
    ).toEqual(['resend.account[prod-email].audience[aud_x].contact.W']);
  });

  test('update_contact(id=contact_x) -> audience[*].contact[contact_x].W', () => {
    expect(classify('resend__update_contact', { id: 'contact_x' })).toEqual([
      'resend.account[prod-email].audience[*].contact[contact_x].W',
    ]);
  });

  test('delete_contact(id=contact_x) -> audience[*].contact[contact_x].W', () => {
    expect(classify('resend__delete_contact', { id: 'contact_x' })).toEqual([
      'resend.account[prod-email].audience[*].contact[contact_x].W',
    ]);
  });
});

describe('classifyResendV4 — writes (broadcasts)', () => {
  test('create_broadcast(audience_id=aud_x) -> audience[aud_x].broadcast.W', () => {
    expect(
      classify('resend__create_broadcast', {
        audience_id: 'aud_x',
        from: 'n@acme.com',
        subject: 'news',
      }),
    ).toEqual(['resend.account[prod-email].audience[aud_x].broadcast.W']);
  });

  test('update_broadcast(id=brd_x) -> audience[*].broadcast.W', () => {
    expect(classify('resend__update_broadcast', { id: 'brd_x' })).toEqual([
      'resend.account[prod-email].audience[*].broadcast.W',
    ]);
  });

  test('send_broadcast(id=brd_x) -> audience[*].broadcast[brd_x].send.W', () => {
    expect(classify('resend__send_broadcast', { id: 'brd_x' })).toEqual([
      'resend.account[prod-email].audience[*].broadcast[brd_x].send.W',
    ]);
  });

  test('delete_broadcast(id=brd_x) -> audience[*].broadcast[brd_x].delete.W', () => {
    expect(classify('resend__delete_broadcast', { id: 'brd_x' })).toEqual([
      'resend.account[prod-email].audience[*].broadcast[brd_x].delete.W',
    ]);
  });
});

describe('classifyResendV4 — attachment denial (v1)', () => {
  test('send_email with attachments -> denied', () => {
    const result = classifyResendV4(
      'resend__send_email',
      {
        from: 'n@acme.com',
        to: ['a@acme.com'],
        subject: 'hi',
        attachments: [{ filename: 'f.txt', content: 'x' }],
      },
      [prodBinding],
    );
    expect(result).toEqual({ denied: 'attachments not supported in v1' });
  });

  test('send_email without attachments -> succeeds', () => {
    const result = classifyResendV4(
      'resend__send_email',
      { from: 'n@acme.com', to: ['a@acme.com'], subject: 'hi' },
      [prodBinding],
    );
    expect('slices' in result).toBe(true);
  });

  test('send_batch_emails with attachments in one email -> denied', () => {
    const result = classifyResendV4(
      'resend__send_batch_emails',
      {
        emails: [
          { from: 'n@acme.com', to: ['a@acme.com'], subject: 'hi' },
          {
            from: 'n@acme.com',
            to: ['b@acme.com'],
            subject: 'hi',
            attachments: [{ filename: 'f.txt', content: 'x' }],
          },
        ],
      },
      [prodBinding],
    );
    expect(result).toEqual({ denied: 'attachments not supported in v1' });
  });
});

describe('classifyResendV4 — describe_zones synthetic tool', () => {
  test('describe_zones -> domain[*].R (metadata-level, no risk)', () => {
    expect(classify('resend__describe_zones')).toEqual(['resend.account[prod-email].domain[*].R']);
  });
});

describe('classifyResendV4 — binding propagation', () => {
  test('prod binding produces account[prod-email] in slices', () => {
    expect(classify('resend__list_domains', {}, [prodBinding])).toEqual([
      'resend.account[prod-email].domain[*].R',
    ]);
  });

  test('staging binding produces account[staging-notif] in slices', () => {
    expect(classify('resend__list_domains', {}, [stagingBinding])).toEqual([
      'resend.account[staging-notif].domain[*].R',
    ]);
  });

  test('binding without resource_ref falls back to account[*]', () => {
    const noRef: ProviderBinding = {
      ...prodBinding,
      resource_ref: '',
    };
    expect(classify('resend__list_domains', {}, [noRef])).toEqual([
      'resend.account[*].domain[*].R',
    ]);
  });
});

describe('classifyResendV4 — denials', () => {
  test('unknown tool -> denied', () => {
    const result = classifyResendV4('resend__bogus', {}, [prodBinding]);
    expect(result).toEqual({ denied: "unknown resend tool 'resend__bogus'." });
  });

  test('no resend binding on the token -> denied', () => {
    const result = classifyResendV4('resend__list_domains', {}, []);
    expect(result).toEqual({ denied: 'no resend binding is attached to this token.' });
  });

  test('non-resend bindings are ignored (binding picker)', () => {
    const other: ProviderBinding = {
      ...prodBinding,
      provider: 'stripe',
    };
    const result = classifyResendV4('resend__list_domains', {}, [other]);
    expect(result).toEqual({ denied: 'no resend binding is attached to this token.' });
  });
});

describe('classifyResendV4 — spec §7.2 multi-slice examples', () => {
  test('single transactional email to internal recipient', () => {
    const sl = classify('resend__send_email', {
      from: 'noreply@acme.com',
      to: ['alice@acme.com'],
      subject: 'hi',
    });
    expect(sl).toContain('resend.account[prod-email].to-zone[internal].W');
    expect(sl).toContain('resend.account[prod-email].recipient-count[single].W');
  });

  test('single email to an external recipient', () => {
    const sl = classify('resend__send_email', {
      from: 'noreply@acme.com',
      to: ['unknown@attacker.com'],
      subject: 'hi',
    });
    expect(sl).toContain('resend.account[prod-email].to-zone[external-unbounded].W');
    expect(sl).toContain('resend.account[prod-email].recipient-count[single].W');
  });

  test('batch send to mixed recipients', () => {
    const sl = classify('resend__send_batch_emails', {
      emails: [
        { from: 'noreply@acme.com', to: ['alice@acme.com'], subject: 'hi' },
        { from: 'noreply@acme.com', to: ['unknown@external.com'], subject: 'hi' },
      ],
    });
    expect(sl).toContain('resend.account[prod-email].to-zone[external-unbounded].W');
    expect(sl).toContain('resend.account[prod-email].recipient-count[batch].W');
    expect(sl).toContain('resend.account[prod-email].batch.W');
  });

  test('broadcast send', () => {
    const sl = classify('resend__send_broadcast', { id: 'brd_xxx' });
    expect(sl).toEqual(['resend.account[prod-email].audience[*].broadcast[brd_xxx].send.W']);
  });

  test('add a new sending domain', () => {
    const sl = classify('resend__create_domain', { name: 'mail.acme.com' });
    expect(sl).toEqual(['resend.account[prod-email].domain.W']);
  });
});
