/**
 * Next.js proxy (the request hook that runs before every route): sets the
 * security headers of the response (`server/http/security-headers.ts`; ADR
 * security-headers-set-by-the-application) and hands Next the nonce of the
 * Content-Security-Policy through the request headers, so that the scripts it
 * renders carry it. It decides nothing else: authentication and the origin
 * check stay in the handlers, where the public origin is known.
 */
import { randomBytes } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { ownsItsPolicy, publishedHttps, securityHeaders } from './server/http/security-headers';

const NONCE_BYTES = 16;

export function proxy(request: NextRequest): NextResponse {
  if (ownsItsPolicy(request.nextUrl.pathname)) return NextResponse.next();
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
