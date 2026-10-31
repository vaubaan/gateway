/**
 * The two type guards every reader of untyped input needs (a parsed YAML
 * document, a definition from untyped code, a provider's answer).
 */

/** A plain object : not `null`, not an array. */
export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** `Array.isArray` narrows `unknown` to `any[]` ; this guard keeps the elements `unknown`. */
export function isList(x: unknown): x is readonly unknown[] {
  return Array.isArray(x);
}
