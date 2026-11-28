/**
 * The return address of a flow, limited to the instance (spec §6
 * "anti-redirect: return URL limited to the instance's public URL"). One
 * rule for every flow that redirects after an action — sign-in, connect,
 * service callback — so there is one place to get it right.
 */

/**
 * Characters a browser removes or rewrites before it parses a URL (tab, LF,
 * CR and the other C0 controls, DEL) and the backslash it reads as a slash.
 * `"/\t/evil.example"` starts with a single slash as a string and is
 * `//evil.example` to a browser, so such a value is refused outright rather
 * than normalised.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const REWRITTEN_BY_BROWSERS = /[\u0000-\u001f\u007f\\]/;

/**
 * Accepts a path or an absolute URL of the public origin and returns the
 * path (with query and fragment) to redirect to; anything else is refused
 * (`null`). Parsing is the WHATWG URL parser's, so scheme and authority
 * tricks are judged the way a browser would follow them, and the result is
 * checked once more: a path that itself starts with `//` (as
 * `/.//host/x` normalises to) would be another origin when used as a
 * `Location`.
 */
export function resolveReturnTo(raw: string | null | undefined, publicUrl: URL): string | null {
  if (!raw || REWRITTEN_BY_BROWSERS.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, publicUrl);
  } catch {
    // expected: a return_to that is not a URL is ignored
    return null;
  }
  if (url.origin !== publicUrl.origin) return null;
  const path = `${url.pathname}${url.search}${url.hash}`;
  return isLocalPath(path) ? path : null;
}

/** True for a path a browser resolves on the current origin: one leading slash, not two. */
export function isLocalPath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && !REWRITTEN_BY_BROWSERS.test(path);
}
