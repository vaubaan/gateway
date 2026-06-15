import { describe, expect, test } from 'vitest';
import { signEmailToken, verifyEmailToken, EmailTokenError } from '@/lib/approvals/email-token';

const SECRET = 'test-secret-supersecure-min-32-chars-long';

describe('email-token', () => {
  test('roundtrip — sign then verify', async () => {
    const payload = {
      approvalId: 'b1c2d3e4-f5a6-7890-abcd-ef0123456789',
      decision: 'approve' as const,
      exp: Math.floor(Date.now() / 1000) + 900,
    };
    const token = await signEmailToken(payload, SECRET);
    const verified = await verifyEmailToken(token, SECRET);
    expect(verified).toEqual(payload);
  });

  test('rejects a malformed token', async () => {
    await expect(verifyEmailToken('not.valid', SECRET)).rejects.toThrow(EmailTokenError);
    await expect(verifyEmailToken('only-one-part', SECRET)).rejects.toThrow(EmailTokenError);
    await expect(verifyEmailToken('a.b.c.d', SECRET)).rejects.toThrow(EmailTokenError);
  });

  test('rejects a token signed with a different secret', async () => {
    const token = await signEmailToken(
      { approvalId: 'x', decision: 'deny', exp: 9999999999 },
      SECRET,
    );
    await expect(verifyEmailToken(token, 'other-secret')).rejects.toThrow(EmailTokenError);
  });

  test('rejects an expired token', async () => {
    const token = await signEmailToken(
      { approvalId: 'x', decision: 'approve', exp: Math.floor(Date.now() / 1000) - 1 },
      SECRET,
    );
    await expect(verifyEmailToken(token, SECRET)).rejects.toThrow(/expired/);
  });

  test('rejects an invalid payload shape', async () => {
    // Manually craft a token with bad payload structure.
    const enc = new TextEncoder();
    const badPayload = enc.encode(JSON.stringify({ approvalId: 'x' /* missing decision/exp */ }));
    const b64 = btoa(String.fromCharCode(...badPayload))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const fakeSig = 'XXXX';
    await expect(verifyEmailToken(`${b64}.${fakeSig}`, SECRET)).rejects.toThrow(EmailTokenError);
  });

  test('approve vs deny tokens are distinct (different signatures)', async () => {
    const exp = Math.floor(Date.now() / 1000) + 900;
    const approve = await signEmailToken({ approvalId: 'x', decision: 'approve', exp }, SECRET);
    const deny = await signEmailToken({ approvalId: 'x', decision: 'deny', exp }, SECRET);
    expect(approve).not.toBe(deny);
    // Tampering : take approve's payload but deny's sig → fails.
    const [, denySig] = deny.split('.');
    const [approvePayload] = approve.split('.');
    await expect(verifyEmailToken(`${approvePayload}.${denySig}`, SECRET)).rejects.toThrow(
      EmailTokenError,
    );
  });
});
