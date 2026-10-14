/**
 * Slice matching — `matches`, `covers`, `intersects`.
 *
 * Spec : docs/spec/gateway-risk-model.md §3.3.
 *
 * Three closely related predicates :
 *
 *  - `matches(pattern, concrete)` :
 *      true iff `pattern` accepts the concrete slice (`concrete` has no
 *      wildcards). Used at runtime to check whether a catalog entry's
 *      `matches` pattern is touched by a `classify()` output.
 *
 *  - `covers(a, b)` :
 *      true iff every concrete slice matched by `b` is also matched by `a`.
 *      Used to compare catalog patterns to each other (rare ; for lints).
 *
 *  - `intersects(a, b)` :
 *      true iff there exists at least one concrete slice matched by both
 *      `a` and `b`. Used when both sides may contain wildcards (e.g. for
 *      "does this preset overlap a critical risk pattern").
 *
 * The matching is structural on the segment array. `[*]` matches any
 * single concrete segment ; `[**]` matches zero-or-more (recursive
 * wildcard like `**` in globs). Inside a bracket, the `*` glob character
 * matches one or more identifier characters (`BRACKET_IDENT_CHAR_CLASS`,
 * the class the parser accepts : a glob never covers less than an ident).
 *
 * Provider and action are matched by exact string equality (no wildcard on
 * those — a different provider or a different action is never the same
 * risk).
 */

import type { Slice, SliceSegment } from '@vaubaan/shared';
import {
  matchWildcard,
  wildcardLiteral,
  WILDCARD_ANY,
  WILDCARD_ONE,
  type WildcardToken,
} from '@vaubaan/shared/wildcard';

import { BRACKET_IDENT_CHAR_CLASS } from './slice-dsl.ts';

/** A value made of identifier characters only, the only ones a glob covers. */
const IDENT_VALUE = new RegExp(`^${BRACKET_IDENT_CHAR_CLASS}*$`);

/** True iff `pattern` accepts the concrete slice `concrete`.
 *  Assumes `concrete` has no wildcards on its path (no `wild-one`/`wild-rec`,
 *  no list, no glob `*` inside an `ident`). */
export function matches(pattern: Slice, concrete: Slice): boolean {
  if (pattern.provider !== concrete.provider) return false;
  if (pattern.action !== concrete.action) return false;
  return matchSegments(pattern.path, 0, concrete.path, 0);
}

/** True iff every concrete slice matched by `b` is also matched by `a`.
 *  This is the partial-order on patterns. `a.covers(b)` ⇒ `b` is a
 *  specialization of `a`. */
export function covers(a: Slice, b: Slice): boolean {
  if (a.provider !== b.provider) return false;
  if (a.action !== b.action) return false;
  return coversSegments(a.path, 0, b.path, 0);
}

/** True iff there exists at least one concrete slice matched by both `a`
 *  and `b`. Symmetric : `intersects(a, b) === intersects(b, a)`. */
export function intersects(a: Slice, b: Slice): boolean {
  if (a.provider !== b.provider) return false;
  if (a.action !== b.action) return false;
  return intersectSegments(a.path, 0, b.path, 0);
}

// ─── implementations ───────────────────────────────────────────────────────

function matchSegments(
  pattern: readonly SliceSegment[],
  pi: number,
  concrete: readonly SliceSegment[],
  ci: number,
): boolean {
  while (true) {
    if (pi === pattern.length) return ci === concrete.length;
    const p = pattern[pi]!;
    if (p.kind === 'wild-rec') {
      // Try every possible consumption count of concrete (0..rest).
      for (let take = 0; ci + take <= concrete.length; take++) {
        if (matchSegments(pattern, pi + 1, concrete, ci + take)) return true;
      }
      return false;
    }
    if (ci === concrete.length) return false;
    const c = concrete[ci]!;
    if (!matchOne(p, c)) return false;
    pi++;
    ci++;
  }
}

function matchOne(p: SliceSegment, c: SliceSegment): boolean {
  // `c` is concrete : only 'name' or 'ident' (no globs/wild/lists).
  if (c.kind === 'wild-one' || c.kind === 'wild-rec' || c.kind === 'list') return false;
  switch (p.kind) {
    case 'wild-one':
      // wild-one occupies an *identifier slot* — must not match a 'name'
      // segment (an entity-name slot). Preserves segment alternation.
      return c.kind !== 'name';
    case 'wild-rec':
      // Handled at the caller — should not reach here.
      return c.kind !== 'name';
    case 'name':
      return c.kind === 'name' && c.value === p.value;
    case 'ident':
      if (c.kind !== 'ident') return false;
      return identGlobMatches(p.value, c.value);
    case 'list':
      if (c.kind !== 'ident') return false;
      // Each list entry may be a glob (e.g. [feature/*, fix/*]).
      return p.values.some((v) => identGlobMatches(v, c.value));
  }
}

/** Glob matching inside a bracket : `*` matches one or more identifier
 *  characters (the parser's bracket class, so `release-*` accepts
 *  `release-1.2`). */
function identGlobMatches(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return pattern === value;
  // Never a regex built from the pattern: `a*a*a*…` backtracks exponentially
  // and a policy can come through the management door. Every character a
  // star may take is an identifier character, and so is every literal of the
  // pattern (the parser accepts nothing else): a value with any other
  // character cannot match, and past that check `*` is "one character, then
  // any number" (`matchWildcard` runs in linear time).
  if (!IDENT_VALUE.test(value)) return false;
  const tokens: WildcardToken[] = [...pattern].flatMap((ch) =>
    ch === '*' ? [WILDCARD_ONE, WILDCARD_ANY] : wildcardLiteral(ch),
  );
  return matchWildcard(tokens, value);
}

function coversSegments(
  a: readonly SliceSegment[],
  ai: number,
  b: readonly SliceSegment[],
  bi: number,
): boolean {
  while (true) {
    if (ai === a.length) return bi === b.length;
    const pa = a[ai]!;
    if (pa.kind === 'wild-rec') {
      // Try every consumption of b.
      for (let take = 0; bi + take <= b.length; take++) {
        if (coversSegments(a, ai + 1, b, bi + take)) return true;
      }
      return false;
    }
    if (bi === b.length) return false;
    const pb = b[bi]!;
    if (!coversOne(pa, pb)) return false;
    ai++;
    bi++;
  }
}

function coversOne(pa: SliceSegment, pb: SliceSegment): boolean {
  switch (pa.kind) {
    case 'wild-one':
      // `*` covers any single non-recursive *identifier* segment. A name
      // segment (entity slot) is NOT covered.
      return pb.kind !== 'wild-rec' && pb.kind !== 'name';
    case 'wild-rec':
      // Handled at caller.
      return true;
    case 'name':
      return pb.kind === 'name' && pb.value === pa.value;
    case 'ident':
      if (pa.value === '*') return pb.kind === 'ident' || pb.kind === 'list';
      if (pa.value.includes('*')) {
        if (pb.kind === 'ident') return globCovers(pa.value, pb.value);
        if (pb.kind === 'list') return pb.values.every((v) => globCovers(pa.value, v));
        return false;
      }
      // exact
      if (pb.kind === 'ident') return pb.value === pa.value;
      if (pb.kind === 'list') return pb.values.length === 1 && pb.values[0] === pa.value;
      return false;
    case 'list':
      if (pb.kind === 'ident') return pa.values.some((v) => globCovers(v, pb.value));
      if (pb.kind === 'list') {
        return pb.values.every((bv) => pa.values.some((av) => globCovers(av, bv)));
      }
      return false;
  }
}

function intersectSegments(
  a: readonly SliceSegment[],
  ai: number,
  b: readonly SliceSegment[],
  bi: number,
): boolean {
  while (true) {
    if (ai === a.length && bi === b.length) return true;
    if (ai === a.length || bi === b.length) {
      // One side ran out. The only way to still intersect is if the
      // remaining other side is all `wild-rec` (each matching zero).
      const rest = ai === a.length ? b.slice(bi) : a.slice(ai);
      return rest.every((s) => s.kind === 'wild-rec');
    }
    const pa = a[ai]!;
    const pb = b[bi]!;
    if (pa.kind === 'wild-rec') {
      // Try every consumption of b for the wild-rec, then advance.
      for (let take = 0; bi + take <= b.length; take++) {
        if (intersectSegments(a, ai + 1, b, bi + take)) return true;
      }
      return false;
    }
    if (pb.kind === 'wild-rec') {
      for (let take = 0; ai + take <= a.length; take++) {
        if (intersectSegments(a, ai + take, b, bi + 1)) return true;
      }
      return false;
    }
    if (!intersectOne(pa, pb)) return false;
    ai++;
    bi++;
  }
}

function intersectOne(pa: SliceSegment, pb: SliceSegment): boolean {
  // wild-one occupies an *identifier slot* (parsed from `[*]`). It must NOT
  // match a 'name' segment (an entity-name slot). Same for wild-rec, though
  // wild-rec is normally handled by the caller (intersectSegments).
  if (pa.kind === 'wild-one' || pa.kind === 'wild-rec') return pb.kind !== 'name';
  if (pb.kind === 'wild-one' || pb.kind === 'wild-rec') return pa.kind !== 'name';
  // After wild handled, pa/pb are name | ident | list.
  if (pa.kind === 'name') {
    return pb.kind === 'name' && pb.value === pa.value;
  }
  if (pb.kind === 'name') return false;
  // Both are ident or list.
  if (pa.kind === 'ident' && pb.kind === 'ident') return globsIntersect(pa.value, pb.value);
  if (pa.kind === 'list' && pb.kind === 'list') {
    return pa.values.some((av) => pb.values.some((bv) => globsIntersect(av, bv)));
  }
  if (pa.kind === 'list' && pb.kind === 'ident') {
    return pa.values.some((av) => globsIntersect(av, pb.value));
  }
  if (pa.kind === 'ident' && pb.kind === 'list') {
    return pb.values.some((bv) => globsIntersect(pa.value, bv));
  }
  return false;
}

/**
 * Glob × glob intersection. Exact for globs with at most one `*` each (the
 * catalog's `feature/*`, `NEXT_PUBLIC_*`, `release-*`) : two single-star
 * globs share a value iff one literal prefix extends the other and one
 * literal suffix extends the other (`<longer prefix>x<longer suffix>` is
 * then accepted by both). With several `*` on both sides the exact test is
 * not implemented and the function fails closed (`true`) : over-reporting
 * an intersection makes `risksTouchedBy` require more risks, never fewer.
 */
function globsIntersect(a: string, b: string): boolean {
  if (a === b) return true;
  if (a === '*' || b === '*') return true;
  const aGlob = a.includes('*');
  const bGlob = b.includes('*');
  if (aGlob && bGlob) {
    const sa = splitSingleStar(a);
    const sb = splitSingleStar(b);
    if (!sa || !sb) return true;
    return (
      (sa.prefix.startsWith(sb.prefix) || sb.prefix.startsWith(sa.prefix)) &&
      (sa.suffix.endsWith(sb.suffix) || sb.suffix.endsWith(sa.suffix))
    );
  }
  if (aGlob) return identGlobMatches(a, b);
  if (bGlob) return identGlobMatches(b, a);
  return false;
}

/**
 * Does glob `a` accept every value glob `b` accepts ? Exact for single-star
 * globs (`b`'s literal prefix extends `a`'s and its suffix extends `a`'s) ;
 * a multi-star `b` is covered only by an identical `a` or by `*`. A glob
 * covers itself.
 */
function globCovers(a: string, b: string): boolean {
  if (a === b || a === '*') return true;
  if (!b.includes('*')) return identGlobMatches(a, b);
  if (!a.includes('*')) return false;
  const sa = splitSingleStar(a);
  const sb = splitSingleStar(b);
  if (!sa || !sb) return false;
  return sb.prefix.startsWith(sa.prefix) && sb.suffix.endsWith(sa.suffix);
}

/** `prefix*suffix` of a glob with exactly one `*` ; `null` otherwise. */
function splitSingleStar(glob: string): { prefix: string; suffix: string } | null {
  const first = glob.indexOf('*');
  if (first < 0 || glob.indexOf('*', first + 1) >= 0) return null;
  return { prefix: glob.slice(0, first), suffix: glob.slice(first + 1) };
}
