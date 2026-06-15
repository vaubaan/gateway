import { describe, expect, test } from 'vitest';

import { parseSlice, serializeSlice, SliceParseError } from '../../src/slice-dsl.ts';

describe('parseSlice — happy paths', () => {
  test('simple name segments + R action', () => {
    const s = parseSlice('github.repo.code.R');
    expect(s).toEqual({
      provider: 'github',
      path: [
        { kind: 'name', value: 'repo' },
        { kind: 'name', value: 'code' },
      ],
      action: 'R',
    });
  });

  test('bracketed ident segment', () => {
    const s = parseSlice('github.repo[sbw-vaubaan/gateway].branch[main].W');
    expect(s).toEqual({
      provider: 'github',
      path: [
        { kind: 'name', value: 'repo' },
        { kind: 'ident', value: 'sbw-vaubaan/gateway' },
        { kind: 'name', value: 'branch' },
        { kind: 'ident', value: 'main' },
      ],
      action: 'W',
    });
  });

  test('list segment after a name', () => {
    const s = parseSlice('github.repo.branch[main,develop,prod].W');
    // path = ['repo' name, 'branch' name, [list]]
    expect(s.path[2]).toEqual({ kind: 'list', values: ['main', 'develop', 'prod'] });
  });

  test('wild-one [*]', () => {
    const s = parseSlice('vercel.project[*].env.deployment.W');
    // path = ['project' name, [*], 'env' name, 'deployment' name]
    expect(s.path[0]).toEqual({ kind: 'name', value: 'project' });
    expect(s.path[1]).toEqual({ kind: 'wild-one' });
  });

  test('wild-rec [**]', () => {
    const s = parseSlice('github.repo[**].W');
    expect(s.path[1]).toEqual({ kind: 'wild-rec' });
  });

  test('glob inside bracket', () => {
    const s = parseSlice('vercel.project.env-var[NEXT_PUBLIC_*].W');
    // path = ['project', 'env-var', [ident NEXT_PUBLIC_*]]
    expect(s.path[2]).toEqual({ kind: 'ident', value: 'NEXT_PUBLIC_*' });
  });

  test('feature/* glob (slashes in glob ident)', () => {
    const s = parseSlice('github.repo.branch[feature/*].file[**].W');
    // path = ['repo', 'branch', [feature/*], 'file', [**]]
    expect(s.path[2]).toEqual({ kind: 'ident', value: 'feature/*' });
    expect(s.path[4]).toEqual({ kind: 'wild-rec' });
  });

  test('catalog fallback pattern with bare **', () => {
    const s = parseSlice('github.**.W');
    expect(s.path).toEqual([{ kind: 'wild-rec' }]);
  });

  test('degenerate slice — provider + action only is accepted', () => {
    // Edge case for fallbacks like 'github.R' — the parser accepts it,
    // path is empty.
    const s = parseSlice('github.R');
    expect(s).toEqual({ provider: 'github', path: [], action: 'R' });
  });
});

describe('parseSlice — error cases', () => {
  test('missing provider', () => {
    expect(() => parseSlice('.repo.W')).toThrow(SliceParseError);
  });

  test('missing action', () => {
    expect(() => parseSlice('github.repo.branch')).toThrow(SliceParseError);
  });

  test('invalid action', () => {
    expect(() => parseSlice('github.repo.X')).toThrow(SliceParseError);
  });

  test('unterminated bracket', () => {
    expect(() => parseSlice('github.repo[main.W')).toThrow(SliceParseError);
  });

  test('empty bracket', () => {
    expect(() => parseSlice('github.repo[].W')).toThrow(SliceParseError);
  });

  test('double dot', () => {
    expect(() => parseSlice('github.repo..branch.W')).toThrow(SliceParseError);
  });

  test('provider with /', () => {
    expect(() => parseSlice('git/hub.repo.W')).toThrow(SliceParseError);
  });

  test('list with empty entry', () => {
    expect(() => parseSlice('github.branch[main,,develop].W')).toThrow(SliceParseError);
  });

  test('list with glob inside is ACCEPTED (used in catalogs like [feature/*,fix/*])', () => {
    const s = parseSlice('github.branch[main,feat*].W');
    expect(s.path[1]).toEqual({ kind: 'list', values: ['main', 'feat*'] });
  });
});

describe('serializeSlice', () => {
  test('roundtrip simple', () => {
    const input = 'github.repo.branch[main].W';
    expect(serializeSlice(parseSlice(input))).toBe(input);
  });

  test('roundtrip with glob', () => {
    const input = 'vercel.project[*].env-var[NEXT_PUBLIC_*].W';
    expect(serializeSlice(parseSlice(input))).toBe(input);
  });

  test('roundtrip with list', () => {
    const input = 'github.repo.branch[main,develop].W';
    expect(serializeSlice(parseSlice(input))).toBe(input);
  });

  test('roundtrip with wild-rec', () => {
    const input = 'github.repo[**].W';
    expect(serializeSlice(parseSlice(input))).toBe(input);
  });

  test('roundtrip canonical examples from spec', () => {
    const examples = [
      'github.repo[sbw-vaubaan/gateway].branch[main].W',
      'github.repo[sbw-vaubaan/gateway].branch[feature/auth-bug].file[src/auth.ts].W',
      'supabase.project[tlqgxnezmthbpzhdwxgi].schema[public].table[users].row[*].R',
      'vercel.project[gateway].env[prod].deployment[*].W',
      'vercel.project[gateway].env[preview,development].env-var[NEXT_PUBLIC_*].W',
    ];
    for (const ex of examples) {
      expect(serializeSlice(parseSlice(ex))).toBe(ex);
    }
  });
});
