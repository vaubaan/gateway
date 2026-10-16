import { describe, expect, it } from 'vitest';

import { ConnectError, isConnectError } from '../connections';
import { isShareError, SHARE_ERROR_CODES, SHARE_ERROR_MESSAGES, ShareError } from './errors';

/**
 * The same class as another module graph would define it: a page is bundled
 * apart from the code that built the composition root, so what it catches is
 * not an instance of the class it imports.
 */
function fromAnotherGraph(name: string, code: string): Error {
  class Twin extends Error {
    readonly code = code;
    constructor() {
      super(code);
      this.name = name;
    }
  }
  return new Twin();
}

describe('errors recognised by shape, for the pages', () => {
  it('recognises a ShareError by its name and code, whichever copy of the class threw it', () => {
    expect(isShareError(new ShareError('not-found'), 'not-found')).toBe(true);
    const twin = fromAnotherGraph('ShareError', 'not-found');
    expect(twin instanceof ShareError).toBe(false);
    expect(isShareError(twin, 'not-found')).toBe(true);
  });

  it('answers false for another code, another error, or a value that is not an error', () => {
    expect(isShareError(new ShareError('risk-unknown', 'x'), 'not-found')).toBe(false);
    expect(isShareError(fromAnotherGraph('ConnectError', 'not-found'), 'not-found')).toBe(false);
    expect(isShareError(new Error('not-found'), 'not-found')).toBe(false);
    expect(isShareError({ name: 'ShareError', code: 'not-found' }, 'not-found')).toBe(false);
    expect(isShareError(null, 'not-found')).toBe(false);
  });

  it('does the same for a ConnectError', () => {
    expect(isConnectError(new ConnectError('not-found'), 'not-found')).toBe(true);
    expect(isConnectError(fromAnotherGraph('ConnectError', 'not-found'), 'not-found')).toBe(true);
    expect(isConnectError(new ConnectError('connection-revoked'), 'not-found')).toBe(false);
    expect(isConnectError(fromAnotherGraph('ShareError', 'not-found'), 'not-found')).toBe(false);
    // Without a code: any ConnectError, and nothing else.
    expect(isConnectError(fromAnotherGraph('ConnectError', 'rate-limited'))).toBe(true);
    expect(isConnectError(new Error('ConnectError'))).toBe(false);
  });

  it('has a sentence and a status for every code', () => {
    for (const code of SHARE_ERROR_CODES) {
      expect(SHARE_ERROR_MESSAGES[code].length).toBeGreaterThan(10);
      const status = new ShareError(code).status;
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
    }
    expect(new ShareError('risk-unknown', 'a, b').message).toBe('risk-unknown: a, b');
  });
});
