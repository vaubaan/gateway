/**
 * The Cloudflare API token (`credential.ts`) against `mockFetch` : the guide
 * the connect page shows and the check at paste.
 */
import { describe, expect, test } from 'vitest';

import {
  CredentialRefusal,
  UpstreamAuthError,
  UpstreamProtocolError,
  type AccountContext,
} from '@vaubaan/plugin-sdk';
import { mockFetch, type MockRoute } from '@vaubaan/plugin-sdk/testing';

import {
  CLOUDFLARE_API_BASE,
  cloudflareDnsCredential,
  cloudflareDnsPlugin,
  verifyCloudflareToken,
} from '../../src/index.ts';

const TOKEN = 'cfut_0123456789abcdefghij';
const VERIFY = `${CLOUDFLARE_API_BASE}/user/tokens/verify`;
const ZONES = `${CLOUDFLARE_API_BASE}/zones?page=1&per_page=50`;

const ctx = (fetch: typeof globalThis.fetch): AccountContext => ({
  credential: { kind: 'api-key', fields: { api_token: TOKEN }, metadata: {} },
  fetch,
});

const active = (extra: Record<string, unknown> = {}): MockRoute => ({
  method: 'GET',
  url: VERIFY,
  body: { success: true, result: { id: 't1', status: 'active', ...extra } },
});

const zones = (...accounts: string[]): MockRoute => ({
  method: 'GET',
  url: ZONES,
  body: {
    result: accounts.map((name, i) => ({ id: `z${i}`, name: `z${i}.example`, account: { name } })),
  },
});

describe('cloudflare-dns token — the guide', () => {
  test('is the one way of connecting, with the token page, all zones, and why wide', () => {
    expect(cloudflareDnsPlugin.credential).toBe(cloudflareDnsCredential);
    expect(cloudflareDnsCredential.createUrl).toBe(
      'https://dash.cloudflare.com/profile/api-tokens',
    );
    const paths = cloudflareDnsCredential.guide.steps.map((step) => step.path);
    expect(paths).toContainEqual(['My Profile', 'API Tokens', 'Create Token']);
    expect(paths).toContainEqual([
      'Policies',
      'Add new policy',
      'Zone policy',
      'Include',
      'All zones',
    ]);
    expect(cloudflareDnsCredential.guide.screenshots?.['create-token.webp']?.licence).toBe(
      'CC-BY-4.0',
    );
    expect(cloudflareDnsCredential.guide.expiry).toEqual({ kind: 'service-reports' });
  });

  test('the permission rows are the token builder’s, every tool served by one', () => {
    const names = new Set(cloudflareDnsCredential.guide.permissions.map((p) => p.name));
    expect([...names]).toEqual([
      'Zone · Zone',
      'Zone · DNS',
      'Zone · Zone Settings',
      'Zone · Cache Purge',
    ]);
  });
});

describe('cloudflare-dns token — verify at paste', () => {
  test('names the accounts of the zones it reaches and reads the expiry', async () => {
    const fetch = mockFetch([
      active({ expires_on: '2027-01-31T00:00:00Z' }),
      zones('Acme', 'Acme', 'Beta'),
    ]);
    const check = await verifyCloudflareToken(ctx(fetch));
    expect(check).toEqual({ account: 'Acme, Beta', expiresAt: '2027-01-31T00:00:00.000Z' });
    expect(fetch.calls.map((c) => c.headers.authorization)).toEqual([
      `Bearer ${TOKEN}`,
      `Bearer ${TOKEN}`,
    ]);
  });

  test('a token without TTL has no expiry; more than three accounts are counted', async () => {
    const fetch = mockFetch([active(), zones('A', 'B', 'C', 'D', 'E')]);
    expect(await verifyCloudflareToken(ctx(fetch))).toEqual({
      account: 'A, B, C and 2 more',
      expiresAt: null,
    });
  });

  test('a token that is not active is refused in the plugin’s words', async () => {
    const fetch = mockFetch([
      { method: 'GET', url: VERIFY, body: { result: { id: 't1', status: 'disabled' } } },
    ]);
    await expect(verifyCloudflareToken(ctx(fetch))).rejects.toThrow(
      new CredentialRefusal(
        'Cloudflare says this token is disabled: create a new one under My Profile, API Tokens.',
      ),
    );
  });

  test.each([
    ['lists no zone', zones()],
    ['may not read zones', { method: 'GET', url: ZONES, status: 403, body: {} }],
  ])('a token that %s is refused with the permission and zones to give', async (_, route) => {
    const fetch = mockFetch([active(), route]);
    const refusal = verifyCloudflareToken(ctx(fetch));
    await expect(refusal).rejects.toBeInstanceOf(CredentialRefusal);
    await expect(refusal).rejects.toThrow(/Zone · Zone · Read.*All zones/);
  });

  test('an answer without the envelope Cloudflare documents is an UpstreamProtocolError', async () => {
    const fetch = mockFetch([{ method: 'GET', url: VERIFY, body: { success: true } }]);
    await expect(verifyCloudflareToken(ctx(fetch))).rejects.toBeInstanceOf(UpstreamProtocolError);
  });

  test('a rejected token is an UpstreamAuthError', async () => {
    const fetch = mockFetch([{ method: 'GET', url: VERIFY, status: 401, body: {} }]);
    await expect(verifyCloudflareToken(ctx(fetch))).rejects.toBeInstanceOf(UpstreamAuthError);
  });
});
