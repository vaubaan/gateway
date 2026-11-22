/**
 * The demo identity provider: the suite's `FakeIdp` (an OpenID Connect
 * provider in memory, ES256 key generated per instance) published over real
 * HTTP on the demo listener, under `/__demo/idp`.
 *
 *   GET  /__demo/idp/.well-known/openid-configuration   discovery
 *   GET  /__demo/idp/jwks                               signing key
 *   GET  /__demo/idp/authorize                          the account picker
 *   POST /__demo/idp/token                              code → ID token
 *   GET  /__demo/idp/userinfo
 *
 * The gateway's relying party discovers it and exchanges codes with it over
 * HTTP like any other IdP, so `/login`, the redirect and `/auth/callback/idp` run
 * exactly as they do against Okta or Keycloak. The only thing that is not an
 * IdP's is the authorize page: no password, three accounts to pick from.
 *
 * Never part of the image: this file lives under `tests/`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';

import type { CustomFetch } from '../../src/server/auth/relying-party';
import { FakeIdp } from '../integration/auth/fake-idp';
import { claimsOf, DEMO_PEOPLE, personByKey, type DemoPerson } from './people';

export const DEMO_IDP_PATH = '/__demo/idp';
const ACCOUNT_PARAM = 'account';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export class DemoIdp extends FakeIdp {
  /** `http://localhost:<port>`: the origin the browser and the relying party use. */
  private readonly origin: string;

  constructor(origin: string) {
    // The client secret is generated per run and never leaves the process.
    super({
      issuer: origin,
      clientId: 'vaubaan-gateway-demo',
      clientSecret: randomBytes(24).toString('hex'),
    });
    this.origin = origin;
  }

  /** The issuer identifier the gateway is configured with. */
  get publicIssuer(): URL {
    return new URL(`${this.origin}${DEMO_IDP_PATH}`);
  }

  /** `FakeIdp`'s metadata, every endpoint moved under `/__demo/idp`. */
  override metadata(): Record<string, unknown> {
    const moved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(super.metadata())) {
      moved[key] =
        typeof value === 'string' && value.startsWith(this.origin)
          ? `${this.origin}${DEMO_IDP_PATH}${value.slice(this.origin.length)}`
          : value;
    }
    return moved;
  }

  /** The public URL of a request, as `FakeIdp` knows its own endpoints (prefix removed). */
  private internal(publicUrl: URL): URL {
    return new URL(
      `${publicUrl.pathname.slice(DEMO_IDP_PATH.length)}${publicUrl.search}`,
      this.origin,
    );
  }

  /**
   * The user-agent step for `person`: validates the authorization request and
   * answers the callback URL the browser is sent to, carrying a code bound to
   * that person's claims. Used by the picker, and by the seed for its sign-ins.
   */
  consent(authorizationUrl: URL, person: DemoPerson): URL {
    const request = this.internal(authorizationUrl);
    request.searchParams.delete(ACCOUNT_PARAM);
    this.nextClaims = claimsOf(person);
    return this.authorize(request);
  }

  /** Serves a request under `/__demo/idp`. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (url.pathname === `${DEMO_IDP_PATH}/authorize` && req.method === 'GET') {
      this.authorizePage(res, url);
      return;
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[name] = value;
    }
    const method = req.method ?? 'GET';
    const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
    // `FakeIdp.fetch` only reads the method, the headers and the body.
    const options = { method, headers, body, redirect: 'manual' } as Parameters<CustomFetch>[1];
    const response = await this.fetch(this.internal(url).href, options);
    res.writeHead(response.status, {
      'Content-Type': response.headers.get('content-type') ?? 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(await response.text());
  }

  private authorizePage(res: ServerResponse, url: URL): void {
    const person = personByKey(url.searchParams.get(ACCOUNT_PARAM));
    if (person) {
      let callback: URL;
      try {
        callback = this.consent(url, person);
      } catch (err) {
        this.page(res, 400, `<p class="error">${escapeHtml(String(err))}</p>`);
        return;
      }
      res.writeHead(303, { Location: callback.href, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    const accounts = DEMO_PEOPLE.map((p) => {
      const choice = new URL(url);
      choice.searchParams.set(ACCOUNT_PARAM, p.key);
      const href = `${choice.pathname}${choice.search}`;
      return `<li><a class="account" href="${escapeHtml(href)}"><strong>${escapeHtml(p.name)}</strong> — ${escapeHtml(p.tagline)}<span>${escapeHtml(p.email)}</span></a></li>`;
    }).join('\n');
    this.page(
      res,
      200,
      `<h1>Sign in to the demo</h1>
<p>Pick an account. No password: this identity provider only exists in this process.</p>
<ul>${accounts}</ul>`,
    );
  }

  private page(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(demoPage('Demo identity provider', body));
  }
}

/** The shell of the pages the demo serves itself (account picker). */
export function demoPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Vaubaan Gateway demo</title>
<style>
  /* The shared palette (\`@vaubaan/design-tokens\`, as hex): paper, ink, hairline, accent. */
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; background: #fbfbf9; color: #1b2128; }
  .banner { background: #e8edfb; color: #1f3f9e; border-bottom: 1px solid #b9c8f2; padding: 8px 16px;
            font-size: 14px; text-align: center; }
  main { max-width: 520px; margin: 48px auto; padding: 32px; background: #ffffff; border: 1px solid #dde1e6;
         border-radius: 12px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
  ul { list-style: none; padding: 0; margin: 24px 0 0; }
  li + li { margin-top: 12px; }
  a.account { display: block; padding: 14px 16px; border: 1px solid #b4bcc6; border-radius: 8px;
              color: inherit; text-decoration: none; }
  a.account:hover, a.account:focus { border-color: #2f55c7; background: #e8edfb; }
  a.account span { display: block; color: #56606b; font-size: 14px; }
  .error { color: #a3121e; }
</style>
</head>
<body>
<div class="banner">DEMO — simulated identity provider and services, no data leaves this machine</div>
<main>
${body}
</main>
</body>
</html>
`;
}

export { escapeHtml };
