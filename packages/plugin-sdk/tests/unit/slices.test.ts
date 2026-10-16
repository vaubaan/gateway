import { describe, expect, test } from 'vitest';

import { parseSlice, serializeSlice } from '@vaubaan/policy-engine';
import type { Slice } from '@vaubaan/shared';

import { ANY_IDENT, identSegment, isSliceIdent, sliceRoundTripIssues } from '../../src/slices.ts';

const sliceWith = (value: string): Slice => ({
  provider: 'acme',
  action: 'W',
  path: [{ kind: 'name', value: 'user' }, identSegment(value)],
});

describe('identSegment — what a classifier may write into a slice', () => {
  test.each(['main', 'feature/x', 'owner/repo', 'a.ts', 'v1~2', 'A_b-9', 'a..b/..c'])(
    'an identifier of grammar characters is written as given: %s',
    (value) => {
      expect(isSliceIdent(value)).toBe(true);
      expect(identSegment(value)).toEqual({ kind: 'ident', value });
      expect(sliceRoundTripIssues(sliceWith(value))).toEqual([]);
    },
  );

  test.each([
    ['an e-mail address', 'a@b.co'],
    ['a plus tag', 'a+b'],
    ['a colon', 'STRIPE:KEY'],
    ['a space', 'my key'],
    ['a comma, which would read back as a list', 'a,b'],
    ['a closing bracket, which would end the segment', 'a].x[b'],
    ['a glob', 'feature/*'],
    ['a lone star', '*'],
    ['a newline', 'a\nb'],
    ['a non-ASCII letter', 'é'],
    ['an empty value', ''],
  ])('%s is written as "any identifier"', (_label, value) => {
    expect(isSliceIdent(value)).toBe(false);
    expect(identSegment(value)).toBe(ANY_IDENT);
    const slice = sliceWith(value);
    expect(serializeSlice(slice)).toBe('acme.user[*].W');
    expect(sliceRoundTripIssues(slice)).toEqual([]);
  });
});

describe('sliceRoundTripIssues — a slice is written, so it must read back as itself', () => {
  const raw = (value: string): Slice => ({
    provider: 'acme',
    action: 'W',
    path: [
      { kind: 'name', value: 'user' },
      { kind: 'ident', value },
    ],
  });

  test('an identifier outside the grammar cannot be read back', () => {
    expect(sliceRoundTripIssues(raw('a@b.co'))).toEqual([
      "'acme.user[a@b.co].W' cannot be read back: an identifier holds a character outside the slice grammar",
    ]);
    expect(() => parseSlice(serializeSlice(raw('a@b.co')))).toThrow();
  });

  test('an identifier that reads back as something else is reported with both forms', () => {
    // A comma inside one identifier is a list of two once written.
    expect(serializeSlice(parseSlice(serializeSlice(raw('a, b'))))).toBe('acme.user[a,b].W');
    expect(sliceRoundTripIssues(raw('a, b'))).toEqual([
      "'acme.user[a, b].W' reads back as 'acme.user[a,b].W'",
    ]);
  });

  test('wildcard segments and the placeholder read back as themselves', () => {
    for (const text of ['acme.user[*].W', 'acme.user[**].R', 'acme.account.R', 'acme.a[x,y].W']) {
      expect(sliceRoundTripIssues(parseSlice(text)), text).toEqual([]);
    }
    expect(sliceRoundTripIssues(raw('*'))).toEqual([]);
  });
});
