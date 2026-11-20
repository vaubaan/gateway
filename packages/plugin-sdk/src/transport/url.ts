/**
 * The two pieces of a service URL a plugin builds from an agent's arguments: an
 * identifier placed in the path, and the query string.
 *
 * ADR plugin-identifiers-one-grammar-for-classify-and-execute: an identifier the
 * classifier read is the one sent, so a value that could leave its path segment (a
 * `/`, a `..`, a `?`) is refused, never encoded into something else.
 */

/** An identifier a path segment carries as it is: letters, digits, `_` and `-`, 1 to 64. */
export const PATH_IDENT = /^[A-Za-z0-9_-]{1,64}$/;

/** `value` when it is a string {@link PATH_IDENT} accepts, else `null`. */
export function pathIdent(value: unknown): string | null {
  return typeof value === 'string' && PATH_IDENT.test(value) ? value : null;
}

/**
 * `?name=value&…` for the entries of `query` that are neither `undefined` nor `null`, each
 * name and value percent-encoded (a space is `%20`); `''` when none is left.
 */
export function queryString(query: Readonly<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}
