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
 * matches `[a-zA-Z0-9_/-]+`.
 *
 * Provider and action are matched by exact string equality (no wildcard on
 * those — a different provider or a different action is never the same
 * risk).
 */

import type { Slice, SliceSegment } from '@vaubaan/shared';

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

/** Glob matching inside a bracket : `*` matches `[a-zA-Z0-9_/-]+`. */
function identGlobMatches(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return pattern === value;
  // Build a regex : `*` → `[a-zA-Z0-9_/-]+`. Escape regex metas (none in
  // our ident charset, but defensive).
  const re = new RegExp(
    '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-zA-Z0-9_/-]+') + '$',
  );
  return re.test(value);
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
        if (pb.kind === 'ident') return identGlobMatches(pa.value, pb.value);
        if (pb.kind === 'list') return pb.values.every((v) => identGlobMatches(pa.value, v));
        return false;
      }
      // exact
      if (pb.kind === 'ident') return pb.value === pa.value;
      if (pb.kind === 'list') return pb.values.length === 1 && pb.values[0] === pa.value;
      return false;
    case 'list':
      if (pb.kind === 'ident') return pa.values.some((v) => identGlobMatches(v, pb.value));
      if (pb.kind === 'list') {
        return pb.values.every((bv) =>
          pa.values.some((av) => identGlobMatches(av, expandGlob(bv))),
        );
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
  if (pa.kind === 'ident' && pb.kind === 'ident') {
    if (pa.value === '*' || pb.value === '*') return true;
    if (pa.value.includes('*') && pb.value.includes('*')) {
      // Two globs — non-trivial. We check if the intersection of their
      // languages is non-empty via a conservative heuristic : try plugging
      // each glob's literal prefix into the other.
      return (
        identGlobMatches(pa.value, expandGlob(pb.value)) ||
        identGlobMatches(pb.value, expandGlob(pa.value))
      );
    }
    if (pa.value.includes('*')) return identGlobMatches(pa.value, pb.value);
    if (pb.value.includes('*')) return identGlobMatches(pb.value, pa.value);
    return pa.value === pb.value;
  }
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

/** Conservative glob × glob intersection : exact match, or one side is `*`,
 *  or one matches a sample expansion of the other. */
function globsIntersect(a: string, b: string): boolean {
  if (a === b) return true;
  if (a === '*' || b === '*') return true;
  if (a.includes('*') && b.includes('*')) {
    return identGlobMatches(a, expandGlob(b)) || identGlobMatches(b, expandGlob(a));
  }
  if (a.includes('*')) return identGlobMatches(a, b);
  if (b.includes('*')) return identGlobMatches(b, a);
  return false;
}

/** Produce one concrete value from a glob pattern by replacing `*` with a
 *  representative sample. Used as a heuristic in intersect-glob-glob.
 *  Not exposed — internal. */
function expandGlob(pattern: string): string {
  return pattern.replace(/\*/g, 'x');
}
