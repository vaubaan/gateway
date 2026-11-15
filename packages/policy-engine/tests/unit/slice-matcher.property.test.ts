/**
 * Properties of the slice matcher (risk model §3.3) over every small pattern a
 * catalog could write: the claims the handbook makes, checked on generated
 * slices rather than on examples.
 *
 * Seeded and replayable: FC_SEED, FC_RUNS.
 */
import type { Slice, SliceSegment } from '@vaubaan/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { covers, intersects, matches } from '../../src/slice-matcher.ts';

const RUNS = {
  seed: Number(process.env.FC_SEED ?? 20_261_031),
  numRuns: Number(process.env.FC_RUNS ?? 300),
};

/** A small alphabet, so that generated slices meet each other often. */
const value = fc.constantFrom('a', 'b', 'ab', 'ba');
const concreteSegment: fc.Arbitrary<SliceSegment> = fc.oneof(
  value.map((v) => ({ kind: 'name' as const, value: v })),
  value.map((v) => ({ kind: 'ident' as const, value: v })),
);
const patternSegment: fc.Arbitrary<SliceSegment> = fc.oneof(
  concreteSegment,
  fc.constantFrom('a*', '*b', '*').map((v) => ({ kind: 'ident' as const, value: v })),
  fc
    .uniqueArray(value, { minLength: 1, maxLength: 3 })
    .map((values) => ({ kind: 'list' as const, values })),
  fc.constant({ kind: 'wild-one' as const }),
  fc.constant({ kind: 'wild-rec' as const }),
);

function slice(segment: fc.Arbitrary<SliceSegment>): fc.Arbitrary<Slice> {
  return fc.record({
    service: fc.constant('gh'),
    path: fc.array(segment, { maxLength: 4 }),
    action: fc.constantFrom('R' as const, 'W' as const),
  });
}

const pattern = slice(patternSegment);
const concrete = slice(concreteSegment);

describe('slice matcher properties', () => {
  it('intersects is symmetric', () => {
    fc.assert(
      fc.property(pattern, pattern, (a, b) => intersects(a, b) === intersects(b, a)),
      RUNS,
    );
  });

  it('a pattern covers itself, and intersects itself', () => {
    fc.assert(
      fc.property(pattern, (a) => covers(a, a) && intersects(a, a)),
      RUNS,
    );
  });

  it('a concrete slice a pattern matches intersects it', () => {
    fc.assert(
      fc.property(pattern, concrete, (p, c) => !matches(p, c) || intersects(p, c)),
      RUNS,
    );
  });

  it('a pattern that covers another intersects it', () => {
    fc.assert(
      fc.property(pattern, pattern, (a, b) => !covers(a, b) || intersects(a, b)),
      RUNS,
    );
  });

  it('what a covered pattern matches, the covering one matches too', () => {
    fc.assert(
      fc.property(pattern, pattern, concrete, (a, b, c) => {
        if (!covers(a, b) || !matches(b, c)) return true;
        return matches(a, c);
      }),
      RUNS,
    );
  });

  it('never matches across services or actions', () => {
    fc.assert(
      fc.property(pattern, concrete, (p, c) => {
        const other: Slice = { ...c, action: c.action === 'R' ? 'W' : 'R' };
        expect(matches(p, other) && matches(p, c)).toBe(false);
        expect(intersects(p, { ...p, service: 'other' })).toBe(false);
      }),
      RUNS,
    );
  });
});
