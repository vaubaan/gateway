/**
 * Redirect URIs of OAuth clients: what may be registered, and what an
 * authorization request may present (spec §6 "anti-redirect"; OAuth 2.1 §2.3,
 * RFC 8252 §7, RFC 9700 §2.1).
 *
 * Registration accepts three kinds, and nothing else:
 *
 *   loopback    `http://127.0.0.1[:port]/…`, `http://[::1][:port]/…`,
 *               `http://localhost[:port]/…` — the code can only reach the
 *               user's own machine (a CLI or desktop agent)
 *   web         `https://host/…` — the code goes to a server on the network
 *   app-scheme  a private-use scheme (`cursor://…`, `com.example.app:/cb`) —
 *               the code goes to whichever application the user's system
 *               bound to the scheme
 *
 * A request's `redirect_uri` must be one of the registered strings exactly.
 * The single exception is the one OAuth 2.1 requires for native applications:
 * a loopback URI may differ from a registered loopback URI by its port alone,
 * because such a client listens on a port the operating system picks at the
 * moment of the request.
 */

export type RedirectKind = 'loopback' | 'web' | 'app-scheme';

export type RedirectCheck =
  | { readonly ok: true; readonly kind: RedirectKind; readonly url: URL }
  | { readonly ok: false; readonly reason: string };

export const MAX_REDIRECT_URI_LENGTH = 1024;

/** C0 controls, DEL, space and backslash: never part of a URI we would redirect to. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_CHARACTERS = /[\u0000-\u0020\u007f\\]/;
const SCHEME = /^[a-z][a-z0-9+.-]*$/;

/**
 * Schemes a browser gives a meaning of its own: redirecting to one would run
 * script, read a local file or open another protocol handler, never deliver a
 * code to a client.
 */
const REFUSED_SCHEMES: ReadonlySet<string> = new Set([
  'javascript',
  'data',
  'vbscript',
  'file',
  'blob',
  'about',
  'ftp',
  'ws',
  'wss',
  'mailto',
  'tel',
  'sms',
  'view-source',
  'resource',
  'jar',
  'chrome',
  'chrome-extension',
  'moz-extension',
]);

function refuse(reason: string): RedirectCheck {
  return { ok: false, reason };
}

/** `127.0.0.0/8`, `::1` and the name `localhost` (RFC 8252 §7.3, §8.3). */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '[::1]') return true;
  const parts = host.split('.');
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

/** Classifies a redirect URI, or says why it can never be one. */
export function checkRedirectUri(raw: unknown): RedirectCheck {
  if (typeof raw !== 'string' || raw.length === 0) return refuse('must be a non-empty string');
  if (raw.length > MAX_REDIRECT_URI_LENGTH) {
    return refuse(`must be at most ${MAX_REDIRECT_URI_LENGTH} characters long`);
  }
  if (UNSAFE_CHARACTERS.test(raw)) {
    return refuse('must not contain spaces, control characters or backslashes');
  }
  if (raw.includes('#')) return refuse('must not contain a fragment');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse('is not an absolute URI');
  }
  if (url.username !== '' || url.password !== '') return refuse('must not carry credentials');
  const scheme = url.protocol.slice(0, -1);
  if (scheme === 'http' || scheme === 'https') {
    if (url.hostname === '') return refuse('must name a host');
    if (isLoopbackHost(url.hostname)) return { ok: true, kind: 'loopback', url };
    if (scheme === 'http') {
      return refuse('may use http only for the loopback interface (127.0.0.1, [::1], localhost)');
    }
    return { ok: true, kind: 'web', url };
  }
  if (!SCHEME.test(scheme) || REFUSED_SCHEMES.has(scheme)) {
    return refuse(`must not use the ${scheme} scheme`);
  }
  return { ok: true, kind: 'app-scheme', url };
}

/** Whether every URI of a client stays on the user's own machine through the loopback interface. */
export function isLoopbackOnly(redirectUris: readonly string[]): boolean {
  return (
    redirectUris.length > 0 &&
    redirectUris.every((uri) => {
      const check = checkRedirectUri(uri);
      return check.ok && check.kind === 'loopback';
    })
  );
}

function sameExceptPort(a: URL, b: URL): boolean {
  return (
    a.protocol === b.protocol &&
    a.hostname.toLowerCase() === b.hostname.toLowerCase() &&
    a.pathname === b.pathname &&
    a.search === b.search
  );
}

/**
 * Whether `presented` is a redirect URI of the client: one of the registered
 * strings exactly, or — loopback only — a registered loopback URI on another
 * port. No prefix, no pattern, no normalisation beyond that.
 */
export function matchesRegisteredRedirect(
  registered: readonly string[],
  presented: string,
): boolean {
  if (registered.includes(presented)) return true;
  const check = checkRedirectUri(presented);
  if (!check.ok || check.kind !== 'loopback') return false;
  return registered.some((uri) => {
    const candidate = checkRedirectUri(uri);
    return (
      candidate.ok && candidate.kind === 'loopback' && sameExceptPort(candidate.url, check.url)
    );
  });
}

/**
 * Where the code will go, as the consent screen names it: the host (with its
 * port) of an http(s) URI, the scheme of an application URI.
 */
export function redirectDestination(uri: string): { kind: RedirectKind; label: string } | null {
  const check = checkRedirectUri(uri);
  if (!check.ok) return null;
  return {
    kind: check.kind,
    label: check.kind === 'app-scheme' ? `${check.url.protocol}//` : check.url.host,
  };
}
