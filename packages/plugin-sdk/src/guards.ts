/**
 * The two type guards every reader of untyped input needs (a parsed YAML
 * document, a definition from untyped code, a service's answer).
 */

/** A plain object : not `null`, not an array (`@vaubaan/shared`'s, the one definition). */
export { isRecord } from '@vaubaan/shared';

/** `Array.isArray` narrows `unknown` to `any[]` ; this guard keeps the elements `unknown`. */
export function isList(x: unknown): x is readonly unknown[] {
  return Array.isArray(x);
}
