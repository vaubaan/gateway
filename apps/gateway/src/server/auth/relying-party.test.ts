import { describe, expect, it } from 'vitest';

import { createRelyingPartyFactory, type CustomFetch } from './relying-party';

const ISSUER = new URL('https://login.example.com/realms/acme');
const WELL_KNOWN = 'https://login.example.com/realms/acme/.well-known/openid-configuration';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function checkerAnswering(answer: (url: string) => Response | Promise<Response>): {
  check: (issuer: URL) => Promise<string | null>;
  asked: string[];
} {
  const asked: string[] = [];
  const fetch: CustomFetch = (url) => {
    asked.push(url);
    return Promise.resolve(answer(url));
  };
  const factory = createRelyingPartyFactory({
    publicUrl: new URL('https://gateway.example.com'),
    fetch,
  });
  return { check: (issuer) => factory.checkIssuer(issuer), asked };
}

describe('RelyingPartyFactory.checkIssuer — the form checks discovery before saving', () => {
  it('accepts an issuer whose discovery document names it', async () => {
    const { check, asked } = checkerAnswering(() =>
      json({
        issuer: ISSUER.href,
        authorization_endpoint: `${ISSUER.href}/auth`,
        token_endpoint: `${ISSUER.href}/token`,
        jwks_uri: `${ISSUER.href}/certs`,
      }),
    );
    expect(await check(ISSUER)).toBeNull();
    expect(asked).toEqual([WELL_KNOWN]);
  });

  it('refuses an issuer without a discovery document (GitHub answers 404)', async () => {
    const { check } = checkerAnswering(() => new Response('Not Found', { status: 404 }));
    expect(await check(ISSUER)).toBe(
      `there is no OpenID Connect discovery document at ${WELL_KNOWN} (HTTP 404): check the issuer`,
    );
  });

  it('refuses a discovery document that names another issuer, and says which', async () => {
    const { check } = checkerAnswering(() =>
      json({ issuer: 'https://login.example.com/realms/other' }),
    );
    expect(await check(ISSUER)).toBe(
      `the discovery document at ${WELL_KNOWN} names another issuer (https://login.example.com/realms/other): give the issuer exactly as the sign-in provider writes it there`,
    );
  });

  it('refuses an answer that is not a discovery document', async () => {
    const page = checkerAnswering(
      () =>
        new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    expect(await page.check(ISSUER)).toBe(
      `${WELL_KNOWN} is not a valid OpenID Connect discovery document: check the issuer`,
    );
    const noIssuer = checkerAnswering(() => json({ authorization_endpoint: 'x' }));
    expect(await noIssuer.check(ISSUER)).toBe(
      `${WELL_KNOWN} is not a valid OpenID Connect discovery document: check the issuer`,
    );
  });

  it('refuses an issuer it cannot reach, with the cause', async () => {
    const { check } = checkerAnswering(() => {
      throw new TypeError('fetch failed');
    });
    expect(await check(ISSUER)).toMatch(
      new RegExp(
        `^the discovery document at ${WELL_KNOWN.replace(/[.]/g, '\\.')} could not be fetched \\(.*fetch failed.*\\): check the issuer, and that the gateway can reach it$`,
      ),
    );
  });
});
