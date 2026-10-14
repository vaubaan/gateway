import { describe, expect, test } from 'vitest';

import { parseSlice } from '../../src/slice-dsl.ts';
import { covers, intersects, matches } from '../../src/slice-matcher.ts';

const p = parseSlice;

describe('matches — concrete slice against a pattern', () => {
  test('exact same path', () => {
    expect(
      matches(p('github.repo[foo/bar].branch[main].W'), p('github.repo[foo/bar].branch[main].W')),
    ).toBe(true);
  });

  test('different provider does not match', () => {
    expect(matches(p('github.repo[foo].W'), p('vercel.repo[foo].W'))).toBe(false);
  });

  test('different action does not match', () => {
    expect(matches(p('github.repo[foo].R'), p('github.repo[foo].W'))).toBe(false);
  });

  test('wild-one matches a concrete ident', () => {
    expect(
      matches(p('github.repo[*].branch[main].W'), p('github.repo[foo/bar].branch[main].W')),
    ).toBe(true);
  });

  test('wild-rec matches zero segments', () => {
    expect(matches(p('github.repo[**].W'), p('github.repo.W'))).toBe(true);
  });

  test('wild-rec matches multiple segments', () => {
    expect(matches(p('github.**.W'), p('github.repo[foo].branch[main].file[a/b/c].W'))).toBe(true);
  });

  test('glob inside ident', () => {
    expect(
      matches(p('vercel.env-var[NEXT_PUBLIC_*].W'), p('vercel.env-var[NEXT_PUBLIC_API_URL].W')),
    ).toBe(true);
    expect(matches(p('vercel.env-var[NEXT_PUBLIC_*].W'), p('vercel.env-var[STRIPE_KEY].W'))).toBe(
      false,
    );
  });

  test('list matches concrete ident in list', () => {
    expect(matches(p('github.branch[main,develop].W'), p('github.branch[main].W'))).toBe(true);
    expect(matches(p('github.branch[main,develop].W'), p('github.branch[other].W'))).toBe(false);
  });

  test('glob covers the dotted and tilde identifiers the parser accepts (release-* vs release-1.2)', () => {
    expect(matches(p('github.branch[release-*].W'), p('github.branch[release-1.2].W'))).toBe(true);
    expect(matches(p('github.file[*].W'), p('github.file[a.ts].W'))).toBe(true);
    expect(matches(p('github.ref[v1~*].R'), p('github.ref[v1~2].R'))).toBe(true);
    expect(matches(p('github.branch[release-*].W'), p('github.branch[main].W'))).toBe(false);
  });

  test('feature/* glob matches feature/auth-bug', () => {
    expect(
      matches(
        p('github.repo.branch[feature/*].file[**].W'),
        p('github.repo.branch[feature/auth-bug].file[src/x.ts].W'),
      ),
    ).toBe(true);
  });

  test('different name segment does not match', () => {
    expect(matches(p('github.repo.branch.W'), p('github.repo.commit.W'))).toBe(false);
  });
});

describe('covers — pattern partial order', () => {
  test('a pattern covers itself', () => {
    const x = p('github.repo[foo].branch[main].W');
    expect(covers(x, x)).toBe(true);
  });

  test('wild covers specific', () => {
    expect(covers(p('github.repo[*].W'), p('github.repo[foo].W'))).toBe(true);
  });

  test('specific does not cover wild', () => {
    expect(covers(p('github.repo[foo].W'), p('github.repo[*].W'))).toBe(false);
  });

  test('** covers everything below', () => {
    expect(covers(p('github.**.W'), p('github.repo[foo].branch[main].file[a].W'))).toBe(true);
  });

  test('list covers each member', () => {
    expect(covers(p('github.branch[main,develop].W'), p('github.branch[main].W'))).toBe(true);
    expect(covers(p('github.branch[main,develop].W'), p('github.branch[develop].W'))).toBe(true);
    expect(covers(p('github.branch[main,develop].W'), p('github.branch[other].W'))).toBe(false);
  });

  test('a glob covers itself and a narrower glob, not a wider one', () => {
    expect(covers(p('k.b[a*].W'), p('k.b[a*].W'))).toBe(true);
    expect(covers(p('k.b[a*].W'), p('k.b[ab*].W'))).toBe(true);
    expect(covers(p('k.b[ab*].W'), p('k.b[a*].W'))).toBe(false);
    expect(covers(p('k.b[x,a].W'), p('k.b[*,a].W'))).toBe(false);
    expect(covers(p('k.b[*].W'), p('k.b[a*,b*].W'))).toBe(true);
  });

  test('glob covers its concrete matches', () => {
    expect(
      covers(p('vercel.env-var[NEXT_PUBLIC_*].W'), p('vercel.env-var[NEXT_PUBLIC_URL].W')),
    ).toBe(true);
    expect(covers(p('vercel.env-var[NEXT_PUBLIC_*].W'), p('vercel.env-var[SECRET].W'))).toBe(false);
  });
});

describe('intersects — symmetric overlap', () => {
  test('two wilds intersect', () => {
    expect(intersects(p('github.repo[*].W'), p('github.repo[*].W'))).toBe(true);
  });

  test('disjoint lists do not intersect', () => {
    expect(intersects(p('github.branch[main,develop].W'), p('github.branch[other,foo].W'))).toBe(
      false,
    );
  });

  test('overlapping lists intersect', () => {
    expect(intersects(p('github.branch[main,develop].W'), p('github.branch[develop,prod].W'))).toBe(
      true,
    );
  });

  test('glob and concrete in same namespace intersect when match', () => {
    expect(
      intersects(p('vercel.env-var[NEXT_PUBLIC_*].W'), p('vercel.env-var[NEXT_PUBLIC_API].W')),
    ).toBe(true);
    expect(intersects(p('vercel.env-var[NEXT_PUBLIC_*].W'), p('vercel.env-var[SECRET].W'))).toBe(
      false,
    );
  });

  test('glob × glob is exact for single-star globs and fails closed beyond', () => {
    expect(intersects(p('k.b[a*].W'), p('k.b[*b].W'))).toBe(true);
    expect(intersects(p('k.b[a*].W'), p('k.b[b*].W'))).toBe(false);
    expect(intersects(p('k.b[a*b].W'), p('k.b[ab*c].W'))).toBe(false);
    expect(intersects(p('k.b[ab*c].W'), p('k.b[a*bc].W'))).toBe(true);
    expect(intersects(p('k.b[a*b*].W'), p('k.b[*c*].W'))).toBe(true);
  });

  test('different actions never intersect', () => {
    expect(intersects(p('github.repo[*].R'), p('github.repo[*].W'))).toBe(false);
  });

  test('different providers never intersect', () => {
    expect(intersects(p('github.repo[*].W'), p('vercel.project[*].W'))).toBe(false);
  });

  test('** intersects with anything in the same provider/action', () => {
    expect(intersects(p('github.**.W'), p('github.repo[foo].branch[main].W'))).toBe(true);
    expect(intersects(p('github.**.W'), p('github.W'))).toBe(true);
  });
});

describe('canonical catalog overlap scenarios', () => {
  test('catalog "merge-protected" matches a concrete merge to main', () => {
    const pattern = p('github.repo[**].branch[main,master,prod].W');
    const exec = p('github.repo[sbw-vaubaan/gateway].branch[main].W');
    expect(matches(pattern, exec)).toBe(true);
  });

  test('catalog "branch-protection-write" does not match a code write', () => {
    const pattern = p('github.repo[**].branch-protection[**].W');
    const exec = p('github.repo[sbw-vaubaan/gateway].branch[main].file[README.md].W');
    expect(matches(pattern, exec)).toBe(false);
  });

  test('catalog "policy.W" matches RLS write across all projects', () => {
    const pattern = p('supabase.project[**].policy[**].W');
    const exec = p('supabase.project[tlqgxnezmthbpzhdwxgi].policy[users_select].W');
    expect(matches(pattern, exec)).toBe(true);
  });
});

describe('matches — a glob in a bracket cannot stall the instance', () => {
  // Found by Semgrep (detect-non-literal-regexp): `*` used to become a
  // backtracking regex, and `a*a*a*a*a*a*!` against a 200-character branch
  // never answered. A policy can come through the management door.
  const branch = (glob: string): ReturnType<typeof p> => p(`github.repo[x].branch[${glob}].W`);

  test('many stars against a long value answer at once, with the same reading', () => {
    const value = 'a'.repeat(240);
    const started = performance.now();
    expect(matches(branch(`${'a*'.repeat(40)}b`), branch(value))).toBe(false);
    expect(matches(branch('a*'.repeat(40)), branch(value))).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test.each([
    ['release-*', 'release-1.2', true],
    ['release-*', 'release-', false],
    ['a**', 'ab', false],
    ['a**', 'abc', true],
    ['feature/*', 'feature/x/y', true],
  ])('[%s] against [%s] is %s', (glob, value, expected) => {
    expect(matches(branch(glob), branch(value))).toBe(expected);
  });
});
