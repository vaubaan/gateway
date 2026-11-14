import { mockFetch } from '@vaubaan/plugin-sdk/testing';
import type { OAuth2RegisteredClientSpec, OAuth2Secret } from '@vaubaan/plugin-sdk';
import { describe, expect, it } from 'vitest';

import {
  buildAuthorizationUrl,
  codeChallengeS256,
  exchangeCode,
  newCodeVerifier,
  newState,
  OAuth2TokenError,
  refreshGrant,
  revokeGrant,
  type OAuth2Client,
} from './oauth2';
import { OAUTH_SPEC } from '../../../tests/support/accounts/testing';

const NOW = new Date('2026-10-13T09:00:00.000Z');
const CLIENT: OAuth2Client = { clientId: 'client id/1', clientSecret: 's3cr:et+value' };
const REDIRECT = 'https://gateway.example.com/connections/callback/oauthco';
const io = (fetch: typeof globalThis.fetch) => ({ fetch, now: () => NOW });

function tokenRoute(body: unknown, status = 200) {
  return mockFetch([{ method: 'POST', url: OAUTH_SPEC.tokenUrl, status, body }]);
}

function form(body: string | null): URLSearchParams {
  return new URLSearchParams(body ?? '');
}

describe('authorization request', () => {
  it('carries the code flow parameters, the state and an S256 challenge', () => {
    const verifier = newCodeVerifier();
    const url = buildAuthorizationUrl(OAUTH_SPEC, CLIENT, {
      redirectUri: REDIRECT,
      state: 'state-1',
      codeVerifier: verifier,
    });
    expect(`${url.origin}${url.pathname}`).toBe(OAUTH_SPEC.authorizationUrl);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: CLIENT.clientId,
      redirect_uri: REDIRECT,
      scope: 'read write',
      state: 'state-1',
      code_challenge: codeChallengeS256(verifier),
      code_challenge_method: 'S256',
    });
  });

  it('computes the challenge of RFC 7636 appendix B', () => {
    expect(codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('adds the resource indicator and the extra parameters, which never override the core ones', () => {
    const spec: OAuth2RegisteredClientSpec = {
      ...OAUTH_SPEC,
      resourceIndicator: 'https://mcp.example.com',
      extraAuthorizationParams: {
        prompt: 'consent',
        redirect_uri: 'https://evil.example.net/steal',
        state: 'forced',
        client_id: 'other',
      },
    };
    const url = buildAuthorizationUrl(spec, CLIENT, {
      redirectUri: REDIRECT,
      state: 'state-1',
      codeVerifier: 'v',
    });
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('resource')).toBe('https://mcp.example.com');
    expect(url.searchParams.getAll('redirect_uri')).toEqual([REDIRECT]);
    expect(url.searchParams.getAll('state')).toEqual(['state-1']);
    expect(url.searchParams.getAll('client_id')).toEqual([CLIENT.clientId]);
  });

  it('refuses to build a PKCE request without a verifier, and omits PKCE when the spec does not ask', () => {
    expect(() =>
      buildAuthorizationUrl(OAUTH_SPEC, CLIENT, {
        redirectUri: REDIRECT,
        state: 's',
        codeVerifier: null,
      }),
    ).toThrow(/PKCE/);
    const url = buildAuthorizationUrl({ ...OAUTH_SPEC, pkce: false }, CLIENT, {
      redirectUri: REDIRECT,
      state: 's',
      codeVerifier: null,
    });
    expect(url.searchParams.has('code_challenge')).toBe(false);
  });

  it('generates distinct unguessable states and verifiers', () => {
    expect(newState()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newState()).not.toBe(newState());
    expect(newCodeVerifier()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('code exchange', () => {
  const exchange = { code: 'code-1', redirectUri: REDIRECT, codeVerifier: 'verifier-1' };

  it('authenticates with HTTP Basic (form-encoded credentials) and sends the verifier', async () => {
    const fetch = tokenRoute({
      access_token: 'at-1',
      refresh_token: 'rt-1',
      expires_in: 3600,
      scope: 'read write',
    });
    const secret = await exchangeCode(OAUTH_SPEC, CLIENT, exchange, io(fetch));
    expect(secret).toEqual({
      kind: 'oauth2',
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: '2026-10-13T10:00:00.000Z',
      scopes: ['read', 'write'],
      metadata: {},
    });
    const call = fetch.calls[0]!;
    expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const basic = Buffer.from(
      call.headers.authorization!.replace(/^Basic /, ''),
      'base64',
    ).toString();
    expect(basic).toBe('client+id%2F1:s3cr%3Aet%2Bvalue');
    expect(Object.fromEntries(form(call.body))).toEqual({
      grant_type: 'authorization_code',
      code: 'code-1',
      redirect_uri: REDIRECT,
      code_verifier: 'verifier-1',
    });
  });

  it('refuses a PKCE exchange without a verifier before calling the provider', async () => {
    const fetch = tokenRoute({ access_token: 'at' });
    await expect(
      exchangeCode(OAUTH_SPEC, CLIENT, { ...exchange, codeVerifier: null }, io(fetch)),
    ).rejects.toThrow('PKCE is required');
    expect(fetch.calls).toHaveLength(0);

    const noPkce: OAuth2RegisteredClientSpec = { ...OAUTH_SPEC, pkce: false };
    await exchangeCode(noPkce, CLIENT, { ...exchange, codeVerifier: null }, io(fetch));
    expect(form(fetch.calls[0]!.body).has('code_verifier')).toBe(false);
  });

  it('sends the credentials in the body for client_secret_post', async () => {
    const fetch = tokenRoute({ access_token: 'at-1' });
    const spec = { ...OAUTH_SPEC, clientAuthMethod: 'client_secret_post' as const };
    const secret = await exchangeCode(spec, CLIENT, exchange, io(fetch));
    const call = fetch.calls[0]!;
    expect(call.headers.authorization).toBeUndefined();
    expect(form(call.body).get('client_id')).toBe(CLIENT.clientId);
    expect(form(call.body).get('client_secret')).toBe(CLIENT.clientSecret);
    // No expires_in, no scope, no refresh token in the answer.
    expect(secret.expiresAt).toBeNull();
    expect(secret.refreshToken).toBeNull();
    expect(secret.scopes).toEqual(['read', 'write']);
  });

  it('sends only the client id for a public client', async () => {
    const fetch = tokenRoute({ access_token: 'at-1' });
    const spec = { ...OAUTH_SPEC, clientAuthMethod: 'none' as const };
    await exchangeCode(spec, { clientId: 'public', clientSecret: null }, exchange, io(fetch));
    const call = fetch.calls[0]!;
    expect(call.headers.authorization).toBeUndefined();
    expect(form(call.body).get('client_id')).toBe('public');
    expect(form(call.body).has('client_secret')).toBe(false);
  });

  it('sends the RFC 8707 resource on the token request and reads comma-delimited scopes', async () => {
    const fetch = tokenRoute({ access_token: 'at-1', scope: 'repo,read:org', expires_in: '120' });
    const spec = { ...OAUTH_SPEC, resourceIndicator: 'https://mcp.example.com' };
    const secret = await exchangeCode(spec, CLIENT, exchange, io(fetch));
    expect(form(fetch.calls[0]!.body).get('resource')).toBe('https://mcp.example.com');
    expect(secret.scopes).toEqual(['repo', 'read:org']);
    expect(secret.expiresAt).toBe('2026-10-13T09:02:00.000Z');
  });

  it('reports a rejected grant with the provider error and never echoes the client secret', async () => {
    const fetch = tokenRoute({ error: 'invalid_grant', error_description: 'code expired' }, 400);
    const err: unknown = await exchangeCode(OAUTH_SPEC, CLIENT, exchange, io(fetch)).catch(
      (e: unknown) => e,
    );
    if (!(err instanceof OAuth2TokenError)) throw new Error('expected an OAuth2TokenError');
    expect(err).toMatchObject({ status: 400, oauthError: 'invalid_grant', rejected: true });
    expect(err.message).toContain('invalid_grant: code expired');
    expect(err.message).not.toContain(CLIENT.clientSecret);
  });

  it('treats an error body under HTTP 200 as an error', async () => {
    const fetch = tokenRoute({ error: 'bad_verification_code' }, 200);
    await expect(exchangeCode(OAUTH_SPEC, CLIENT, exchange, io(fetch))).rejects.toMatchObject({
      oauthError: 'bad_verification_code',
    });
  });

  it('separates a transient failure from a rejection', async () => {
    const down = tokenRoute('upstream unavailable', 503);
    await expect(exchangeCode(OAUTH_SPEC, CLIENT, exchange, io(down))).rejects.toMatchObject({
      status: 503,
      rejected: false,
    });
    const unreachable: typeof fetch = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(exchangeCode(OAUTH_SPEC, CLIENT, exchange, io(unreachable))).rejects.toMatchObject(
      { status: 0, rejected: false },
    );
    const empty = tokenRoute({ token_type: 'bearer' });
    await expect(exchangeCode(OAUTH_SPEC, CLIENT, exchange, io(empty))).rejects.toThrow(
      /without an access token/,
    );
  });
});

describe('refresh_token grant', () => {
  const current: OAuth2Secret = {
    kind: 'oauth2',
    accessToken: 'at-old',
    refreshToken: 'rt-old',
    expiresAt: '2026-10-13T09:00:30.000Z',
    scopes: ['read'],
    metadata: { account: 'acme' },
  };

  it('rotates the refresh token when the provider issues a new one', async () => {
    const fetch = tokenRoute({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 });
    const next = await refreshGrant(OAUTH_SPEC, CLIENT, current, io(fetch));
    expect(Object.fromEntries(form(fetch.calls[0]!.body))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'rt-old',
    });
    expect(next).toEqual({
      kind: 'oauth2',
      accessToken: 'at-new',
      refreshToken: 'rt-new',
      expiresAt: '2026-10-13T10:00:00.000Z',
      scopes: ['read'],
      metadata: { account: 'acme' },
    });
  });

  it('keeps the current refresh token when the answer carries none', async () => {
    const fetch = tokenRoute({ access_token: 'at-new' });
    const next = await refreshGrant(OAUTH_SPEC, CLIENT, current, io(fetch));
    expect(next.refreshToken).toBe('rt-old');
  });

  it('is a rejection when no refresh token is stored, without calling the provider', async () => {
    const fetch = mockFetch([]);
    await expect(
      refreshGrant(OAUTH_SPEC, CLIENT, { ...current, refreshToken: null }, io(fetch)),
    ).rejects.toMatchObject({ rejected: true });
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('revocation of the grant at the provider', () => {
  const URL_ = 'https://provider.example.com/oauth/revoke';
  const secret = { accessToken: 'at-PLAINTEXT', refreshToken: 'rt-PLAINTEXT' };
  const route = (status = 200, body: unknown = {}) =>
    mockFetch([{ method: 'POST', url: URL_, status, body }]);

  it('token-form: posts the refresh token, form-encoded, with no client credentials', async () => {
    const fetch = route();
    expect(
      await revokeGrant({ url: URL_, format: 'token-form' }, CLIENT, secret, { fetch }),
    ).toEqual({ outcome: 'revoked' });
    const [call] = fetch.calls;
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(URL_);
    expect(call?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(form(call!.body))).toEqual({ token: 'rt-PLAINTEXT' });
    expect(call?.headers.authorization).toBeUndefined();
    expect(call!.body).not.toContain(CLIENT.clientSecret);
  });

  it('token-form: falls back to the access token when no refresh token is stored', async () => {
    const fetch = route();
    await revokeGrant(
      { url: URL_, format: 'token-form' },
      CLIENT,
      { ...secret, refreshToken: null },
      {
        fetch,
      },
    );
    expect(Object.fromEntries(form(fetch.calls[0]!.body))).toEqual({ token: 'at-PLAINTEXT' });
  });

  it('client-credentials-json: posts client id, client secret and refresh token as JSON', async () => {
    const fetch = route();
    expect(
      await revokeGrant({ url: URL_, format: 'client-credentials-json' }, CLIENT, secret, {
        fetch,
      }),
    ).toEqual({ outcome: 'revoked' });
    const [call] = fetch.calls;
    expect(call?.headers['content-type']).toBe('application/json');
    expect(call?.json).toEqual({
      client_id: CLIENT.clientId,
      client_secret: CLIENT.clientSecret,
      refresh_token: 'rt-PLAINTEXT',
    });
  });

  it('client-credentials-json: sends nothing without a refresh token or a client secret', async () => {
    const fetch = mockFetch([]);
    const revocation = { url: URL_, format: 'client-credentials-json' } as const;
    expect(
      await revokeGrant(revocation, CLIENT, { ...secret, refreshToken: null }, { fetch }),
    ).toEqual({ outcome: 'no-token' });
    expect(
      await revokeGrant(revocation, { ...CLIENT, clientSecret: null }, secret, { fetch }),
    ).toEqual({ outcome: 'no-token' });
    expect(fetch.calls).toHaveLength(0);
  });

  it.each([400, 401, 403, 404, 500, 503])(
    'a %i is a failed attempt: the grant may still stand',
    async (status) => {
      const fetch = route(status, { error: 'invalid_token', token: 'rt-PLAINTEXT' });
      const attempt = await revokeGrant({ url: URL_, format: 'token-form' }, CLIENT, secret, {
        fetch,
      });
      expect(attempt).toEqual({
        outcome: 'failed',
        status,
        detail: `revocation endpoint answered ${status}`,
      });
    },
  );

  it('an unreachable endpoint is a failed attempt, never an exception, and its detail names no secret', async () => {
    const unreachable: typeof globalThis.fetch = async () => {
      throw new TypeError(`connect ECONNREFUSED while sending ${secret.refreshToken}`);
    };
    const attempt = await revokeGrant({ url: URL_, format: 'token-form' }, CLIENT, secret, {
      fetch: unreachable,
    });
    expect(attempt).toEqual({
      outcome: 'failed',
      status: 0,
      detail: 'revocation endpoint unreachable (TypeError)',
    });
    expect(JSON.stringify(attempt)).not.toContain('PLAINTEXT');
  });

  it('never follows a redirect: the token goes to the declared endpoint or nowhere', async () => {
    let init: RequestInit | undefined;
    const spy: typeof globalThis.fetch = async (_input, received) => {
      init = received;
      return new Response(null, { status: 200 });
    };
    await revokeGrant({ url: URL_, format: 'token-form' }, CLIENT, secret, { fetch: spy });
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});
