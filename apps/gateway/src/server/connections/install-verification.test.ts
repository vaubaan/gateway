/**
 * The declarative installation check on its own: response shapes, pagination
 * and its cap, and what an error may say. `mockFetch` rejects any request no
 * route covers.
 */
import type { AppInstallUserVerification } from '@vaubaan/plugin-sdk';
import { mockFetch, type MockRoute } from '@vaubaan/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';

import {
  InstallationRefused,
  InstallationVerificationUnavailable,
  MAX_INSTALLATION_PAGES,
  verifyInstallation,
} from './install-verification';

const TOKEN_URL = 'https://apps.example.com/login/oauth/access_token';
const LIST_URL = 'https://api.apps.example.com/user/installations';
const USER_TOKEN = 'user-token-PLAINTEXT-0123456789';
const CLIENT = { clientId: 'cid', clientSecret: 'csecret' };

const BARE_LIST: AppInstallUserVerification = {
  codeParam: 'code',
  tokenUrl: TOKEN_URL,
  clientAuthMethod: 'client_secret_basic',
  installationsUrl: LIST_URL,
  installationIdField: 'installation',
};

const TOKEN_OK: MockRoute = { method: 'POST', url: TOKEN_URL, body: { access_token: USER_TOKEN } };

function verify(
  verification: AppInstallUserVerification,
  routes: readonly MockRoute[],
  installationId = '42',
) {
  const fetch = mockFetch(routes);
  const outcome = verifyInstallation(
    verification,
    CLIENT,
    { installationId, code: 'the-code' },
    { fetch, now: () => new Date('2026-10-13T00:00:00Z') },
  ).then(
    () => null,
    (err: unknown) => err as Error,
  );
  return { fetch, outcome };
}

describe('verifyInstallation', () => {
  it('reads a bare list in one request, ids as numbers or strings, with Basic client authentication', async () => {
    const list = [{ installation: 7 }, { installation: '42' }];
    const { fetch, outcome } = verify(BARE_LIST, [
      TOKEN_OK,
      { method: 'GET', url: LIST_URL, body: list },
    ]);
    expect(await outcome).toBeNull();
    expect(fetch.calls[0]!.headers.authorization).toBe(
      `Basic ${Buffer.from('cid:csecret').toString('base64')}`,
    );
    expect(fetch.calls[0]!.body).toBe('grant_type=authorization_code&code=the-code');
    expect(fetch.calls[1]!.headers.authorization).toBe(`Bearer ${USER_TOKEN}`);

    const numeric = verify(BARE_LIST, [TOKEN_OK, { url: LIST_URL, body: [{ installation: 42 }] }]);
    expect(await numeric.outcome).toBeNull();
  });

  it('refuses an id that is absent, a prefix of a listed one, or carried by a malformed item', async () => {
    const list = [{ installation: 420 }, { other: 42 }, { installation: null }, 42, null];
    const { outcome } = verify(BARE_LIST, [TOKEN_OK, { url: LIST_URL, body: list }]);
    const err = await outcome;
    expect(err).toBeInstanceOf(InstallationRefused);
    expect((err as InstallationRefused).reason).toBe('installation-not-listed');
  });

  it('never lets a spec header replace the Authorization the host sets', async () => {
    const { fetch, outcome } = verify(
      { ...BARE_LIST, installationsHeaders: { Authorization: 'Bearer forged', Accept: 'x/y' } },
      [TOKEN_OK, { url: LIST_URL, body: [{ installation: 42 }] }],
    );
    expect(await outcome).toBeNull();
    expect(fetch.calls[1]!.headers.authorization).toBe(`Bearer ${USER_TOKEN}`);
    expect(fetch.calls[1]!.headers.accept).toBe('x/y');
  });

  it('stops at the page cap and refuses rather than accept what it did not see', async () => {
    const paged: AppInstallUserVerification = {
      ...BARE_LIST,
      installationsListField: 'items',
      pagination: { pageParam: 'p', perPageParam: 'n', perPage: 1 },
    };
    // Every page is full and never holds the claimed id.
    const { fetch, outcome } = verify(paged, [
      TOKEN_OK,
      { url: (url) => url.startsWith(LIST_URL), body: { items: [{ installation: 1 }] } },
    ]);
    const err = await outcome;
    expect(err).toBeInstanceOf(InstallationRefused);
    expect(err!.message).toContain(`first ${MAX_INSTALLATION_PAGES} pages`);
    expect(fetch.calls).toHaveLength(1 + MAX_INSTALLATION_PAGES);
    expect(fetch.calls.at(-1)!.url).toBe(`${LIST_URL}?n=1&p=${MAX_INSTALLATION_PAGES}`);
  });

  it('separates a refusal from an unreachable provider, and no message carries the token or the secret', async () => {
    const cases: readonly [readonly MockRoute[], unknown][] = [
      [[{ url: TOKEN_URL, status: 400, body: { error: 'invalid_grant' } }], InstallationRefused],
      [[{ url: TOKEN_URL, status: 502, body: 'bad gateway' }], InstallationVerificationUnavailable],
      [[TOKEN_OK, { url: LIST_URL, status: 403, body: {} }], InstallationRefused],
      [[TOKEN_OK, { url: LIST_URL, status: 404, body: {} }], InstallationVerificationUnavailable],
      [[TOKEN_OK, { url: LIST_URL, body: 'not json' }], InstallationVerificationUnavailable],
      [
        [TOKEN_OK, { url: LIST_URL, body: { installations: [] } }],
        InstallationVerificationUnavailable,
      ],
      // No route for the list: the transport fails.
      [[TOKEN_OK], InstallationVerificationUnavailable],
    ];
    for (const [routes, expected] of cases) {
      const err = await verify(BARE_LIST, routes).outcome;
      expect(err).toBeInstanceOf(expected);
      expect(err!.message).not.toContain(USER_TOKEN);
      expect(err!.message).not.toContain(CLIENT.clientSecret);
    }
  });
});
