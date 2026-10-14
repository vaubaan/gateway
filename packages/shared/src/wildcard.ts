/**
 * Wildcard matching without a regular expression.
 *
 * A glob turned into a regex (`*` → `.*`) backtracks: `^.*.*.*…z$` against a
 * short name, or `^a[…]+a[…]+…$` against a long one, takes time exponential
 * in the number of stars, and the pattern often comes from an agent (an SSH
 * command line) or from a mission policy written through the management door.
 * One such call blocks the event loop of the whole instance. This matcher is
 * the classic two-pointer algorithm: it remembers only the last star, so it
 * runs in O(pattern × text) at worst and O(pattern + text) in practice.
 *
 * Characters are UTF-16 code units, as a regex without the `u` flag reads
 * them.
 */

/** One element of a pattern. */
export type WildcardToken =
  /** This exact character. */
  | { readonly kind: 'char'; readonly char: string }
  /** Exactly one character, any. */
  | { readonly kind: 'one' }
  /** Zero or more characters, any. */
  | { readonly kind: 'any' };

export const WILDCARD_ONE: WildcardToken = Object.freeze({ kind: 'one' });
export const WILDCARD_ANY: WildcardToken = Object.freeze({ kind: 'any' });

/** A token per character of `text`, matched literally. */
export function wildcardLiteral(text: string): WildcardToken[] {
  return Array.from({ length: text.length }, (_, i) => ({ kind: 'char', char: text[i]! }));
}

/** Whether `text`, as a whole, matches `pattern`. */
export function matchWildcard(pattern: readonly WildcardToken[], text: string): boolean {
  let p = 0;
  let t = 0;
  // Where the last star sits in the pattern, and how much of the text it has
  // taken so far; -1 while no star was met.
  let starAt = -1;
  let starTextAt = 0;
  while (t < text.length) {
    const token = pattern[p];
    if (
      token !== undefined &&
      (token.kind === 'one' || (token.kind === 'char' && token.char === text[t]))
    ) {
      p += 1;
      t += 1;
    } else if (token !== undefined && token.kind === 'any') {
      starAt = p;
      starTextAt = t;
      p += 1;
    } else if (starAt !== -1) {
      // Give the last star one more character and retry what follows it.
      p = starAt + 1;
      starTextAt += 1;
      t = starTextAt;
    } else {
      return false;
    }
  }
  while (pattern[p]?.kind === 'any') p += 1;
  return p === pattern.length;
}
