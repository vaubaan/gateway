import { describe, expect, it } from 'vitest';

import { checkInstanceName, INSTANCE_NAME_MAX_LENGTH } from './instance-name';

describe('checkInstanceName', () => {
  it('trims the spaces around the name', () => {
    expect(checkInstanceName('  Dalae prod \t')).toEqual({ ok: true, name: 'Dalae prod' });
  });

  it('refuses a name that is empty once trimmed', () => {
    expect(checkInstanceName('')).toEqual({ ok: false, problem: 'empty' });
    expect(checkInstanceName('   ')).toEqual({ ok: false, problem: 'empty' });
  });

  it('accepts 1 to 64 characters, counted as code points, not UTF-16 units', () => {
    expect(checkInstanceName('x')).toMatchObject({ ok: true });
    expect(checkInstanceName('x'.repeat(INSTANCE_NAME_MAX_LENGTH))).toMatchObject({ ok: true });
    expect(checkInstanceName('x'.repeat(INSTANCE_NAME_MAX_LENGTH + 1))).toEqual({
      ok: false,
      problem: 'too-long',
    });
    // 64 astral characters are 128 UTF-16 units, and still 64 characters.
    expect(checkInstanceName('🏭'.repeat(INSTANCE_NAME_MAX_LENGTH))).toMatchObject({ ok: true });
  });

  it.each([
    ['a newline', 'prod\nstaging'],
    ['a tab inside', 'prod\tstaging'],
    ['a NUL', 'prod\u0000'],
    ['a C1 control', 'prod\u0085x'],
    ['a line separator', 'prod\u2028x'],
    ['a right-to-left override', 'prod\u202Egnigats'],
    ['a bidirectional isolate', 'prod\u2066x\u2069'],
  ])('refuses %s', (_label, raw) => {
    expect(checkInstanceName(raw)).toEqual({ ok: false, problem: 'control-character' });
  });

  it('keeps markup as plain text: it is a label, escaped where it is rendered', () => {
    expect(checkInstanceName('<b>prod</b> & "eu"')).toEqual({
      ok: true,
      name: '<b>prod</b> & "eu"',
    });
  });
});
