import { describe, expect, it } from 'vitest';

import { parseTokenName, TOKEN_NAME_MAX_LENGTH, TOKEN_NAME_RULE } from './token-name';

describe('the name of a named token', () => {
  it.each([
    ['CI runner', 'CI runner'],
    ['  CI   runner  ', 'CI runner'],
    ['build-box_2.eu', 'build-box_2.eu'],
    ['7', '7'],
    ['a'.repeat(TOKEN_NAME_MAX_LENGTH), 'a'.repeat(TOKEN_NAME_MAX_LENGTH)],
  ])('takes %j as %j', (raw, value) => {
    expect(parseTokenName(raw)).toEqual({ ok: true, value });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['a'.repeat(TOKEN_NAME_MAX_LENGTH + 1), 'too long'],
    ['-runner', 'starts with punctuation'],
    [' .hidden', 'starts with a dot once trimmed'],
    ['bob@acme.example', 'looks like a member’s email'],
    ['ci/runner', 'a slash'],
    ['ci:runner', 'a colon: the separator of a holder in a link'],
    ['runner\nadmin', 'a line break'],
    ['runner\t1', 'a tab'],
    ['<b>runner</b>', 'markup'],
    ['rünner', 'outside ASCII'],
  ])('refuses %j (%s)', (raw) => {
    const parsed = parseTokenName(raw);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problem).toContain(TOKEN_NAME_RULE);
  });

  it.each([undefined, null, 7, {}, ['CI runner']])('refuses %j: a name is text', (raw) => {
    expect(parseTokenName(raw)).toMatchObject({ ok: false });
  });

  it('never yields a name with an "@": a holder shown with one is always a member’s email', () => {
    for (const raw of ['a@b', '@', 'ci @ acme', 'x'.repeat(10) + '@']) {
      expect(parseTokenName(raw).ok).toBe(false);
    }
  });
});
