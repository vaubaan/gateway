/**
 * Cookie plumbing for the web session and the pending-login cookie.
 *
 * Both cookies are `HttpOnly`, `Secure` (the public URL is always https) and
 * `SameSite=Lax`: Lax lets the top-level redirect back from the IdP carry the
 * pending-login cookie while still withholding both cookies from cross-site
 * sub-requests. Mutations additionally pass the origin check (`origin.ts`).
 */

export const SESSION_COOKIE = 'vbn_session';
export const LOGIN_COOKIE = 'vbn_login';

const COOKIE_VALUE = /^[A-Za-z0-9_-]+$/;

export function readCookie(headers: Headers, name: string): string | null {
  const header = headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return COOKIE_VALUE.test(value) ? value : null;
  }
  return null;
}

export interface CookieOptions {
  readonly maxAgeSeconds: number;
  readonly path?: string;
}

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  if (!COOKIE_VALUE.test(value)) throw new RangeError('cookie value must be base64url');
  return [
    `${name}=${value}`,
    `Path=${options.path ?? '/'}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

export function clearCookie(name: string, path = '/'): string {
  return `${name}=; Path=${path}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
