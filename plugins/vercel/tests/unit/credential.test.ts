/**
 * The Vercel access token (`credential.ts`) against `mockFetch` : the guide
 * the connect page shows and the check at paste.
 */
import { describe, expect, test } from 'vitest';

import {
  CredentialRefusal,
  UpstreamAuthError,
  UpstreamProtocolError,
  type ConnectionContext,
} from '@vaubaan/plugin-sdk';
import { guideText, mockFetch, type MockRoute } from '@vaubaan/plugin-sdk/testing';

import {
  VERCEL_API_BASE,
  VERCEL_TOKENS_URL,
  vercelCredential,
  verifyVercelToken,
} from '../../src/index.ts';

const CURRENT = `${VERCEL_API_BASE}/v5/user/tokens/current`;
const TEAM = `${VERCEL_API_BASE}/v2/teams/team_abc`;

const ctx = (fetch: typeof globalThis.fetch): ConnectionContext => ({
  credential: {
    kind: 'api-key',
    fields: { token: 'vcp_secret', team_id: 'team_abc' },
    metadata: {},
  },
  fetch,
});

const current = (token: Record<string, unknown>): MockRoute => ({
  method: 'GET',
  url: CURRENT,
  body: { token: { id: 'tk_1', name: 'gateway', ...token } },
});

describe('vercel token — the guide', () => {
  test('the token page, the team with All Projects, the Team ID read first', () => {
    expect(vercelCredential.createUrl).toBe(VERCEL_TOKENS_URL);
    const text = guideText(vercelCredential.guide);
    expect(text.indexOf('Team ID')).toBeLessThan(text.indexOf('Account Settings, Tokens'));
    expect(vercelCredential.guide.reach.grant).toBe('The team, All Projects');
    expect(vercelCredential.guide.expiry).toEqual({ kind: 'provider-reports' });
  });
});

describe('vercel token — verify at paste', () => {
  test('names the team the token opens and reads the expiry', async () => {
    const fetch = mockFetch([
      current({ expiresAt: Date.UTC(2027, 0, 31) }),
      { method: 'GET', url: TEAM, body: { id: 'team_abc', name: 'Acme', slug: 'acme' } },
    ]);
    expect(await verifyVercelToken(ctx(fetch))).toEqual({
      account: 'the Acme team',
      expiresAt: '2027-01-31T00:00:00.000Z',
    });
    expect(fetch.calls.every((c) => c.headers.authorization === 'Bearer vcp_secret')).toBe(true);
  });

  test('a token without expiration has none', async () => {
    const fetch = mockFetch([current({}), { method: 'GET', url: TEAM, body: { slug: 'acme' } }]);
    expect(await verifyVercelToken(ctx(fetch))).toEqual({
      account: 'the acme team',
      expiresAt: null,
    });
  });

  test.each([403, 404])(
    'a token that cannot open the team (HTTP %i) is refused with the scope to choose',
    async (status) => {
      const fetch = mockFetch([current({}), { method: 'GET', url: TEAM, status, body: {} }]);
      const check = verifyVercelToken(ctx(fetch));
      await expect(check).rejects.toBeInstanceOf(CredentialRefusal);
      await expect(check).rejects.toThrow(/cannot open the team team_abc.*All Projects/);
    },
  );

  test('a rejected token is an UpstreamAuthError', async () => {
    const fetch = mockFetch([{ method: 'GET', url: CURRENT, status: 401, body: {} }]);
    const check = verifyVercelToken(ctx(fetch));
    await expect(check).rejects.toBeInstanceOf(UpstreamAuthError);
    await expect(check).rejects.not.toBeInstanceOf(CredentialRefusal);
  });

  test('an answer that is not JSON is an UpstreamProtocolError', async () => {
    const fetch = mockFetch([{ method: 'GET', url: CURRENT, body: '<html>' }]);
    await expect(verifyVercelToken(ctx(fetch))).rejects.toBeInstanceOf(UpstreamProtocolError);
  });
});
