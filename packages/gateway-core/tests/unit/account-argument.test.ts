/**
 * `vaubaan_account` (spec §4.1 "Call"): the door takes it out of the arguments
 * before the pipeline, so no plugin ever sees it.
 */
import { describe, expect, test } from 'vitest';

import { ACCOUNT_ARGUMENT, splitAccountArgument } from '../../src/index.ts';

describe('splitAccountArgument', () => {
  test('takes the named account out of the arguments', () => {
    expect(splitAccountArgument({ space: 'alpha', [ACCOUNT_ARGUMENT]: ' Depot B ' })).toEqual({
      args: { space: 'alpha' },
      account: 'Depot B',
    });
  });

  test('leaves arguments without it as they are', () => {
    const args = { space: 'alpha' };
    expect(splitAccountArgument(args)).toEqual({ args });
  });

  test('drops an empty or non-string value without naming an account', () => {
    expect(splitAccountArgument({ [ACCOUNT_ARGUMENT]: '  ' })).toEqual({ args: {} });
    expect(splitAccountArgument({ [ACCOUNT_ARGUMENT]: 7, q: 1 })).toEqual({ args: { q: 1 } });
  });
});
