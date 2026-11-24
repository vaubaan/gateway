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
 *
 * An instance in local mode (ADR local-mode-for-an-instance-on-this-computer)
 * answers on `http://localhost`, where Safari and WKWebView refuse a `Secure`
 * cookie: its jar (`cookieJar('loopback')`) drops `Secure` and the prefix,
 * which needs it, and keeps the rest. Loopback has no network attacker and no
 * sibling subdomain. The constants below are the names of the `host` jar.
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

export function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions,
  secure = true,
): string {
  if (!COOKIE_VALUE.test(value)) throw new RangeError('cookie value must be base64url');
  const path = options.path ?? '/';
  assertHostPrefixHolds(name, path, secure);
  return [
    `${name}=${value}`,
    `Path=${path}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    'HttpOnly',
    ...(secure ? ['Secure'] : []),
    'SameSite=Lax',
  ].join('; ');
}

export function clearCookie(name: string, path = '/', secure = true): string {
  assertHostPrefixHolds(name, path, secure);
  return `${name}=; Path=${path}; Max-Age=0; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Lax`;
}

/** The cookies the instance sets, by their name without prefix. */
export type CookieBase = 'vbn_session' | 'vbn_login' | 'vbn_recover' | 'vbn_recovery';

/**
 * `host`: `__Host-` names, `Secure` (an https public URL). `loopback`: plain names,
 * no `Secure` (local mode, `http://localhost`). Both `HttpOnly`, `SameSite=Lax`.
 */
export type CookieMode = 'host' | 'loopback';

/** How the instance names, writes, reads and clears its cookies in one mode. */
export interface CookieJar {
  readonly mode: CookieMode;
  name(base: CookieBase): string;
  read(headers: Headers, base: CookieBase): string | null;
  serialize(base: CookieBase, value: string, options: CookieOptions): string;
  clear(base: CookieBase, path?: string): string;
}

export function cookieJar(mode: CookieMode): CookieJar {
  const secure = mode === 'host';
  const name = (base: CookieBase): string => (secure ? `${HOST_PREFIX}${base}` : base);
  return {
    mode,
    name,
    read: (headers, base) => readCookie(headers, name(base)),
    serialize: (base, value, options) => serializeCookie(name(base), value, options, secure),
    clear: (base, path) => clearCookie(name(base), path, secure),
  };
}

/** The jar of an instance with an https public URL: every instance but one in local mode. */
export const HOST_COOKIES: CookieJar = cookieJar('host');

/**
 * A `__Host-` cookie on another path, or without `Secure`, is dropped by the browser:
 * fail here, not silently there.
 */
function assertHostPrefixHolds(name: string, path: string, secure: boolean): void {
  if (!name.startsWith(HOST_PREFIX)) return;
  if (path !== '/') {
    throw new RangeError(`a ${HOST_PREFIX} cookie must be set on Path=/ (got ${path})`);
  }
  if (!secure) throw new RangeError(`a ${HOST_PREFIX} cookie must be Secure`);
}
