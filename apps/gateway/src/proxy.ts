/**
 * Next.js proxy (the request hook that runs before every route): sets the
 * security headers of the response (`server/http/security-headers.ts`; see
 * docs/handbook/configuration.md) and hands Next the nonce of the
 * Content-Security-Policy through the request headers, so that the scripts it
 * renders carry it. It decides nothing else: authentication and the origin
 * check stay in the handlers, where the public origin is known.
 */
import { randomBytes } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { publishedHttps, securityHeaders } from './server/http/security-headers';
import { currentSetup, servedInSetupMode, SETUP_PAGE } from './server/setup/state';

const NONCE_BYTES = 16;

/**
 * Every path but the git remote's (`/git/…`, spec §4.1 ter). Next clones and
 * buffers the body of every request the proxy runs on, up to
 * `proxyClientMaxBodySize`, and truncates what is beyond: the pack of a push
 * would be held in memory and cut. The git remote answers no browser, so it
 * needs none of the headers set here. A literal: Next reads it at build time.
 */
export const config = {
  matcher: ['/((?!git/).*)'],
};

export function proxy(request: NextRequest): NextResponse {
  // Setup mode: the instance has no root yet; every page but the setup's goes
  // to the setup page, at the public address (never a forwarded host).
  const setup = currentSetup();
  if (setup && !servedInSetupMode(request.nextUrl.pathname)) {
    return NextResponse.redirect(new URL(SETUP_PAGE, setup.config.publicUrl));
  }
  const nonce = randomBytes(NONCE_BYTES).toString('base64');
  const headers = securityHeaders({
    https: publishedHttps() === true,
    nonce,
    development: process.env.NODE_ENV === 'development',
  });
  const csp = headers['Content-Security-Policy'] ?? '';
  // Next reads the nonce from the request's policy and puts it on its scripts.
  const forwarded = new Headers(request.headers);
  forwarded.set('Content-Security-Policy', csp);
  forwarded.set('x-nonce', nonce);
  const response = NextResponse.next({ request: { headers: forwarded } });
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}
