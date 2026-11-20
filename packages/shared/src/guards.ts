/**
 * The one test of "a JSON object", for every value read from outside (a request body, a
 * stored JSON column, a feed, a plugin's export): an object that is neither `null` nor an
 * array. The plugin SDK re-exports it.
 */
export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
