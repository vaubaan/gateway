/**
 * The closed search grammar of `outlook__search_messages`.
 */
import { describe, expect, test } from 'vitest';

import { MAX_QUERY_TERMS, parseQuery } from '../../src/q-parser.ts';

function parsed(q: string) {
  const out = parseQuery(q);
  if ('denied' in out) throw new Error(out.denied);
  return out.query;
}

describe('parseQuery', () => {
  test('every term of the grammar', () => {
    expect(
      parsed(
        'from:Bob@Contoso.example to:carol@customer.example subject:invoice is:unread has:attachment after:2026-10-01 before:2026-11-01 Q4 rapport',
      ),
    ).toEqual({
      from: ['bob@contoso.example'],
      to: ['carol@customer.example'],
      subjects: ['invoice'],
      unread: true,
      hasAttachment: true,
      after: '2026-10-01',
      before: '2026-11-01',
      words: ['Q4', 'rapport'],
    });
  });

  test('empty: no term', () => {
    expect(parsed('   ')).toMatchObject({ from: [], words: [], unread: false });
  });

  test('operator keys are case-insensitive, repeated addresses counted once', () => {
    expect(parsed('FROM:a@x.example from:A@x.example IS:Unread').from).toEqual(['a@x.example']);
  });

  test('accented words, apostrophes and addresses as free words', () => {
    expect(parsed("réunion l'équipe bob@x.example").words).toEqual([
      'réunion',
      "l'équipe",
      'bob@x.example',
    ]);
  });

  test.each([
    ['OR', 'a OR b'],
    ['and', 'a and b'],
    ['negation', '-budget'],
    ['quote', '"a b"'],
    ['parenthesis', '(a)'],
    ['wildcard', 'bud*'],
    ['unknown operator', 'category:red'],
    ['a from: that is not one address', 'from:bob'],
    ['two after:', 'after:2026-01-01 after:2026-02-01'],
    ['before not after after', 'after:2026-02-01 before:2026-01-01'],
    ['a bad date', 'before:2026-02-30x'],
    ['a backslash', 'a\\b'],
    ['a colon in a word', 'http://x'],
  ])('refuses %s', (_label, q) => {
    expect('denied' in parseQuery(q)).toBe(true);
  });

  test('bounded length and term count', () => {
    expect('denied' in parseQuery('a'.repeat(501))).toBe(true);
    expect(
      'denied' in parseQuery(Array.from({ length: MAX_QUERY_TERMS + 1 }, () => 'a').join(' ')),
    ).toBe(true);
    expect('denied' in parseQuery(7)).toBe(true);
  });
});
