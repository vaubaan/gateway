import { describe, expect, it } from 'vitest';

import { describeArgument, guardConsole } from './console-guard';
import { createRedactor } from './redact';

const SECRET = 'configured-secret-value-0123456789';

describe('console guard: what Next.js prints goes through the redactor, error messages withheld', () => {
  it('prints an error as its class and frames, never its message', () => {
    const err = new Error(`upstream said ${SECRET}`);
    const text = String(describeArgument(err));
    expect(text).toMatch(/^Error: \[message withheld\]/);
    expect(text).toContain('at ');
    expect(text).not.toContain(SECRET);
  });

  it('keeps the digest Next.js shows to the browser', () => {
    const err = Object.assign(new Error('x'), { digest: '12345' });
    expect(String(describeArgument(err))).toContain('(digest 12345)');
  });

  it('replaces error and warn, redacts strings, installs once', () => {
    const printed: string[] = [];
    const target = {
      error: (...args: unknown[]) => printed.push(args.join(' ')),
      warn: (...args: unknown[]) => printed.push(args.join(' ')),
    };
    const redact = createRedactor([SECRET]);
    guardConsole(redact, target);
    guardConsole(redact, target);
    target.error('⨯', new TypeError(SECRET));
    target.warn(`config ${SECRET}`, { n: 1 });
    expect(printed).toHaveLength(2);
    expect(printed[0]).toMatch(/^⨯ TypeError: \[message withheld\]/);
    expect(printed[1]).toBe('config [redacted] { n: 1 }');
    expect(printed.join('\n')).not.toContain(SECRET);
  });
});
