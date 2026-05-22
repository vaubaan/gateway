/**
 * 7 constraint operators.
 *
 * Spec : docs/spec/mcp-proxy.md §6.5.
 *
 * Semantics :
 *   - All string-coerce before comparison (except `regex`, which expects string).
 *   - `undefined` values fail every op EXCEPT `not_in` / `not_starts_with`
 *     where they match `true` (the "not present" sets are vacuously not-in).
 */

import { minimatch } from 'minimatch';
import type { Constraint } from '@vauban/shared';

export function evaluateConstraint(c: Constraint, value: unknown): boolean {
  if ('equals' in c) {
    if (value === undefined) return false;
    return String(value) === String(c.equals);
  }
  if ('in' in c) {
    if (value === undefined) return false;
    return c.in.map(String).includes(String(value));
  }
  if ('not_in' in c) {
    if (value === undefined) return true;
    return !c.not_in.map(String).includes(String(value));
  }
  if ('match' in c) {
    if (value === undefined) return false;
    const s = String(value);
    return c.match.some((p) => minimatch(s, p));
  }
  if ('regex' in c) {
    if (value === undefined) return false;
    try {
      return new RegExp(c.regex).test(String(value));
    } catch {
      return false;
    }
  }
  if ('starts_with' in c) {
    if (value === undefined) return false;
    const s = String(value);
    const prefixes = Array.isArray(c.starts_with) ? c.starts_with : [c.starts_with];
    return prefixes.some((p) => s.startsWith(p));
  }
  if ('not_starts_with' in c) {
    if (value === undefined) return true;
    const s = String(value);
    const prefixes = Array.isArray(c.not_starts_with) ? c.not_starts_with : [c.not_starts_with];
    return !prefixes.some((p) => s.startsWith(p));
  }
  return false;
}

/**
 * Walk a dot-path (`arguments.branch`, `arguments.head`) into a nested object.
 * The first path segment `arguments` is a convention — the engine passes
 * `{ arguments: <args> }` as the root so the policy DSL is self-describing.
 */
export function readPath(root: unknown, path: string): unknown {
  const segments = path.split('.');
  let cur: unknown = root;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}
