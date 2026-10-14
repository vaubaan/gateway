import { describe, expect, it } from 'vitest';
import {
  matchWildcard,
  wildcardLiteral,
  WILDCARD_ANY,
  WILDCARD_ONE,
  type WildcardToken,
} from './wildcard.ts';

/** `*` any, `?` one, anything else literal: the shell's reading, for the tests. */
function glob(source: string): WildcardToken[] {
  return [...source].flatMap((ch) =>
    ch === '*' ? [WILDCARD_ANY] : ch === '?' ? [WILDCARD_ONE] : wildcardLiteral(ch),
  );
}

/** The same glob as an anchored regex: the reference the matcher must agree with. */
function reference(source: string): RegExp {
  const body = [...source]
    .map((ch) =>
      ch === '*' ? '[^]*' : ch === '?' ? '[^]' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('');
  return new RegExp(`^${body}$`);
}

describe('matchWildcard', () => {
  it.each([
    ['id_rsa', 'id_rsa', true],
    ['id_*', 'id_ed25519', true],
    ['*.pem', 'server.pem', true],
    ['*.pem', 'server.pem.bak', false],
    ['?', '', false],
    ['?', 'a', true],
    ['*', '', true],
    ['', '', true],
    ['', 'a', false],
    ['a*b*c', 'abc', true],
    ['a*b*c', 'aXbYc', true],
    ['a*b*c', 'acb', false],
    ['**', 'anything', true],
    ['*?*', '', false],
    ['*a', 'bbbba', true],
    ['a*', 'ba', false],
  ])('%j against %j is %s', (pattern, text, expected) => {
    expect(matchWildcard(glob(pattern), text)).toBe(expected);
    expect(reference(pattern).test(text)).toBe(expected);
  });

  it('agrees with the regex reading on every short pattern over a two-letter alphabet', () => {
    const alphabet = ['a', 'b', '*', '?'];
    const words = (length: number, letters: readonly string[]): string[] =>
      length === 0 ? [''] : words(length - 1, letters).flatMap((w) => letters.map((l) => w + l));
    const patterns = [0, 1, 2, 3, 4].flatMap((n) => words(n, alphabet));
    const texts = [0, 1, 2, 3, 4].flatMap((n) => words(n, ['a', 'b']));
    for (const pattern of patterns) {
      const re = reference(pattern);
      for (const text of texts) {
        expect(matchWildcard(glob(pattern), text), `${pattern} ~ ${text}`).toBe(re.test(text));
      }
    }
  });

  it('answers in linear time where a backtracking regex takes seconds', () => {
    // `^.*.*…z$` with 22 stars took 48 s against `id_ed25519_sk` as a regex.
    const started = performance.now();
    expect(matchWildcard(glob(`${'*'.repeat(5000)}z`), 'id_ed25519_sk'.repeat(100))).toBe(false);
    expect(matchWildcard(glob(`${'a*'.repeat(2000)}!`), 'a'.repeat(5000))).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
