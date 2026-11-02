/**
 * The security headers of every response (spec §6 "browser hardening set by the
 * instance itself"; docs/handbook/configuration.md). One source of
 * truth: `src/proxy.ts` applies them to every request it sees, and the reference
 * reverse proxy (`deploy/caddy/Caddyfile`) sets none of them, so a deployment
 * behind any TLS terminator — Railway's edge, a load balancer — has them.
 *
 * Content-Security-Policy:
 *
 *   default-src 'self'                  nothing from another origin
 *   script-src 'self' 'nonce-…' 'strict-dynamic'
 *                                       only the scripts Next renders with this
 *                                       request's nonce (and what they load); no
 *                                       inline script of anyone else
 *   style-src 'self' 'unsafe-inline'    the stylesheets of the app and the `style`
 *                                       attributes React renders (a nonce cannot
 *                                       cover an attribute)
 *   img-src 'self' data: blob:, font-src 'self' data:, connect-src 'self'
 *   worker-src 'self'                   the service worker `/sw.js` (notifications,
 *                                       spec §4.2 bis). Without it the worker falls back
 *                                       to `script-src`, where `'strict-dynamic'` drops
 *                                       `'self'`: the registration would be blocked
 *   manifest-src 'self'                 the web app manifest, explicitly rather than by
 *                                       the `default-src` fallback
 *   object-src 'none', base-uri 'none', frame-src 'none'
 *   frame-ancestors 'none'              no page of the gateway in a frame
 *
 * No `form-action`: Chrome applies it to the redirects that follow a form post,
 * and a sign-in, the connect flow of an account and the answer to an OAuth
 * consent are form posts that end at another origin (the provider, a CLI
 * agent's loopback address), chosen at run time.
 *
 * The documents of the OAuth authorization server (`/oauth/authorize/**`) carry a
 * stricter policy of their own (`server/oauth-as/pages.ts`, `default-src 'none'`
 * and the nonce of their one style element): `OWN_POLICY_PATHS` leaves them alone.
 */

/** The paths whose responses set their own security headers. */
export const OWN_POLICY_PATHS: readonly string[] = ['/oauth/authorize'];

/** One year, this host only: sibling hosts are not the gateway's to bind. */
export const HSTS_VALUE = 'max-age=31536000';

/** Devices and capabilities no page of the gateway uses. */
export const PERMISSIONS_POLICY =
  'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()';

export interface SecurityHeaderOptions {
  /** The public URL is https: HSTS is sent (a browser ignores it over http anyway). */
  readonly https: boolean;
  /** The nonce of this response's scripts. */
  readonly nonce: string;
  /** `next dev` evaluates code: `'unsafe-eval'` in development only. */
  readonly development?: boolean;
}

export function contentSecurityPolicy(nonce: string, development = false): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** The response headers, by name. */
export function securityHeaders(options: SecurityHeaderOptions): Record<string, string> {
  return {
    'Content-Security-Policy': contentSecurityPolicy(options.nonce, options.development),
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    // `same-origin`, not `no-referrer`: a same-origin form post without `Origin` is
    // accepted on its `Referer` (handbook authentication, Invariants).
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': PERMISSIONS_POLICY,
    ...(options.https ? { 'Strict-Transport-Security': HSTS_VALUE } : {}),
  };
}

export function ownsItsPolicy(pathname: string): boolean {
  return OWN_POLICY_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

const PUBLIC_URL_KEY = Symbol.for('vaubaan.gateway.publicUrlIsHttps');

/**
 * The composition root publishes whether its public URL is https, once, at boot;
 * the proxy reads it on every request without importing the root (its bundle stays
 * small). `null` before the root is built: no HSTS then.
 */
export function publishHttps(https: boolean): void {
  (globalThis as Record<symbol, unknown>)[PUBLIC_URL_KEY] = https;
}

export function publishedHttps(): boolean | null {
  const value = (globalThis as Record<symbol, unknown>)[PUBLIC_URL_KEY];
  return typeof value === 'boolean' ? value : null;
}
