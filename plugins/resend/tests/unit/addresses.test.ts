/**
 * One string, one address. A recipient field is classified on the address it
 * parses to and sent to Resend as the string it was given: if that string can
 * be read as two addresses (a list in the display name), the zone decided is
 * the zone of one recipient and the mail goes to another.
 */
import type { Resource } from '@vaubaan/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { classifyResend } from '../../src/classify.ts';
import { collectRecipients, parseAddress } from '../../src/zones.ts';

const domain: Resource = {
  provider: 'resend',
  ref: 'notifications.acme.com',
  displayName: 'notifications.acme.com',
  env: 'prod',
  metadata: {
    kind: 'domain',
    domain_id: 'dom_prod',
    internal_domains: ['acme.com'],
    allowlist_domains: [],
    allowlist_addresses: [],
  },
};

describe('parseAddress — a string that could carry a second recipient is not an address', () => {
  it('reads a bare address and a plain display name', () => {
    expect(parseAddress('Bob@Internal.com')?.address).toBe('bob@internal.com');
    expect(parseAddress('Bob Martin <bob@internal.com>')?.address).toBe('bob@internal.com');
    expect(parseAddress('  Acme Notifications <noreply@acme.com> ')?.domain).toBe('acme.com');
    expect(parseAddress("O'Brien-Smith (Ops) <ops@acme.com>")?.address).toBe('ops@acme.com');
  });

  it.each([
    ['a list in the display name', 'x@evil.example, Bob <bob@internal.com>'],
    ['a semicolon list', 'x@evil.example; Bob <bob@internal.com>'],
    ['an address as the display name', 'x@evil.example <bob@internal.com>'],
    ['a header break in the display name', 'Bob\r\nBcc: x@evil.example <bob@internal.com>'],
    ['a newline in the display name', 'Bob\nx <bob@internal.com>'],
    ['a quoted display name hiding a list', '"x@evil.example, Bob" <bob@internal.com>'],
    ['a bare comma list', 'x@evil.example,bob@internal.com'],
    ['a comma in the local part', 'evil,bob@internal.com'],
    ['a semicolon in the local part', 'evil;bob@internal.com'],
    ['a control character', 'Bob\u0000 <bob@internal.com>'],
    ['two angle forms', 'A <a@evil.example> B <bob@internal.com>'],
  ])('refuses %s', (_name, value) => {
    expect(parseAddress(value)).toBeNull();
    expect(collectRecipients({ to: value })).toHaveProperty('denied');
    expect(collectRecipients({ to: ['bob@internal.com', value] })).toHaveProperty('denied');
  });

  it('a send whose `to` hides a second recipient is denied, not classified on the visible one', () => {
    const outcome = classifyResend(
      'resend__send_email',
      {
        from: 'Acme <noreply@notifications.acme.com>',
        to: 'x@evil.example, Bob <bob@acme.com>',
        subject: 'hello',
        text: 'hello',
      },
      [domain],
    );
    expect(outcome).toHaveProperty('denied');
    // The same send with the one visible recipient is an internal send.
    const plain = classifyResend(
      'resend__send_email',
      {
        from: 'Acme <noreply@notifications.acme.com>',
        to: 'Bob <bob@acme.com>',
        subject: 'hello',
        text: 'hello',
      },
      [domain],
    );
    expect(plain).toHaveProperty('slices');
  });
});
