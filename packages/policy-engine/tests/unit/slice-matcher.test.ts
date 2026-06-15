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
