/**
 * Origin check for every mutation made with a web session (spec §6 "every
 * mutation requires a valid session and an origin check").
 *
 * The browser sends `Origin` on every cross-origin request and on same-origin
 * POSTs; `Referer` is the fallback for the rare same-origin form post without
 * it. A request with neither header is refused: a mutation never passes on a
 * missing header. The expected origin is the configured `public_url`, never
 * the host the process sees behind the TLS terminator.
 */

export function requestOrigin(headers: Headers): string | null {
  const origin = headers.get('origin');
  if (origin && origin !== 'null') return origin;
  const referer = headers.get('referer');
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

export function isSameOrigin(headers: Headers, publicUrl: URL): boolean {
  return requestOrigin(headers) === publicUrl.origin;
}

export function forbiddenOriginResponse(): Response {
  return new Response(
    JSON.stringify({ error: 'origin-mismatch', message: 'cross-origin mutation refused' }),
    { status: 403, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  );
}
