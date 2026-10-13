/**
 * Cookie plumbing for the web session and the pending-login cookie.
 *
 * Both cookies are `HttpOnly`, `Secure` (the public URL is always https) and
 * `SameSite=Lax`: Lax lets the top-level redirect back from the IdP carry the
 * pending-login cookie while still withholding both cookies from cross-site
 * sub-requests. Mutations additionally pass the origin check (`origin.ts`).
 *
 * Both names carry the `__Host-` prefix (RFC 6265bis §4.1.3.2): a browser
 * accepts such a cookie only when it is `Secure`, has `Path=/` and no `Domain`
 * attribute, and was set by the host itself. A sibling subdomain of the
 * instance (`evil.corp.example` next to `gateway.corp.example`) therefore
 * cannot plant a session cookie of its own in a visitor's browser (session
 * fixation by cookie tossing). `serializeCookie` refuses to write a prefixed
 * cookie that would break one of the three conditions.
 */

/** The prefix whose guarantees the browser enforces (Secure, Path=/, no Domain, host-only). */
export const HOST_PREFIX = '__Host-';
export const SESSION_COOKIE = `${HOST_PREFIX}vbn_session`;
export const LOGIN_COOKIE = `${HOST_PREFIX}vbn_login`;

const COOKIE_VALUE = /^[A-Za-z0-9_-]+$/;

/** What separates two pairs of a `Cookie` header besides `;` (RFC 6265 §4.2.1: one SP; tabs tolerated). */
const PAIR_PADDING = /^[ \t]+/;

/**
 * The value of the cookie named **exactly** `name`, or `null`.
 *
 * Exactly: only the padding after the `;` separator is dropped, and nothing
 * after the name. A browser applies the `__Host-` rules to the literal name, so
 * a name that merely *trims* to ours — `\u00a0__Host-vbn_session` — is to the
 * browser an ordinary cookie that a sibling subdomain may set for the parent
 * domain. Matching it here (as `String.prototype.trim` would, which strips
 * Unicode white space) would hand that subdomain the very session fixation the
 * prefix exists to prevent.
 *
 * And once: a browser holds at most one host-only cookie of a name on `Path=/`,
 * so the name appearing twice means something else wrote one of them. Which one
 * cannot be told, so neither is a session.
 */
export function readCookie(headers: Headers, name: string): string | null {
  const header = headers.get('cookie');
  if (!header) return null;
  let found: string | null = null;
  let matches = 0;
  for (const part of header.split(';')) {
    const pair = part.replace(PAIR_PADDING, '');
    const eq = pair.indexOf('=');
    if (eq < 0 || pair.slice(0, eq) !== name) continue;
    matches += 1;
    const value = pair.slice(eq + 1);
    found = COOKIE_VALUE.test(value) ? value : null;
  }
  return matches === 1 ? found : null;
}

export interface CookieOptions {
  readonly maxAgeSeconds: number;
  readonly path?: string;
}

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  if (!COOKIE_VALUE.test(value)) throw new RangeError('cookie value must be base64url');
  const path = options.path ?? '/';
  assertHostPrefixHolds(name, path);
  return [
    `${name}=${value}`,
    `Path=${path}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

export function clearCookie(name: string, path = '/'): string {
  assertHostPrefixHolds(name, path);
  return `${name}=; Path=${path}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/** A `__Host-` cookie on another path is dropped by the browser: fail here, not silently there. */
function assertHostPrefixHolds(name: string, path: string): void {
  if (name.startsWith(HOST_PREFIX) && path !== '/') {
    throw new RangeError(`a ${HOST_PREFIX} cookie must be set on Path=/ (got ${path})`);
  }
}
