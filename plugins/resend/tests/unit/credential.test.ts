/**
 * The Resend API key (`credential.ts`) against `mockFetch` : the guide the
 * connect page shows and the check at paste.
 */
import { describe, expect, test } from 'vitest';

import {
  CredentialRefusal,
  UpstreamAuthError,
  UpstreamProtocolError,
  type ConnectionContext,
} from '@vaubaan/plugin-sdk';
import { guideText, mockFetch } from '@vaubaan/plugin-sdk/testing';

import {
  RESEND_API_BASE,
  RESEND_API_KEYS_PAGE,
  resendCredential,
  resendPlugin,
  verifyResendKey,
} from '../../src/index.ts';

const DOMAINS = `${RESEND_API_BASE}/domains`;

const ctx = (fetch: typeof globalThis.fetch): ConnectionContext => ({
  credential: { kind: 'api-key', fields: { api_key: 're_secret_0123' }, metadata: {} },
  fetch,
});

const domains = (...names: string[]) =>
  mockFetch([
    {
      method: 'GET',
      url: DOMAINS,
      body: { object: 'list', has_more: false, data: names.map((name) => ({ id: name, name })) },
    },
  ]);

describe('resend key — the guide', () => {
  test('the API keys page, Full access for every tool, and why not Sending access', () => {
    expect(resendPlugin.credential).toBe(resendCredential);
    expect(resendCredential.createUrl).toBe(RESEND_API_KEYS_PAGE);
    expect(resendCredential.guide.permissions.map((p) => p.name)).toEqual(['Full access']);
    expect(guideText(resendCredential.guide)).toMatch(/Sending access key cannot list/);
  });
});

describe('resend key — verify at paste', () => {
  test('names the account by the domains it lists', async () => {
    const fetch = domains('acme.example', 'beta.example', 'c.example', 'd.example');
    expect(await verifyResendKey(ctx(fetch))).toEqual({
      account: 'acme.example, beta.example, c.example and 1 more',
      expiresAt: null,
    });
    expect(fetch.calls[0]!.headers.authorization).toBe('Bearer re_secret_0123');
  });

  test('a key with no domain yet names no account', async () => {
    expect(await verifyResendKey(ctx(domains()))).toEqual({ account: null, expiresAt: null });
  });

  test('a Sending access key is refused with the permission to choose', async () => {
    const fetch = mockFetch([
      {
        method: 'GET',
        url: DOMAINS,
        status: 401,
        body: { name: 'restricted_api_key', message: 'This API key is restricted.' },
      },
    ]);
    const check = verifyResendKey(ctx(fetch));
    await expect(check).rejects.toBeInstanceOf(CredentialRefusal);
    await expect(check).rejects.toThrow(/Create a key with Full access/);
  });

  test('a Sending access key answered 403 is refused the same way', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: DOMAINS, status: 403, body: { name: 'restricted_api_key' } },
    ]);
    await expect(verifyResendKey(ctx(fetch))).rejects.toMatchObject({
      name: 'CredentialRefusal',
      upstreamStatus: 403,
    });
  });

  test('an answer that is not JSON is an UpstreamProtocolError', async () => {
    const fetch = mockFetch([{ method: 'GET', url: DOMAINS, body: '<html>maintenance</html>' }]);
    await expect(verifyResendKey(ctx(fetch))).rejects.toBeInstanceOf(UpstreamProtocolError);
  });

  test('another rejection is an UpstreamAuthError', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: DOMAINS, status: 403, body: { name: 'invalid_api_key' } },
    ]);
    const check = verifyResendKey(ctx(fetch));
    await expect(check).rejects.toBeInstanceOf(UpstreamAuthError);
    await expect(check).rejects.not.toBeInstanceOf(CredentialRefusal);
  });
});
